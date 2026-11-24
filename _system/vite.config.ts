import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// PDF.js needs local character maps for CJK documents and fonts for legacy PDFs.
// Populate public/ from the locked dependency for both dev and production builds.
const localPdfAssets = {
  name: 'local-pdf-assets',
  async configResolved() {
    const pkgPath = fileURLToPath(new URL('./node_modules/pdfjs-dist/package.json', import.meta.url));
    const outRoot = fileURLToPath(new URL('./public/pdfjs', import.meta.url));
    const stampFile = path.join(outRoot, '.version');
    const version = JSON.parse(await fs.readFile(pkgPath, 'utf8')).version;
    const dirs = ['cmaps', 'standard_fonts', 'wasm'];
    const current = await fs.readFile(stampFile, 'utf8').catch(() => '');
    const intact = current.trim() === version && (await Promise.all(dirs.map(d => fs.stat(path.join(outRoot, d)).then(s => s.isDirectory()).catch(() => false)))).every(Boolean);
    if (intact) return;
    for (const directory of dirs) {
      const source = fileURLToPath(new URL(`./node_modules/pdfjs-dist/${directory}`, import.meta.url));
      const output = path.join(outRoot, directory);
      await fs.mkdir(output, { recursive: true });
      await fs.cp(source, output, { recursive: true });
    }
    await fs.writeFile(stampFile, `${version}\n`);
  },
};
function resolveBackendPort(): number {
  try {
    const instance = JSON.parse(readFileSync(fileURLToPath(new URL('./runtime/instance.json', import.meta.url)), 'utf8'));
    if (Number.isInteger(instance?.port) && instance.port >= 1024 && instance.port <= 65535) return instance.port;
  } catch { /* Fall back to WORKBENCH_PORT or default 4173. */ }
  const envPort = Number(process.env.WORKBENCH_PORT);
  return Number.isInteger(envPort) && envPort >= 1024 && envPort <= 65535 ? envPort : 4173;
}
export default defineConfig({ plugins: [localPdfAssets, react()], build: { outDir: 'dist' }, server: { proxy: { '/api': `http://127.0.0.1:${resolveBackendPort()}` } } });
