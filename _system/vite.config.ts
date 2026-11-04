import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// PDF.js needs local character maps for CJK documents and fonts for legacy PDFs.
// Populate public/ from the locked dependency for both dev and production builds.
const localPdfAssets = {
  name: 'local-pdf-assets',
  async configResolved() {
    for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
      const source = fileURLToPath(new URL(`./node_modules/pdfjs-dist/${directory}`, import.meta.url));
      const output = fileURLToPath(new URL(`./public/pdfjs/${directory}`, import.meta.url));
      await fs.mkdir(output, { recursive: true });
      await fs.cp(source, output, { recursive: true });
    }
  },
};
export default defineConfig({ plugins: [localPdfAssets, react()], build: { outDir: 'dist' }, server: { proxy: { '/api': 'http://127.0.0.1:4173' } } });
