import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
test('toolbar separates placeholders from compile errors',async()=>{const s=await fs.readFile('src/App.tsx','utf8');assert.match(s,/const errors=diagnosticCounts.error\+diagnosticCounts.reference,/);assert.match(s,/项待补内容/);});
test('historical message and stopped reason retain provenance labels',async()=>{const s=await fs.readFile('src/components/AiPanel.tsx','utf8'),p=await fs.readFile('src/components/AgentTaskPanel.tsx','utf8');assert.match(s,/当时回复（保留原文）/);assert.match(s,/当时中断原因/);assert.match(p,/run.continuedBy \|\| !display.active/);});
test('translation result has no duplicate source section',async()=>{const s=await fs.readFile('src/components/SelectionTranslation.tsx','utf8');assert.doesNotMatch(s,/translation-original/);assert.match(s,/text:selection.text/);});
