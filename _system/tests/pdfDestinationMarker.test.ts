import test from 'node:test';
import assert from 'node:assert/strict';
import { clipPdfMarker, pdfDestinationMarker } from '../src/pdfDestinationMarker.ts';

test('citation destination surrounds its rendered line without spanning the adjacent column or next reference', () => {
  const result = pdfDestinationMarker({x:.093,y:.43}, [
    {x:.07,y:.416,width:.1,height:.014},
    {x:.07,y:.432,width:.018,height:.009}, {x:.105,y:.432,width:.35,height:.009},
    {x:.53,y:.432,width:.39,height:.009}, {x:.105,y:.445,width:.35,height:.009},
  ]);
  assert.ok(result.x < .07 && result.x + result.width >= .455);
  assert.ok(result.x + result.width < .5, 'must stop before the column gutter');
  assert.ok(result.y + result.height < .445, 'must not cover the next line');
});
test('right-column destinations and headings use actual rendered widths', () => {
  const rows=[{x:.07,y:.3,width:.38,height:.012},{x:.53,y:.3,width:.3,height:.012}];
  const result=pdfDestinationMarker({x:.53,y:.299},rows);
  assert.ok(result.x > .5); assert.ok(result.x + result.width < .84);
  const heading=pdfDestinationMarker({x:0,y:.2},[{x:.1,y:.2,width:.19,height:.02}]);
  assert.ok(heading.width < .2);
});
test('blank destinations use a small bounded marker; invalid or out-of-page text boxes cannot expand it', () => {
  const result=pdfDestinationMarker({x:.99,y:.995},[{x:.1,y:.1,width:.4,height:.01},{x:NaN,y:0,width:1,height:1}]);
  assert.ok(result.width <= .02 && result.height <= .02);
  assert.ok(result.x+result.width <= 1 && result.y+result.height <= 1);
  assert.deepEqual(clipPdfMarker({x:.98,y:.99,width:.1,height:.1}),{x:.98,y:.99,width:1-.98,height:1-.99});
  assert.equal(clipPdfMarker({x:2,y:0,width:1,height:1}),undefined);
});
