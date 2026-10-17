import { DitherEngine } from './dither.js';

// Configuration for Production Site
const CONFIG = {
  totalFrames: 110,
  frameRate: 11, // 11 fps matching sequence extraction
  crossfadeWindow: 8, // 8-frame seamless loop crossfade
  framePathPattern: (idx) => `frames/${String(idx).padStart(3, '0')}.webp`,
  theme: {
    ground: '#f5ede2', // Warm desert / beach sand
    ink: '#261e18'     // Deep charcoal / obsidian ink
  }
};

class SandmagicSite {
  constructor() {
    this.canvas = document.getElementById('ditherCanvas');
    if (!this.canvas) return;

    // Initialize Hardware-Accelerated WebGL/GLSL Dither Engine
    this.engine = new DitherEngine({
      pixelSize: 10,
      spacing: 0.35,
      dotScale: 0.85,
      levels: 4,
      contrast: 26,
      brightness: -2,
      invert: true,
      bgFloor: 0.02,
      colorMode: 'blended',
      colorMix: 0.25,
      shape: 'circle',
      warpMode: 'twist',
      warpStrength: 9.0,
      groundColor: CONFIG.theme.ground,
      inkColor: CONFIG.theme.ink
    });

    this.frames = [];
    this.currentFrameIdx = 0;
    this.isHeroVisible = true;
    this.lastFrameTime = performance.now();
    this.frameIntervalMs = 1000 / CONFIG.frameRate;

    this.initHeroIntersection();
    this.resizeCanvas();
    this.bindEvents();
    this.loadFramesProgressively();
    this.startAnimationLoop();
    this.initProjectEstimator();
    this.initSmoothScroll();
    this.initViewTransitions();
  }

  getMaxAvailableFrame() {
    let count = 0;
    while (count < CONFIG.totalFrames && this.frames[count]) {
      count++;
    }
    return count;
  }

