import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const execute = promisify(execFile);
const defaultMirrorRoot = fileURLToPath(new URL('../runtime/tectonic-bundles/', import.meta.url));
export interface LocalResourceBundle { directory: string; digest: string }
interface Options { compiler: string; mirrorRoot?: string; signal?: AbortSignal; deadline: number }

/** Adapt the cache layout verified with the installed engine; unknown versions use its normal resolver. */
export async function localResourceBundle(options: Options): Promise<LocalResourceBundle | undefined> {
  const check=()=>{if(options.signal?.aborted)throw Error('cancelled');if(Date.now()>=options.deadline)throw Error('timeout');};
  const command=async(args:string[])=>{check();return execute(options.compiler,args,{signal:options.signal,timeout:Math.max(1,Math.min(2000,options.deadline-Date.now())),maxBuffer:8192});};
  const version=(await command(['--version'])).stdout.trim();
  // The directory layout and format serial are version specific. Never silently
  // reuse an older bundle after an engine upgrade or for a custom engine.
  if(version!=='Tectonic 0.16.9')return;
  const cache=(await command(['-X','show','user-cache-dir'])).stdout.trim();
  if(!path.isAbsolute(cache))return;
  const cacheRoot=await fs.realpath(cache),hashRoot=path.join(cacheRoot,'hashes');
  if(!(await fs.lstat(hashRoot)).isDirectory())return;
  const hashes=await fs.readdir(hashRoot,{withFileTypes:true});
  if(hashes.length!==1||!hashes[0].isFile()||!hashes[0].name.endsWith('default_bundle_v33.tar'))return;
  const digest=(await fs.readFile(path.join(hashRoot,hashes[0].name),'utf8')).trim();
  if(!/^[a-f0-9]{64}$/.test(digest))return;
  const source=path.join(cacheRoot,'data',digest);if(await fs.realpath(source)!==source)return;
  const entries=(await fs.readdir(source,{withFileTypes:true})).filter(entry=>!entry.name.startsWith('.'));
  if(entries.some(entry=>!entry.isFile()))return;
  const mirrorRoot=options.mirrorRoot??defaultMirrorRoot;await fs.mkdir(mirrorRoot,{recursive:true});
  const directory=path.join(await fs.realpath(mirrorRoot),digest);
  try{if(!(await fs.lstat(directory)).isDirectory())return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  await fs.mkdir(directory,{recursive:true});
  for(const entry of entries){
    check();if(entry.name==='SHA256SUM')continue;
    const original=path.join(source,entry.name),output=path.join(directory,entry.name),stat=await fs.stat(original);
    let present=false;try{const existing=await fs.lstat(output);present=existing.isFile()&&existing.size===stat.size&&Math.abs(existing.mtimeMs-stat.mtimeMs)<2;}catch{}
    if(!present){const temporary=output+'.'+randomUUID()+'.tmp';try{await fs.copyFile(original,temporary,constants.COPYFILE_FICLONE);await fs.utimes(temporary,stat.atime,stat.mtime);await fs.rename(temporary,output);}finally{await fs.rm(temporary,{force:true}).catch(()=>{});}}
  }
  // DirectoryBundle expects this digest entry. The value is the engine's cached
  // upstream bundle digest, so its already-validated format cache stays valid.
  check();const digestFile=path.join(directory,'SHA256SUM'),temporary=digestFile+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temporary,digest+'\n');await fs.rename(temporary,digestFile);}finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
  return {directory,digest};
}

/** Only definite resource misses warrant a network retry; TeX syntax failures do not. */
export function missingCachedResource(log: string): boolean {
  if(/Undefined control sequence|Runaway argument|Missing \$ inserted|Extra \}|unclosed open group/i.test(log))return false;
  return /(?:File|find file|open file|locate file)[^\n]*\.(?:sty|cls|clo|cfg|def|fd|ldf|map|enc|tfm|otf|ttf|pfb|fmt)[^\n]*(?:not found|can't find|cannot find|could not|unable)|(?:can't find|cannot find|could not (?:open|locate))[^\n]*\.(?:sty|cls|clo|cfg|def|fd|ldf|map|enc|tfm|otf|ttf|pfb|fmt)|font[^\n]*(?:not found|not loadable)|(?:cannot|could not|failed to) (?:find|load|locate)[^\n]*format|bundle does not provide needed SHA256SUM/i.test(log);
}
