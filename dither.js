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

    // Pinned percentiles (eliminates frame pulsing)
    this.pinnedP2 = 0.02;
    this.pinnedP98 = 0.98;
    this.isPinned = false;

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
    this.bayerTexture = null;
    this.sourceTexture = null;
    this.crossfadeTexture = null;
    this.dummyTexture = null;
    this.quadBuffer = null;
    this.isInitialized = false;
    this.fallbackEngine = null;
    this.startTime = performance.now();
  }

  initWebGL(canvas) {
    if (this.isInitialized && this.gl && this.gl.canvas === canvas) return true;

    try {
      const gl = canvas.getContext('webgl', {
        alpha: false,
        depth: false,
        stencil: false,
        antialias: true,
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
      this.initBayerTexture();
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
      'u_image', 'u_crossfadeImage', 'u_crossfadeAlpha', 'u_bayerTexture',
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

  initBayerTexture() {
    const gl = this.gl;
    // 8x8 Bayer matrix values normalized to [0, 255]
    const bayerValues = new Uint8Array([
       0, 32,  8, 40,  2, 34, 10, 42,
      48, 16, 56, 24, 50, 18, 58, 26,
      12, 44,  4, 36, 14, 46,  6, 38,
      60, 28, 52, 20, 62, 30, 54, 22,
       3, 35, 11, 43,  1, 33,  9, 41,
      51, 19, 59, 27, 49, 17, 57, 25,
      15, 47,  7, 39, 13, 45,  5, 37,
      63, 31, 55, 23, 61, 29, 53, 21
    ].map(v => Math.round((v / 64) * 255)));

    this.bayerTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.bayerTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 8, 8, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, bayerValues);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
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
      this.pointer.x += (-9999 - this.pointer.x) * 0.1;
      this.pointer.y += (-9999 - this.pointer.y) * 0.1;
      return;
    }
    this.pointer.x += (this.pointer.targetX - this.pointer.x) * 0.2;
    this.pointer.y += (this.pointer.targetY - this.pointer.y) * 0.2;
    this.pointer.phase += 0.05;
  }

  computeAndPinLevels(imgElement) {
    // Quick downscaled histogram sample
    try {
      const off = document.createElement('canvas');
      off.width = 120;
      off.height = 68;
      const ctx = off.getContext('2d');
      ctx.drawImage(imgElement, 0, 0, 120, 68);
      const data = ctx.getImageData(0, 0, 120, 68).data;

      const hist = new Int32Array(256);
      const totalPixels = 120 * 68;
      for (let i = 0; i < data.length; i += 4) {
        const lum = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
        hist[Math.max(0, Math.min(255, lum))]++;
      }

      const lowCut = totalPixels * 0.02;
      const highCut = totalPixels * 0.98;
      let count = 0, p2 = 0.02, p98 = 0.98, foundLow = false;

      for (let b = 0; b < 256; b++) {
        count += hist[b];
        if (!foundLow && count >= lowCut) {
          p2 = b / 255.0;
          foundLow = true;
        }
        if (count >= highCut) {
          p98 = b / 255.0;
          break;
        }
      }
      if (p98 <= p2) p98 = p2 + 0.05;
      this.pinnedP2 = p2;
      this.pinnedP98 = p98;
      this.isPinned = true;
      this.telemetry.pinnedP2 = p2;
      this.telemetry.pinnedP98 = p98;
    } catch {
      this.pinnedP2 = 0.02;
      this.pinnedP98 = 0.98;
      this.isPinned = true;
    }
  }

  resetPinnedLevels() {
    this.isPinned = false;
    this.pinnedP2 = 0.02;
    this.pinnedP98 = 0.98;
  }

  /**
   * Main Render Call
   */
  renderFrame(canvasOrCtx, targetWidth, targetHeight, sourceImg, crossfadeImg = null, crossfadeAlpha = 0.0) {
    const t0 = performance.now();
    this.updatePointerSpring();

    const canvas = canvasOrCtx.canvas || canvasOrCtx;
    if (!this.initWebGL(canvas)) {
      // 2D fallback if WebGL fails
      this.renderFallback2D(canvas, targetWidth, targetHeight, sourceImg);
      return;
    }

    const gl = this.gl;
    gl.viewport(0, 0, targetWidth, targetHeight);
    gl.useProgram(this.program);

    if (!this.isPinned && sourceImg) {
      this.computeAndPinLevels(sourceImg);
    }

    // Bind current source image/video to Texture 0
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    if (sourceImg) {
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceImg);
      } catch (err) {
        // Continue if frame is not ready
      }
    }
    gl.uniform1i(this.uniforms.u_image, 0);

    // Bind crossfade image to Texture 1
    gl.activeTexture(gl.TEXTURE1);
    if (crossfadeImg && crossfadeAlpha > 0.001) {
      gl.bindTexture(gl.TEXTURE_2D, this.crossfadeTexture);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, crossfadeImg);
      } catch {}
      gl.uniform1f(this.uniforms.u_crossfadeAlpha, crossfadeAlpha);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.dummyTexture);
      gl.uniform1f(this.uniforms.u_crossfadeAlpha, 0.0);
    }
    gl.uniform1i(this.uniforms.u_crossfadeImage, 1);

    // Bind Bayer matrix to Texture 2
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.bayerTexture);
    gl.uniform1i(this.uniforms.u_bayerTexture, 2);

    // Pass Uniforms
    gl.uniform2f(this.uniforms.u_resolution, targetWidth, targetHeight);

    const srcW = sourceImg?.videoWidth || sourceImg?.naturalWidth || sourceImg?.width || 700;
    const srcH = sourceImg?.videoHeight || sourceImg?.naturalHeight || sourceImg?.height || 394;
    gl.uniform2f(this.uniforms.u_sourceResolution, srcW, srcH);

    // Crop border parameters [x, y, w, h]
    gl.uniform4f(this.uniforms.u_cropRect, 0.0, 0.0, 1.0, 1.0);

    gl.uniform1f(this.uniforms.u_pixelSize, Math.max(4.0, this.pixelSize));
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
