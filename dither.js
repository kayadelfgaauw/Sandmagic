/**
 * Hardware-Accelerated WebGL/GLSL Bayer Ordered Dither Engine
 * Rec. 709 Luma, Pinned Histogram Percentiles, 8x8 Bayer Matrix,
 * Dynamic GPU Mouse Warping, and Vector Dot Rendering.
 */

import vertShaderSource from './shaders/dither.vert';
import fragShaderSource from './shaders/dither.frag';

export class DitherEngine {
  constructor(options = {}) {
    this.pixelSize = options.pixelSize ?? 10;
    this.spacing = options.spacing ?? 0.35;
    this.dotScale = options.dotScale ?? 0.85;
    this.levels = options.levels ?? 4;
    this.contrast = options.contrast ?? 26;
    this.brightness = options.brightness ?? -2;
    this.invert = options.invert ?? true;
    this.bgFloor = options.bgFloor ?? 0.02;
    this.colorMode = options.colorMode ?? 'blended'; // 'duotone', 'blended', 'sampled'
    this.colorMix = options.colorMix ?? 0.25;
    this.shape = options.shape ?? 'circle';
    this.warpMode = options.warpMode ?? 'twist'; // 'twist', 'lean', 'scatter', 'none'
    this.warpStrength = options.warpStrength ?? 9.0;

    this.groundColor = options.groundColor ?? '#f5ede2';
    this.inkColor = options.inkColor ?? '#261e18';

    // Calibrated pinned percentiles from sand sequence (eliminates flicker completely)
    this.pinnedP2 = 0.0863;
    this.pinnedP98 = 0.7412;
    this.isPinned = true;

    // Pointer warp state
    this.pointer = {
      x: -9999,
      y: -9999,
      targetX: -9999,
      targetY: -9999,
      active: false,
      phase: 0
    };

    // Telemetry
    this.telemetry = {
      gpuAccelerated: true,
      renderTimeMs: 0,
      fps: 60,
      pinnedP2: this.pinnedP2,
      pinnedP98: this.pinnedP98
    };

    // WebGL state
    this.gl = null;
    this.program = null;
    this.uniforms = {};
    this.sourceTexture = null;
    this.crossfadeTexture = null;
    this.dummyTexture = null;
    this.lastSourceImg = null;
    this.lastCrossfadeImg = null;
    this.quadBuffer = null;
    this.isInitialized = false;
    this.startTime = performance.now();
  }

  initWebGL(canvas) {
    if (this.isInitialized && this.gl && this.gl.canvas === canvas) return true;

    try {
      const gl = canvas.getContext('webgl', {
        alpha: false,
        depth: false,
        stencil: false,
        antialias: false, // fragment shader anti-aliases circles via smoothstep
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false
      }) || canvas.getContext('experimental-webgl');

      if (!gl) {
        console.warn('WebGL unavailable, falling back to 2D canvas.');
        this.telemetry.gpuAccelerated = false;
        return false;
      }

      this.gl = gl;
      this.initShaders();
      this.initGeometry();
      this.initDummyTexture();

      this.sourceTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      this.crossfadeTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.crossfadeTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      this.isInitialized = true;
      this.telemetry.gpuAccelerated = true;
      return true;
    } catch (err) {
      console.error('Failed to init WebGL:', err);
      this.telemetry.gpuAccelerated = false;
      return false;
    }
  }

  createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('Shader compile failed: ' + info);
    }
    return shader;
  }

  initShaders() {
    const gl = this.gl;
    const vs = this.createShader(gl, gl.VERTEX_SHADER, vertShaderSource);
    const fs = this.createShader(gl, gl.FRAGMENT_SHADER, fragShaderSource);

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(program));
    }

    this.program = program;
    gl.useProgram(program);

    // Cache uniform locations
    const uniformNames = [
      'u_image', 'u_crossfadeImage', 'u_crossfadeAlpha',
      'u_resolution', 'u_sourceResolution', 'u_cropRect', 'u_pixelSize',
      'u_spacing', 'u_dotScale', 'u_levels', 'u_contrast', 'u_brightness',
      'u_invert', 'u_bgFloor', 'u_pinnedP2', 'u_pinnedP98', 'u_groundColor',
      'u_inkColor', 'u_colorMode', 'u_colorMix', 'u_pointer', 'u_pointerActive',
      'u_warpMode', 'u_warpStrength', 'u_time'
    ];

    this.uniforms = {};
    for (const name of uniformNames) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }

    this.attribPosition = gl.getAttribLocation(program, 'a_position');
  }

  initGeometry() {
    const gl = this.gl;
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);

    // Full screen quad (-1 to 1)
    const vertices = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  }

  initDummyTexture() {
    const gl = this.gl;
    this.dummyTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTexture);
    const white = new Uint8Array([255, 255, 255, 255]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, white);
  }

  hexToRgbNorm(hex) {
    let clean = hex.replace('#', '');
    if (clean.length === 3) clean = clean.split('').map(c => c + c).join('');
    const num = parseInt(clean, 16);
    return [
      ((num >> 16) & 255) / 255.0,
      ((num >> 8) & 255) / 255.0,
      (num & 255) / 255.0
    ];
  }

  setPointer(x, y, active = true) {
    this.pointer.targetX = x;
    this.pointer.targetY = y;
    this.pointer.active = active;
    if (this.pointer.x < -1000) {
      this.pointer.x = x;
      this.pointer.y = y;
    }
  }

  updatePointerSpring() {
    if (!this.pointer.active) {
      this.pointer.x += (-9999 - this.pointer.x) * 0.15;
      this.pointer.y += (-9999 - this.pointer.y) * 0.15;
      return;
    }
    // Smooth responsive spring
    this.pointer.x += (this.pointer.targetX - this.pointer.x) * 0.25;
    this.pointer.y += (this.pointer.targetY - this.pointer.y) * 0.25;
    this.pointer.phase += 0.05;
  }

  /**
   * Main Render Call (Runs at 60+ FPS)
   */
  renderFrame(canvasOrCtx, targetWidth, targetHeight, sourceImg, crossfadeImg = null, crossfadeAlpha = 0.0) {
    const t0 = performance.now();
    this.updatePointerSpring();

    const canvas = canvasOrCtx.canvas || canvasOrCtx;
    if (!this.initWebGL(canvas)) {
      this.renderFallback2D(canvas, targetWidth, targetHeight, sourceImg);
      return;
    }

    const gl = this.gl;
    gl.viewport(0, 0, targetWidth, targetHeight);
    gl.useProgram(this.program);

    // Bind current source image only when it changed (huge performance boost!)
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    if (sourceImg && sourceImg !== this.lastSourceImg) {
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceImg);
        this.lastSourceImg = sourceImg;
      } catch (err) {}
    }
    gl.uniform1i(this.uniforms.u_image, 0);

    // Bind crossfade image to Texture 1
    gl.activeTexture(gl.TEXTURE1);
    if (crossfadeImg && crossfadeAlpha > 0.001) {
      gl.bindTexture(gl.TEXTURE_2D, this.crossfadeTexture);
      if (crossfadeImg !== this.lastCrossfadeImg) {
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, crossfadeImg);
          this.lastCrossfadeImg = crossfadeImg;
        } catch {}
      }
      gl.uniform1f(this.uniforms.u_crossfadeAlpha, crossfadeAlpha);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.dummyTexture);
      gl.uniform1f(this.uniforms.u_crossfadeAlpha, 0.0);
    }
    gl.uniform1i(this.uniforms.u_crossfadeImage, 1);

    // Viewport resolution
    gl.uniform2f(this.uniforms.u_resolution, targetWidth, targetHeight);

    const srcW = sourceImg?.videoWidth || sourceImg?.naturalWidth || sourceImg?.width || 700;
    const srcH = sourceImg?.videoHeight || sourceImg?.naturalHeight || sourceImg?.height || 394;
    gl.uniform2f(this.uniforms.u_sourceResolution, srcW, srcH);

    // Border crop
    gl.uniform4f(this.uniforms.u_cropRect, 0.0, 0.0, 1.0, 1.0);

    // Grid sizing scaled by devicePixelRatio for consistent crisp dots
    const dpr = window.devicePixelRatio || 1;
    gl.uniform1f(this.uniforms.u_pixelSize, Math.max(4.0, this.pixelSize * dpr));
    gl.uniform1f(this.uniforms.u_spacing, this.spacing);
    gl.uniform1f(this.uniforms.u_dotScale, this.dotScale);
    gl.uniform1f(this.uniforms.u_levels, Math.max(2.0, this.levels));
    gl.uniform1f(this.uniforms.u_contrast, this.contrast);
    gl.uniform1f(this.uniforms.u_brightness, this.brightness);
    gl.uniform1f(this.uniforms.u_invert, this.invert ? 1.0 : 0.0);
    gl.uniform1f(this.uniforms.u_bgFloor, this.bgFloor);
    gl.uniform1f(this.uniforms.u_pinnedP2, this.pinnedP2);
    gl.uniform1f(this.uniforms.u_pinnedP98, this.pinnedP98);

    const ground = this.hexToRgbNorm(this.groundColor);
    const ink = this.hexToRgbNorm(this.inkColor);
    gl.uniform3f(this.uniforms.u_groundColor, ground[0], ground[1], ground[2]);
    gl.uniform3f(this.uniforms.u_inkColor, ink[0], ink[1], ink[2]);

    const colorModeMap = { duotone: 0, blended: 1, sampled: 2 };
    gl.uniform1i(this.uniforms.u_colorMode, colorModeMap[this.colorMode] ?? 1);
    gl.uniform1f(this.uniforms.u_colorMix, this.colorMix);

    // Pointer uniforms (in WebGL screen coordinates)
    const isPointerActive = this.pointer.x > -1000 && this.pointer.active;
    gl.uniform2f(this.uniforms.u_pointer, this.pointer.x, targetHeight - this.pointer.y);
    gl.uniform1f(this.uniforms.u_pointerActive, isPointerActive ? 1.0 : 0.0);

    const warpMap = { twist: 0, lean: 1, scatter: 2, none: 3 };
    gl.uniform1i(this.uniforms.u_warpMode, warpMap[this.warpMode] ?? 0);
    gl.uniform1f(this.uniforms.u_warpStrength, this.warpStrength);

    const elapsed = (performance.now() - this.startTime) / 1000.0;
    gl.uniform1f(this.uniforms.u_time, elapsed);

    // Draw full-screen quad
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.attribPosition);
    gl.vertexAttribPointer(this.attribPosition, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const renderTime = performance.now() - t0;
    this.telemetry.renderTimeMs = renderTime;
  }

  renderFallback2D(canvas, width, height, sourceImg) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = this.groundColor;
    ctx.fillRect(0, 0, width, height);
    if (sourceImg) {
      ctx.drawImage(sourceImg, 0, 0, width, height);
    }
  }
}
