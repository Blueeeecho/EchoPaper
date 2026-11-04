import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCompiler } from '../server/compile-utils.ts';
import { localResourceBundle, missingCachedResource } from '../server/local-resource-bundle.ts';

async function fixture(content='OK') {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'echopaper-local-bundle-test-')),cache=path.join(root,'cache'),digest='a'.repeat(64),source=path.join(root,'source'),compiler=path.join(root,'tectonic'),calls=path.join(root,'calls.jsonl'),mirror=path.join(root,'mirror');
 await fs.mkdir(path.join(cache,'hashes'),{recursive:true});await fs.mkdir(path.join(cache,'data',digest),{recursive:true});await fs.mkdir(source);
 await fs.writeFile(path.join(cache,'hashes','default_bundle_v33.tar'),digest+'\n');await fs.writeFile(path.join(cache,'data',digest,'cached.sty'),'cached resource');await fs.writeFile(path.join(source,'main.tex'),content);
 await fs.writeFile(compiler,`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
if(args.includes('--version')){console.log('Tectonic 0.16.9');process.exit(0);}
if(args[0]==='-X'&&args[1]==='show'){console.log(${JSON.stringify(cache)});process.exit(0);}
const local=args.includes('--bundle'),output=args[args.indexOf('--outdir')+1],text=fs.readFileSync(args.at(-1),'utf8');
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({local,untrusted:args.includes('--untrusted'),partial:fs.existsSync(path.join(output,'partial.pdf'))})+'\\n');
fs.mkdirSync(output,{recursive:true});console.log('note: Running TeX ...');
const missing=()=>{fs.writeFileSync(path.join(output,'partial.pdf'),'%PDF-partial');fs.writeFileSync(path.join(output,'main.log'),'first-attempt error');console.error("error: main.tex:1: LaTeX Error: File 'new-package.sty' not found.");process.exit(1);};
const success=()=>{fs.writeFileSync(path.join(output,'main.pdf'),'%PDF-1.4 '+text);fs.writeFileSync(path.join(output,'main.log'),'final clean log');console.log('final-success');};
if(text==='CANCEL'){console.log('waiting-for-cancel');setInterval(()=>{},1000);}
else if(text==='SYNTAX'){console.error('error: Undefined control sequence');process.exit(1);}
else if(text==='TIMEOUT'){setTimeout(local?missing:success,160);}
else if(local&&text==='MISSING')missing();else success();
`,{mode:0o755});
 const options={compiler,cwd:source,output:path.join(root,'artifacts'),main:'main.tex',timeoutMs:3000,resourceMirrorRoot:mirror};
 return {root,cache,digest,source,compiler,calls,mirror,options,readCalls:async()=>{try{return(await fs.readFile(calls,'utf8')).trim().split('\n').map(s=>JSON.parse(s));}catch{return[];}},cleanup:()=>fs.rm(root,{recursive:true,force:true})};
}

test('warm resource mirror retypesets changed source and preserves untrusted mode, rather than reusing a PDF',async()=>{
 const f=await fixture();try{
  await fs.writeFile(path.join(f.cache,'data',f.digest,'.tex'),'');
  assert.equal((await runCompiler(f.options)).code,0);
  assert.equal(await fs.readFile(path.join(f.mirror,f.digest,'SHA256SUM'),'utf8'),f.digest+'\n');
  assert.equal(await fs.readFile(path.join(f.mirror,f.digest,'cached.sty'),'utf8'),'cached resource');
  await fs.writeFile(path.join(f.source,'main.tex'),'CHANGED SOURCE');
  assert.equal((await runCompiler(f.options)).code,0);
  assert.match(await fs.readFile(path.join(f.options.output,'main.pdf'),'utf8'),/CHANGED SOURCE/);
  assert.deepEqual((await f.readCalls()).map(c=>({local:c.local,untrusted:c.untrusted})),[{local:true,untrusted:true},{local:true,untrusted:true}]);
 }finally{await f.cleanup();}
});
test('definite missing package retries online, removes partial artifacts, and keeps only final attempt diagnostics',async()=>{
 const f=await fixture('MISSING');try{
  let stream='';const result=await runCompiler({...f.options,onOutput:s=>stream+=s});
  assert.equal(result.code,0);assert.match(result.log,/final-success/);assert.doesNotMatch(result.log,/not found/);
  assert.match(result.fullLog!,/not found/);assert.match(stream,/retrying with the standard network bundle/);
  assert.deepEqual((await f.readCalls()).map(c=>({local:c.local,partial:c.partial})),[{local:true,partial:false},{local:false,partial:false}]);
  assert.equal(await fs.readFile(path.join(f.options.output,'main.log'),'utf8'),'final clean log');
 }finally{await f.cleanup();}
});
test('source syntax errors do not repeat compilation or fall back to the network',async()=>{
 const f=await fixture('SYNTAX');try{const result=await runCompiler(f.options);assert.equal(result.code,1);assert.match(result.log,/Undefined control/);assert.equal((await f.readCalls()).length,1);}finally{await f.cleanup();}
});
test('cancellation of local compilation never starts an online fallback',async()=>{
 const f=await fixture('CANCEL');try{
  const controller=new AbortController();const result=await runCompiler({...f.options,signal:controller.signal,onOutput:s=>{if(s.includes('waiting-for-cancel'))controller.abort();}});
  assert.notEqual(result.code,0);assert.equal((await f.readCalls()).length,1);assert.match(result.log,/已取消/);
 }finally{await f.cleanup();}
});
test('local and online attempts share one timeout budget',async()=>{
 const f=await fixture('TIMEOUT');try{
  const at=Date.now(),result=await runCompiler({...f.options,timeoutMs:360});
  assert.equal(result.timedOut,true);assert.ok(Date.now()-at<650);assert.ok((await f.readCalls()).length<=2);
 }finally{await f.cleanup();}
});
test('unknown engine versions, ambiguous cached bundles and symlink resources bypass optional adaptation',async()=>{
 const f=await fixture();try{
  const options={compiler:f.compiler,mirrorRoot:f.mirror,deadline:Date.now()+5000};
  await fs.writeFile(path.join(f.cache,'hashes','another_bundle'),f.digest);
  assert.equal(await localResourceBundle(options),undefined);await fs.rm(path.join(f.cache,'hashes','another_bundle'));
  await fs.symlink(path.join(f.source,'main.tex'),path.join(f.cache,'data',f.digest,'linked.sty'));
  assert.equal(await localResourceBundle(options),undefined);await fs.rm(path.join(f.cache,'data',f.digest,'linked.sty'));
  await fs.writeFile(f.compiler,(await fs.readFile(f.compiler,'utf8')).replace('Tectonic 0.16.9','Tectonic 0.17.0'));
  assert.equal(await localResourceBundle(options),undefined);
  assert.equal((await runCompiler(f.options)).code,0);assert.equal((await f.readCalls())[0].local,false);
 }finally{await f.cleanup();}
});
test('resource miss classifier excludes user input files and TeX syntax errors',()=>{
 assert.equal(missingCachedResource("LaTeX Error: File `new-package.sty' not found."),true);
 assert.equal(missingCachedResource("I can't find file `tex/missing-section.tex'."),false);
 assert.equal(missingCachedResource('Undefined control sequence; font is not loadable'),false);
});