  initHeroIntersection() {
    const hero = document.getElementById('hero');
    if (!hero) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        this.isHeroVisible = entry.isIntersecting;
      });
    }, { threshold: 0.05 });

    observer.observe(hero);
  }

  resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;

    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;

    this.dpr = dpr;
    this.renderCurrentFrame();
  }

  async loadFramesProgressively() {
    const total = CONFIG.totalFrames;

    // 1. Instant First Frame: 50KB WebP loads in < 50ms
    try {
      const firstImg = await this.loadImage(1);
      this.frames[0] = firstImg;
      this.renderCurrentFrame();
    } catch (e) {
      console.warn('Initial frame load:', e);
    }

    // 2. Sequential Ordered Background Loading (prevents out-of-order jitter)
    const concurrency = 4;
    let nextIdx = 2;

    const worker = async () => {
      while (nextIdx <= total) {
        const idx = nextIdx++;
        try {
          const img = await this.loadImage(idx);
          this.frames[idx - 1] = img;
        } catch (err) {
          // silently continue
        }
      }
    };

    const pool = Array.from({ length: concurrency }, () => worker());
    await Promise.all(pool);
  }

  loadImage(frameNumber) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.src = CONFIG.framePathPattern(frameNumber);
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(e);
    });
  }

  bindEvents() {
    window.addEventListener('resize', () => this.resizeCanvas());

    // Pointer warp tracking across hero container
    const updatePointer = (clientX, clientY, active) => {
      if (!this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const dpr = this.dpr || 1;
      const x = (clientX - rect.left) * dpr;
      const y = (clientY - rect.top) * dpr;
      this.engine.setPointer(x, y, active);
    };

    window.addEventListener('mousemove', (e) => {
      if (this.isHeroVisible) {
        updatePointer(e.clientX, e.clientY, true);
      }
    }, { passive: true });

    window.addEventListener('mouseleave', () => {
      this.engine.setPointer(-9999, -9999, false);
    });

    window.addEventListener('touchstart', (e) => {
      if (e.touches.length > 0 && this.isHeroVisible) {
        updatePointer(e.touches[0].clientX, e.touches[0].clientY, true);
      }
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (e.touches.length > 0 && this.isHeroVisible) {
        updatePointer(e.touches[0].clientX, e.touches[0].clientY, true);
      }
    }, { passive: true });

    window.addEventListener('touchend', () => {
      this.engine.setPointer(-9999, -9999, false);
    });
  }

  startAnimationLoop() {
    const loop = (timestamp) => {
      if (this.isHeroVisible && this.frames[0]) {
        // Step sequence frame on 11 FPS timer
        const elapsed = timestamp - this.lastFrameTime;
        if (elapsed >= this.frameIntervalMs) {
          this.lastFrameTime = timestamp - (elapsed % this.frameIntervalMs);

          const maxContiguous = this.getMaxAvailableFrame();
          if (maxContiguous >= CONFIG.totalFrames) {
            this.currentFrameIdx = (this.currentFrameIdx + 1) % CONFIG.totalFrames;
          } else if (maxContiguous > 1) {
            this.currentFrameIdx = (this.currentFrameIdx + 1) % maxContiguous;
          }
        }

        // Render WebGL shader at 60+ FPS for buttery-smooth mouse tracking
        this.renderCurrentFrame();
      }

      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
  }

  renderCurrentFrame() {
    const frame = this.frames[this.currentFrameIdx] || this.frames[0];
    if (!frame) return;

    let crossfadeFrame = null;
    let crossfadeAlpha = 0.0;

    // Seamless 8-frame crossfade wrap
    const maxContiguous = this.getMaxAvailableFrame();
    if (maxContiguous >= CONFIG.totalFrames) {
      const fadeStart = CONFIG.totalFrames - CONFIG.crossfadeWindow;
      if (this.currentFrameIdx >= fadeStart) {
        const offset = this.currentFrameIdx - fadeStart;
        crossfadeAlpha = (offset + 1) / (CONFIG.crossfadeWindow + 1);
        crossfadeFrame = this.frames[offset] || this.frames[0];
      }
    }

    this.engine.renderFrame(
      this.canvas,
      this.canvas.width,
      this.canvas.height,
      frame,
      crossfadeFrame,
      crossfadeAlpha
    );
  }

  initViewTransitions() {
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a');
      if (!link) return;
      const href = link.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || link.target === '_blank') return;
      if (link.origin !== window.location.origin) return;

      if (document.startViewTransition) {
        e.preventDefault();
        document.startViewTransition(() => {
          window.location.href = href;
        });
      }
    });
  }

  initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
      anchor.addEventListener('click', function (e) {
        const targetId = this.getAttribute('href');
        if (targetId === '#') return;
        const targetEl = document.querySelector(targetId);
        if (targetEl) {
          e.preventDefault();
          targetEl.scrollIntoView({ behavior: 'smooth' });
        }
      });
    });
  }

  initProjectEstimator() {
    const scaleSlider = document.getElementById('estScale');
    const scaleVal = document.getElementById('estScaleVal');
    const typeSelect = document.getElementById('estType');
    const outWindow = document.getElementById('calcWindow');
    const outTeam = document.getElementById('calcTeam');
    const outDrone = document.getElementById('calcDrone');

    if (!scaleSlider || !typeSelect) return;

    const recalculate = () => {
      const meters = parseInt(scaleSlider.value, 10);
      scaleVal.textContent = `${meters} meters`;

      let hours = Math.round((meters / 100) * 1.8 + 2.5);
      if (hours > 6) hours = 6;
      outWindow.textContent = `${hours}h low-tide window`;

      let teamSize = Math.max(2, Math.round(meters / 60));
      if (typeSelect.value === 'executive') {
        teamSize = `${teamSize * 3}–${teamSize * 5} participants`;
      } else {
        teamSize = `${teamSize} land artists`;
      }
      outTeam.textContent = teamSize;

      outDrone.textContent = meters > 250 ? 'Dual 8K Cine Drones' : 'Single 4K Cine Drone';
    };

    scaleSlider.addEventListener('input', recalculate);
    typeSelect.addEventListener('change', recalculate);
    recalculate();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new SandmagicSite();
});
