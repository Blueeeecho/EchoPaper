import {test} from 'node:test';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {build} from 'esbuild';import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {defaultAgentDefinitions,DEFAULT_AGENT_LIMITS} from '../shared/agent-types';
const compiled=await build({entryPoints:[fileURLToPath(new URL('../src/components/AssistantSettingsEditor.tsx',import.meta.url))],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.css':'empty'},jsx:'automatic'});
const mod={exports:{} as any};new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports);
function render(roles=defaultAgentDefinitions()){return renderToStaticMarkup(createElement(mod.exports.default,{config:{models:[],providers:[]},value:{roles,modelIds:[],defaultModelId:null,limits:DEFAULT_AGENT_LIMITS},onChange(){},onError(){}}));}
test('default compatibility roles form one closed group; enabled custom legacy IDs stay visible',()=>{
 const html=render(),index=html.indexOf('<details class="assistant-compatibility">');assert.ok(index>0);assert.ok(html.includes('兼容角色（4）'));assert.equal((html.slice(0,index).match(/<details class="assistant-role">/g)||[]).length,4);assert.equal((html.slice(index).match(/<details class="assistant-role">/g)||[]).length,4);assert.ok(html.includes('论文审稿人'));
 const roles=defaultAgentDefinitions();Object.assign(roles.find(r=>r.id==='polisher')!,{enabled:true,name:'我的定制润色'});const custom=render(roles);assert.ok(custom.indexOf('我的定制润色')<custom.indexOf('assistant-compatibility'));assert.ok(custom.includes('兼容角色（3）'));
 const checkbox=html.match(/<input[^>]*aria-label="论文审稿人 工具 验收审阅"[^>]*>/)?.[0];assert.ok(checkbox?.includes('disabled=""'));assert.ok(!checkbox?.includes('checked=""'));
});
