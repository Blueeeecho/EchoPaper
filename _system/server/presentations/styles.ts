import fs from 'node:fs/promises';
import path from 'node:path';
import type { StylePack } from '../../shared/presentation-types';
import { assertNoSymlinks, HttpError, projectId } from '../security';
import { hash } from '../storage';

export interface ResolvedStyle { style:StylePack; directory:string; template:string; manifestHash:string; preview:string; logo:string; logoOriginal:string }
export async function listStyles(workspaceRoot:string):Promise<StylePack[]> {
 const root=await assertNoSymlinks(workspaceRoot,'shared/presentation-styles',true);const ids=await fs.readdir(root,{withFileTypes:true}).catch(()=>[]);const styles:StylePack[]=[];
 for(const entry of ids.filter(e=>e.isDirectory()&&!e.name.startsWith('.'))){const versions=await fs.readdir(await assertNoSymlinks(root,entry.name),{withFileTypes:true});for(const version of versions.filter(v=>v.isDirectory()&&/^\d+\.\d+\.\d+$/.test(v.name)))styles.push((await resolveStyle(workspaceRoot,entry.name,version.name)).style);}
 return styles;
}
const styleAssets = new Set(['logo.png', 'logo.svg', 'preview.png', 'cover.jpeg']);
type FrameAsset = 'cover.jpeg' | 'logo.svg';

/** Capture the decoration directly from the full style validation, without rereading or base64-encoding unused assets. */
export async function readPreviewFrame(workspaceRoot:string,id:string,version:string,kind:'cover'|'contents'|'thanks'|'body'){
 const name=kind==='contents'?undefined:kind==='cover'?'cover.jpeg':'logo.svg';
 const {frameAsset}=await resolveStyle(workspaceRoot,id,version,name);
 if(!name||!frameAsset)return {};
 const data='data:'+(name==='cover.jpeg'?'image/jpeg':'image/svg+xml')+';base64,'+frameAsset.toString('base64');
 return name==='cover.jpeg'?{cover:data}:{logo:data};
}
export async function resolveStyle(workspaceRoot:string,id:string,version:string,capture?:FrameAsset):Promise<ResolvedStyle & {frameAsset?:Buffer}>{
 projectId(id);if(!/^\d+\.\d+\.\d+$/.test(version))throw new HttpError(400,'样式版本无效。');
 const directory=await assertNoSymlinks(workspaceRoot,`shared/presentation-styles/${id}/${version}`),manifestFile=await assertNoSymlinks(directory,'manifest.json'),raw=await fs.readFile(manifestFile,'utf8'),manifest=JSON.parse(raw);
 if(manifest.id!==id||manifest.version!==version||typeof manifest.englishFont!=='string'||typeof manifest.chineseFont!=='string'||!Array.isArray(manifest.navigation))throw new HttpError(409,'样式包清单无效。');
 if(id==='hzau-clean'&&(manifest.englishFont!=='Times New Roman'||manifest.chineseFont!=='隶书'||JSON.stringify(manifest.navigation)!==JSON.stringify(['研究背景','研究内容','研究结果','未来计划'])))throw new HttpError(409,'HZAU 样式包字体或固定导航约束不匹配。');
 const template=await assertNoSymlinks(directory,'template.pptx');if(hash(await fs.readFile(template))!==manifest.templateHash)throw new HttpError(409,'样式模板与版本化清单哈希不符，请保留原文件并检查。');
 let frameAsset:Buffer|undefined;
 for(const [name,digest]of Object.entries(manifest.assetHashes??{})){
  if(!styleAssets.has(name))throw new HttpError(409,'样式资源与版本化清单哈希不符。');
  const bytes=await fs.readFile(await assertNoSymlinks(directory,name));
  if(hash(bytes)!==digest)throw new HttpError(409,'样式资源与版本化清单哈希不符。');
  if(name===capture)frameAsset=bytes;
 }
 if(capture&&!frameAsset)frameAsset=await fs.readFile(await assertNoSymlinks(directory,capture));
 const {template:_template,preview:_preview,logo:_logo,provenance:_provenance,assetHashes:_assetHashes,...style}=manifest;
 return{style,directory,template,manifestHash:hash(raw),preview:await assertNoSymlinks(directory,'preview.png'),logo:await assertNoSymlinks(directory,'logo.svg'),logoOriginal:await assertNoSymlinks(directory,'logo.png'),...(frameAsset?{frameAsset}:{})};
}
