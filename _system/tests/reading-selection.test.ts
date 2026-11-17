import test from 'node:test';
import assert from 'node:assert/strict';
import {readingSelectionText} from '../src/academic/readingSelection';
test('source selection, explicit clearing, and note selection preserve distinct transitions',()=>{
 const inside={} as Node,outside={} as Node;
 const source={contains:(node:Node|null)=>node===inside};
 const selection=(anchorNode:Node,focusNode:Node,text:string,rangeCount=1)=>({anchorNode,focusNode,rangeCount,toString:()=>text}) as Selection;
 assert.equal(readingSelectionText(selection(inside,inside,' source '),source),'source');
 assert.equal(readingSelectionText(selection(inside,inside,''),source),'');
 assert.equal(readingSelectionText(selection(outside,outside,'note'),source),undefined);
 assert.equal(readingSelectionText(selection(inside,outside,'mixed'),source),undefined);
 assert.equal(readingSelectionText(selection(outside,outside,'',0),source),'');
 assert.equal(readingSelectionText(null,source),'');
 assert.equal(readingSelectionText(selection(inside,inside,'x'.repeat(6100)),source)?.length,6000);
});
