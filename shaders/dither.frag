#ifdef GL_ES
precision highp float;
#endif

varying vec2 v_uv;

// Textures
uniform sampler2D u_image;
uniform sampler2D u_crossfadeImage;
uniform float u_crossfadeAlpha;
uniform sampler2D u_bayerTexture;

// Viewport & Grid parameters
uniform vec2 u_resolution;         // Canvas width and height in device pixels
uniform vec2 u_sourceResolution;   // Source image dimensions (e.g. 700, 394)
uniform vec4 u_cropRect;           // Crop [x, y, w, h] to strip baked-in borders
uniform float u_pixelSize;         // Cell size in device pixels (e.g. 10.0 * dpr)
uniform float u_spacing;           // Gap spacing ratio (0.35)
uniform float u_dotScale;          // Dot scale (0.85)

// Tonal quantization parameters
uniform float u_levels;            // Tone levels (4.0)
uniform float u_contrast;          // Linear contrast (-100 to 100, default 26)
uniform float u_brightness;        // Brightness offset (-100 to 100, default -2)
uniform float u_invert;            // 1.0 = invert (dark mandala subject on light ground)
uniform float u_bgFloor;           // Noise threshold to clamp to zero (0.02)
uniform float u_pinnedP2;          // 2nd percentile luma (pinned)
uniform float u_pinnedP98;         // 98th percentile luma (pinned)

// Theming & Colors
uniform vec3 u_groundColor;        // Warm sand background
uniform vec3 u_inkColor;           // Deep obsidian ink
uniform int u_colorMode;           // 0: duotone, 1: blended, 2: sampled
uniform float u_colorMix;          // Mix factor towards ink (0.25)

// Dynamic Mouse Warping
uniform vec2 u_pointer;            // Cursor position in device pixels
uniform float u_pointerActive;     // 1.0 when active, 0.0 when idle
uniform int u_warpMode;            // 0: twist, 1: lean, 2: scatter, 3: none
uniform float u_warpStrength;      // Warp magnitude (9.0)
uniform float u_time;              // Elapsed time in seconds

void main() {
  vec2 pixelCoord = gl_FragCoord.xy;
  vec2 cellCoord = floor(pixelCoord / u_pixelSize);
  vec2 cellCenter = (cellCoord + 0.5) * u_pixelSize;
  float distToCenter = length(pixelCoord - cellCenter);

  // Apply dynamic mouse displacement in cell grid units
  vec2 sampleCellCoord = cellCoord;
  if (u_pointerActive > 0.5 && u_warpStrength > 0.0 && u_warpMode < 3) {
    vec2 pGrid = u_pointer / u_pixelSize;
    vec2 delta = cellCoord - pGrid;
    float dist = length(delta);
    float warpRadiusGrid = (0.6 * max(u_resolution.x, u_resolution.y)) / u_pixelSize;
    if (dist < warpRadiusGrid && dist > 0.001) {
      float s = 1.0 - (dist / warpRadiusGrid);
      float falloff = s * s * (3.0 - 2.0 * s); // smoothstep curve

      if (u_warpMode == 0) { // Twist
        float angle = atan(delta.y, delta.x);
        sampleCellCoord.x -= sin(angle) * u_warpStrength * falloff;
        sampleCellCoord.y += cos(angle) * u_warpStrength * falloff;
      } else if (u_warpMode == 1) { // Lean
        sampleCellCoord.x += u_warpStrength * falloff;
        sampleCellCoord.y -= 0.3 * u_warpStrength * falloff;
      } else if (u_warpMode == 2) { // Scatter
        sampleCellCoord.x += sin(cellCoord.x * 0.35 + u_time) * u_warpStrength * falloff;
        sampleCellCoord.y += cos(cellCoord.y * 0.35 + u_time) * u_warpStrength * falloff;
      }
    }
  }

  // Normalized UV coordinates for cell (y inverted for WebGL screen coordinates)
  vec2 totalCells = u_resolution / u_pixelSize;
  vec2 uv = vec2(sampleCellCoord.x / totalCells.x, 1.0 - (sampleCellCoord.y / totalCells.y));

  // Aspect-cover texture mapping
  float targetAspect = u_resolution.x / u_resolution.y;
  float srcAspect = u_sourceResolution.x / max(1.0, u_sourceResolution.y);
  vec2 sampleUV = uv;
  if (srcAspect > targetAspect) {
    float scale = targetAspect / srcAspect;
    sampleUV.x = (sampleUV.x - 0.5) * scale + 0.5;
  } else {
    float scale = srcAspect / targetAspect;
    sampleUV.y = (sampleUV.y - 0.5) * scale + 0.5;
  }

  // Border cropping
  sampleUV = clamp(sampleUV * u_cropRect.zw + u_cropRect.xy, 0.0, 1.0);

  // Sample texture with crossfade support
  vec4 rawColor = texture2D(u_image, sampleUV);
  if (u_crossfadeAlpha > 0.001) {
    vec4 crossColor = texture2D(u_crossfadeImage, sampleUV);
    rawColor = mix(rawColor, crossColor, clamp(u_crossfadeAlpha, 0.0, 1.0));
  }

  // Rec. 709 HDTV Luminance calculation
  float luma = dot(rawColor.rgb, vec3(0.2126, 0.7152, 0.0722));

  // Pinned histogram percentile normalization
  float pRange = max(0.01, u_pinnedP98 - u_pinnedP2);
  float norm = clamp((luma - u_pinnedP2) / pRange, 0.0, 1.0);

  // Brightness and contrast adjustment
  norm = norm + (u_brightness / 100.0);
  float cFactor = 1.0 + (u_contrast / 50.0);
  norm = clamp(0.5 + (norm - 0.5) * cFactor, 0.0, 1.0);

  // Dark subject on light sand ground inversion
  if (u_invert > 0.5) {
    norm = 1.0 - norm;
  }

  // Noise floor suppression
  if (norm < u_bgFloor) {
    norm = 0.0;
  }

  // 8x8 Bayer Ordered Dither lookup
  vec2 bayerUV = (mod(cellCoord, 8.0) + 0.5) / 8.0;
  float threshold = texture2D(u_bayerTexture, bayerUV).r;

  float N = max(2.0, u_levels);
  float v = norm * (N - 1.0);
  float baseVal = floor(v);
  float fracVal = v - baseVal;
  float level = (fracVal > threshold) ? min(N - 1.0, baseVal + 1.0) : baseVal;

  // Dot geometric dimensioning & anti-aliased edge
  float spacingFraction = clamp(u_spacing, 0.05, 0.8);
  float effectiveCell = u_pixelSize * (1.0 - spacingFraction);
  float maxRadius = (effectiveCell * 0.5) * clamp(u_dotScale, 0.2, 1.2);

  float tone = level / (N - 1.0);
  float rad = max(0.5, maxRadius * sqrt(tone));

  float dotAlpha = 0.0;
  if (level > 0.0) {
    dotAlpha = smoothstep(rad + 0.75, rad - 0.75, distToCenter);
  }

  // Color blending mode
  vec3 dotColor = u_inkColor;
  if (u_colorMode == 1) { // Blended
    dotColor = mix(rawColor.rgb, u_inkColor, clamp(u_colorMix, 0.0, 1.0));
  } else if (u_colorMode == 2) { // Sampled
    dotColor = rawColor.rgb;
  }

  vec3 finalColor = mix(u_groundColor, dotColor, dotAlpha);
  gl_FragColor = vec4(finalColor, 1.0);
}
