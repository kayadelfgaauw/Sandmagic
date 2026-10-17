# SANDMAGIC — Bayer Ordered Dither Engine

Real-time animated Bayer ordered dither engine built for monumental sand mandala art, implemented with HTML5 Canvas 2D and Rec. 709 luma quantization.

## Architecture & Principles

### 1. Frame Extraction & Cleaning
- **Source Video:** `Video/gemini_generated_video_4885ad27.mp4`
- **Rate:** Extracted at **11 FPS** (coarse grid dither does not benefit from 24 FPS, saving bandwidth and memory).
- **Border Cropping:** Cropped with `iw*0.84:ih*0.84:iw*0.08:ih*0.08,scale=1400:-2` to strip the baked-in parchment border.
- **Noise Floor Suppression:** Snaps residual sand/codec grain within a threshold of the ground to zero (`bgFloor = 0.02`), preventing stray dot haze.

### 2. Dither Pipeline (`dither.js`)
1. **Downscaled Offscreen Buffer:** The source frame is rendered into a small buffer sized exactly to `cols × rows` (`cols = ceil(W / pixelSize)`). All image processing occurs on this tiny grid (~20,000 pixels), ensuring sub-3ms frame times.
2. **Rec. 709 Luma:** Converted using standard HDTV Rec. 709 weights:
   $$\text{Luma} = 0.2126 R + 0.7152 G + 0.0722 B$$
3. **Pinned Auto-Levels:** Evaluates the 2nd ($P_2$) and 98th ($P_{98}$) percentiles of the luma histogram on sequence initialization and **pins them across all frames**, eliminating dot density pulsing.
4. **Contrast & Brightness:** Linear contrast curve and brightness offset before quantization.
5. **Invert Flag (Dark on Light Subject):** Because the sand art pattern consists of dark carvings on a light sand beach, `invert = true` maps dark ink to high tone levels and light sand to 0.
6. **Floor Clamping:** Clamps tones below `bgFloor` to 0.
7. **8×8 Bayer Ordered Quantization:** Built recursively from a $2 \times 2$ seed into $4 \times 4$ and $8 \times 8$. Quantizes normalized tone into $N$ discrete levels ($N \in [2, 6]$).
8. **Batch Bucketing:** In Duotone mode, dots are batched by tone level into single path `fill()` calls (~3–5 calls per frame). In Blended/Sampled mode, dots are bucketed by quantized color keys to minimize `fillStyle` mutations.

### 3. Animation & 8-Frame Looping Crossfade
Natural sand motifs lack exact seams. Over the final 8 frames ($K-8$ through $K-1$), the engine blends opening frames with rising alpha:
$$\alpha = \frac{i - (K - 8) + 1}{9}$$
This dissolves the sequence into its start without visible jump cuts.

### 4. Pointer Interaction
- Displaces **sampling coordinates** rather than drawn output, costing zero additional draw passes.
- Wide field radius (60% of canvas) with cubic smoothstep falloff:
  - **Rotational Twist:** Tangential displacement around cursor tailored for radial mandalas.
  - **Directional Lean:** Wind-swept horizontal shift.
  - **Gentle Scatter:** High-frequency organic micro-turbulence.

### 5. Running the Application
Serve the directory with any local static HTTP server:

```bash
# Using Python 3
python3 -m http.server 8080

# Or using Node / npx
npx serve .
```

Open `http://localhost:8080` in any modern web browser.
