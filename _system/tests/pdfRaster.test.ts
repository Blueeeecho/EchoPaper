import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfRasterSize } from '../src/pdfRaster.ts';

test('PDF preview supersamples normal and Retina displays', () => {
  assert.equal(pdfRasterSize(720, 932, 1).pixelWidth, 1440);
  assert.equal(pdfRasterSize(720, 932, 2).pixelWidth, 2160);
  assert.equal(pdfRasterSize(720, 932, 3).pixelWidth, 2486);
  assert.equal(pdfRasterSize(720, 932, NaN).pixelWidth, 1440);
});
test('zoomed PDF canvases stay within pixel and dimension budgets', () => {
  for (const [width, height] of [[2160, 2795], [50000, 50], [200, 259]]) {
    const result = pdfRasterSize(width, height, 4);
    assert.ok(result.pixelWidth * result.pixelHeight <= 8_000_000);
    assert.ok(Math.max(result.pixelWidth, result.pixelHeight) <= 16384);
    assert.equal(result.scaleX, result.pixelWidth / width);
    assert.equal(result.scaleY, result.pixelHeight / height);
  }
});
