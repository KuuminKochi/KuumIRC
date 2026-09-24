import { defineConfig } from 'vite';

export default defineConfig({
  base: '/draw/',
  build: { outDir: '../draw', emptyOutDir: true },
});
