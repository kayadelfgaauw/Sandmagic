/**
 * Bayer Ordered Dither Engine
 * Rec. 709 Luma, Pinned Histogram Percentiles, 8x8 Bayer Matrix,
 * Vector/Circle Bucketing, and Sampling Coordinate Warping.
 */

export class DitherEngine {
  constructor(options = {}) {
    this.pixelSize = options.pixelSize ?? 10;
    this.spacing = options.spacing ?? 0.35;
    this.dotScale = options.dotScale ?? 0.85;
    this.levels = options.levels ?? 4;
    this.contrast = options.contrast ?? 26;
    this.brightness = options.brightness ?? -2;
    this.invert = options.invert ?? true; // True for dark subject on light ground
    this.bgFloor = options.bgFloor ?? 0.02; // Clamp noise floor to zero
    this.colorMode = options.colorMode ?? 'blended'; // 'sampled', 'duotone', 'blended'
    this.colorMix = options.colorMix ?? 0.25; // Blend ratio toward scheme ink
    this.shape = options.shape ?? 'circle'; // 'circle' or 'square'
    this.warpMode = options.warpMode ?? 'twist'; // 'twist', 'lean', 'scatter', 'none'
    this.warpStrength = options.warpStrength ?? 8.0;

    // Palette / Scheme colors
    this.groundColor = options.groundColor ?? '#f2ece4'; // Sand background
    this.inkColor = options.inkColor ?? '#1a1612';       // Dark charcoal / obsidian ink

    // Bayer 8x8 matrix initialization
    this.bayer8x8 = this.generateBayerMatrix(8);
    this.bayerThresholds = this.normalizeBayer(this.bayer8x8);

    // Pinned auto-level percentiles (pinned across sequence)
    this.pinnedP2 = null;
    this.pinnedP98 = null;
    this.isPinned = false;

    // Internal offscreen buffer
    if (typeof document !== 'undefined') {
      this.offscreenCanvas = document.createElement('canvas');
      this.offscreenCtx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true });
    } else {
      this.offscreenCanvas = null;
      this.offscreenCtx = null;
    }
    this.cols = 0;
    this.rows = 0;

    // Pointer warp state
    this.pointer = {
      x: -9999,
      y: -9999,
      targetX: -9999,
      targetY: -9999,
      active: false,
      phase: 0
    };

    // Diagnostics telemetry
    this.telemetry = {
      cols: 0,
      rows: 0,
      totalDots: 0,
      drawCalls: 0,
      pinnedP2: 0,
      pinnedP98: 0,
      renderTimeMs: 0
    };
  }

  /**
   * Recurse 2x2 Bayer into 4x4, then into 8x8
   */
  generateBayerMatrix(n) {
    if (n === 2) {
      return [
        [0, 2],
        [3, 1]
      ];
    }
    const half = this.generateBayerMatrix(n / 2);
    const size = half.length;
    const mat = Array.from({ length: n }, () => new Float32Array(n));
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const v = 4 * half[r][c];
        mat[r][c] = v;
        mat[r][c + size] = v + 2;
        mat[r + size][c] = v + 3;
        mat[r + size][c + size] = v + 1;
      }
    }
    return mat;
  }

  normalizeBayer(matrix) {
    const n = matrix.length;
    const total = n * n;
    const thresholds = Array.from({ length: n }, () => new Float32Array(n));
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        thresholds[r][c] = (matrix[r][c] + 0.5) / total;
      }
    }
    return thresholds;
  }

  /**
   * Rec. 709 Luma: 0.2126 R + 0.7152 G + 0.0722 B
   */
  getLuma(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /**
   * Compute 2nd and 98th percentiles of luma and pin them
   */
  computeAndPinLevels(imageData) {
    const data = imageData.data;
    const hist = new Int32Array(256);
    const totalPixels = data.length / 4;

    for (let i = 0; i < data.length; i += 4) {
      const lum = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
      const bin = Math.max(0, Math.min(255, lum));
      hist[bin]++;
    }

    const targetLow = totalPixels * 0.02;
    const targetHigh = totalPixels * 0.98;
    let count = 0;
    let p2 = 0;
    let p98 = 255;
    let foundLow = false;

    for (let b = 0; b < 256; b++) {
      count += hist[b];
      if (!foundLow && count >= targetLow) {
        p2 = b / 255.0;
        foundLow = true;
      }
      if (count >= targetHigh) {
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
  }

  resetPinnedLevels() {
    this.isPinned = false;
    this.pinnedP2 = null;
    this.pinnedP98 = null;
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
      // Return gently to off-screen
      this.pointer.x += (-9999 - this.pointer.x) * 0.1;
      this.pointer.y += (-9999 - this.pointer.y) * 0.1;
      return;
    }
    // Eased smoothing
    this.pointer.x += (this.pointer.targetX - this.pointer.x) * 0.18;
    this.pointer.y += (this.pointer.targetY - this.pointer.y) * 0.18;
    this.pointer.phase += 0.05;
  }

  /**
   * Helper to parse hex color to RGB object
   */
  hexToRgb(hex) {
    let clean = hex.replace('#', '');
    if (clean.length === 3) {
      clean = clean.split('').map(c => c + c).join('');
    }
    const num = parseInt(clean, 16);
    return {
      r: (num >> 16) & 255,
      g: (num >> 8) & 255,
      b: num & 255
    };
  }

  /**
   * Main render method
   * Takes source image/canvas, optional crossfade image & alpha, and renders to target canvas
   */
  renderFrame(ctx, targetWidth, targetHeight, sourceImg, crossfadeImg = null, crossfadeAlpha = 0.0) {
    const t0 = performance.now();
    this.updatePointerSpring();

    const pixelSize = Math.max(4, Math.round(this.pixelSize));
    const cols = Math.ceil(targetWidth / pixelSize);
    const rows = Math.ceil(targetHeight / pixelSize);

    this.cols = cols;
    this.rows = rows;
    this.telemetry.cols = cols;
    this.telemetry.rows = rows;

    if (this.offscreenCanvas.width !== cols || this.offscreenCanvas.height !== rows) {
      this.offscreenCanvas.width = cols;
      this.offscreenCanvas.height = rows;
    }

    const offCtx = this.offscreenCtx;
    offCtx.imageSmoothingEnabled = true;
    offCtx.imageSmoothingQuality = 'medium';
    offCtx.clearRect(0, 0, cols, rows);

    // Compute aspect-cover draw coordinates
    const srcW = sourceImg.naturalWidth || sourceImg.videoWidth || sourceImg.width || 1400;
    const srcH = sourceImg.naturalHeight || sourceImg.videoHeight || sourceImg.height || 788;
    const targetAspect = targetWidth / targetHeight;
    const srcAspect = srcW / srcH;

    let sx = 0, sy = 0, sw = srcW, sh = srcH;
    if (srcAspect > targetAspect) {
      // Source is wider than target: crop sides
      sw = srcH * targetAspect;
      sx = (srcW - sw) / 2;
    } else {
      // Source is taller than target: crop top/bottom
      sh = srcW / targetAspect;
      sy = (srcH - sh) / 2;
    }

    // 1. Draw source into downscaled offscreen buffer
    offCtx.globalAlpha = 1.0;
    offCtx.drawImage(sourceImg, sx, sy, sw, sh, 0, 0, cols, rows);

    // If looping crossfade is active, blend target frame on top
    if (crossfadeImg && crossfadeAlpha > 0.001) {
      offCtx.globalAlpha = Math.min(1.0, crossfadeAlpha);
      offCtx.drawImage(crossfadeImg, sx, sy, sw, sh, 0, 0, cols, rows);
      offCtx.globalAlpha = 1.0;
    }

    const imgData = offCtx.getImageData(0, 0, cols, rows);
    const rawPixels = imgData.data;

    // 3. Auto-level against 2nd & 98th percentiles (pinned)
    if (!this.isPinned || this.pinnedP2 === null) {
      this.computeAndPinLevels(imgData);
    }
    const p2 = this.pinnedP2;
    const p98 = this.pinnedP98;
    const pRange = Math.max(0.01, p98 - p2);

    // Precalculate brightness and contrast factor
    const bOffset = this.brightness / 100.0;
    const cFactor = 1.0 + (this.contrast / 50.0);

    // Precalculate dot sizing
    const spacingFraction = Math.min(0.8, Math.max(0.05, this.spacing));
    const effectiveCell = pixelSize * (1.0 - spacingFraction);
    const maxRadius = (effectiveCell / 2.0) * Math.min(1.2, Math.max(0.2, this.dotScale));

    const inkRgb = this.hexToRgb(this.inkColor);
    const N = Math.max(2, Math.min(8, Math.round(this.levels)));

    // Pointer warp parameters in buffer grid units
    const warpActive = this.warpMode !== 'none' && this.pointer.x > -1000;
    const pGridX = this.pointer.x / pixelSize;
    const pGridY = this.pointer.y / pixelSize;
    const warpRadiusGrid = (0.6 * Math.max(targetWidth, targetHeight)) / pixelSize;
    const warpStrength = this.warpStrength;

    // Clear background to ground color
    ctx.fillStyle = this.groundColor;
    ctx.fillRect(0, 0, targetWidth, targetHeight);

    let drawCalls = 0;
    let totalDots = 0;

    // Bucket rendering
    if (this.colorMode === 'duotone') {
      // Duotone: all dots share the same ink color!
      // Group by level bucket [1 .. N-1] for maximum canvas batching.
      const levelBuckets = Array.from({ length: N }, () => []);

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          let sc = c;
          let sr = r;

          // Displace sampling coordinates
          if (warpActive) {
            const dx = c - pGridX;
            const dy = r - pGridY;
            const dist = Math.hypot(dx, dy);
            if (dist < warpRadiusGrid) {
              const s = 1.0 - dist / warpRadiusGrid;
              const falloff = s * s * (3.0 - 2.0 * s); // smoothstep

              if (this.warpMode === 'twist') {
                const angle = Math.atan2(dy, dx);
                sc = c - Math.sin(angle) * warpStrength * falloff;
                sr = r + Math.cos(angle) * warpStrength * falloff;
              } else if (this.warpMode === 'lean') {
                sc = c + warpStrength * falloff;
                sr = r - 0.3 * warpStrength * falloff;
              } else if (this.warpMode === 'scatter') {
                sc = c + Math.sin(c * 0.35 + this.pointer.phase) * warpStrength * falloff;
                sr = r + Math.cos(r * 0.35 + this.pointer.phase) * warpStrength * falloff;
              }
            }
          }

          const ic = Math.max(0, Math.min(cols - 1, Math.round(sc)));
          const ir = Math.max(0, Math.min(rows - 1, Math.round(sr)));
          const idx = (ir * cols + ic) * 4;

          const red = rawPixels[idx];
          const green = rawPixels[idx + 1];
          const blue = rawPixels[idx + 2];

          // 2. Rec. 709 luma
          let luma = this.getLuma(red, green, blue) / 255.0;

          // 3. Pinned auto-levels
          let norm = Math.max(0.0, Math.min(1.0, (luma - p2) / pRange));

          // 4. Brightness & Contrast
          norm = norm + bOffset;
          norm = 0.5 + (norm - 0.5) * cFactor;
          norm = Math.max(0.0, Math.min(1.0, norm));

          // 5. Invert: dark subject on light background
          if (this.invert) {
            norm = 1.0 - norm;
          }

          // 6. Floor clamp
          if (norm < this.bgFloor) {
            norm = 0.0;
          }

          if (norm <= 0.001) continue;

          // 7. 8x8 Bayer Ordered Dither
          const threshold = this.bayerThresholds[r % 8][c % 8];
          const v = norm * (N - 1);
          const base = Math.floor(v);
          const frac = v - base;
          const level = (frac > threshold) ? Math.min(N - 1, base + 1) : base;

          if (level > 0) {
            levelBuckets[level].push(c * pixelSize + pixelSize * 0.5, r * pixelSize + pixelSize * 0.5);
            totalDots++;
          }
        }
      }

      ctx.fillStyle = this.inkColor;
      for (let k = 1; k < N; k++) {
        const coords = levelBuckets[k];
        if (coords.length === 0) continue;

        const tone = k / (N - 1);
        const rad = Math.max(0.5, maxRadius * Math.sqrt(tone));
        const sz = rad * 2;

        ctx.beginPath();
        drawCalls++;
        if (this.shape === 'square') {
          for (let i = 0; i < coords.length; i += 2) {
            ctx.rect(coords[i] - rad, coords[i + 1] - rad, sz, sz);
          }
        } else {
          for (let i = 0; i < coords.length; i += 2) {
            ctx.moveTo(coords[i] + rad, coords[i + 1]);
            ctx.arc(coords[i], coords[i + 1], rad, 0, Math.PI * 2);
          }
        }
        ctx.fill();
      }

    } else {
      // Sampled or Blended:
      // Group by (quantizedColorKey, level) to keep fillStyle changes minimal.
      const buckets = new Map();
      const mixRatio = Math.max(0.0, Math.min(1.0, this.colorMix));
      const isBlended = this.colorMode === 'blended';

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          let sc = c;
          let sr = r;

          if (warpActive) {
            const dx = c - pGridX;
            const dy = r - pGridY;
            const dist = Math.hypot(dx, dy);
            if (dist < warpRadiusGrid) {
              const s = 1.0 - dist / warpRadiusGrid;
              const falloff = s * s * (3.0 - 2.0 * s);

              if (this.warpMode === 'twist') {
                const angle = Math.atan2(dy, dx);
                sc = c - Math.sin(angle) * warpStrength * falloff;
                sr = r + Math.cos(angle) * warpStrength * falloff;
              } else if (this.warpMode === 'lean') {
                sc = c + warpStrength * falloff;
                sr = r - 0.3 * warpStrength * falloff;
              } else if (this.warpMode === 'scatter') {
                sc = c + Math.sin(c * 0.35 + this.pointer.phase) * warpStrength * falloff;
                sr = r + Math.cos(r * 0.35 + this.pointer.phase) * warpStrength * falloff;
              }
            }
          }

          const ic = Math.max(0, Math.min(cols - 1, Math.round(sc)));
          const ir = Math.max(0, Math.min(rows - 1, Math.round(sr)));
          const idx = (ir * cols + ic) * 4;

          const red = rawPixels[idx];
          const green = rawPixels[idx + 1];
          const blue = rawPixels[idx + 2];

          let luma = this.getLuma(red, green, blue) / 255.0;

          let norm = Math.max(0.0, Math.min(1.0, (luma - p2) / pRange));
          norm = norm + bOffset;
          norm = 0.5 + (norm - 0.5) * cFactor;
          norm = Math.max(0.0, Math.min(1.0, norm));

          if (this.invert) {
            norm = 1.0 - norm;
          }

          if (norm < this.bgFloor) {
            norm = 0.0;
          }

          if (norm <= 0.001) continue;

          const threshold = this.bayerThresholds[r % 8][c % 8];
          const v = norm * (N - 1);
          const base = Math.floor(v);
          const frac = v - base;
          const level = (frac > threshold) ? Math.min(N - 1, base + 1) : base;

          if (level > 0) {
            let finalR = red;
            let finalG = green;
            let finalB = blue;

            if (isBlended) {
              // Blend sampled toward scheme ink
              finalR = Math.round(inkRgb.r * (1.0 - mixRatio) + red * mixRatio);
              finalG = Math.round(inkRgb.g * (1.0 - mixRatio) + green * mixRatio);
              finalB = Math.round(inkRgb.b * (1.0 - mixRatio) + blue * mixRatio);
            }

            // Quantize color into coarse bins (5 bits: 32 levels per channel)
            const qr = (finalR >> 3) << 3;
            const qg = (finalG >> 3) << 3;
            const qb = (finalB >> 3) << 3;
            const key = `${qr},${qg},${qb}_${level}`;

            let bucket = buckets.get(key);
            if (!bucket) {
              bucket = {
                color: `rgb(${qr},${qg},${qb})`,
                level: level,
                coords: []
              };
              buckets.set(key, bucket);
            }
            bucket.coords.push(c * pixelSize + pixelSize * 0.5, r * pixelSize + pixelSize * 0.5);
            totalDots++;
          }
        }
      }

      for (const bucket of buckets.values()) {
        const coords = bucket.coords;
        if (coords.length === 0) continue;

        ctx.fillStyle = bucket.color;
        const tone = bucket.level / (N - 1);
        const rad = Math.max(0.5, maxRadius * Math.sqrt(tone));
        const sz = rad * 2;

        ctx.beginPath();
        drawCalls++;
        if (this.shape === 'square') {
          for (let i = 0; i < coords.length; i += 2) {
            ctx.rect(coords[i] - rad, coords[i + 1] - rad, sz, sz);
          }
        } else {
          for (let i = 0; i < coords.length; i += 2) {
            ctx.moveTo(coords[i] + rad, coords[i + 1]);
            ctx.arc(coords[i], coords[i + 1], rad, 0, Math.PI * 2);
          }
        }
        ctx.fill();
      }
    }

    const t1 = performance.now();
    this.telemetry.totalDots = totalDots;
    this.telemetry.drawCalls = drawCalls;
    this.telemetry.renderTimeMs = Math.round((t1 - t0) * 10) / 10;
  }
}
