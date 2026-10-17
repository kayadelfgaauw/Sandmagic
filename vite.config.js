import { resolve } from 'path';
import { defineConfig } from 'vite';

// Inline lightweight plugin to import .vert, .frag, and .glsl files as string modules
function glslPlugin() {
  return {
    name: 'vite-plugin-glsl-inline',
    transform(code, id) {
      if (id.endsWith('.glsl') || id.endsWith('.frag') || id.endsWith('.vert')) {
        return {
          code: `export default ${JSON.stringify(code)};`,
          map: null
        };
      }
    }
  };
}

export default defineConfig({
  plugins: [glslPlugin()],
  publicDir: 'public',
  build: {
    outDir: 'dist',
    target: 'es2020',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        about: resolve(import.meta.dirname, 'about.html'),
        projects: resolve(import.meta.dirname, 'projects.html'),
        contact: resolve(import.meta.dirname, 'contact.html'),
        guide: resolve(import.meta.dirname, 'guide.html'),
        guide_sub: resolve(import.meta.dirname, 'guide/index.html')
      }
    }
  }
});
