import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import type {ResearchTopic,SourceRoot,Resource,FileOperation} from '../../shared/workspace-types.ts';
import type {ConferenceTimeline} from '../../shared/conference-timeline.ts';
import {atomicWrite} from '../storage.ts';
import {assertNoSymlinks,HttpError} from '../security.ts';

export interface IndexedResource extends Resource {text?:string}
export interface JournalOperation extends FileOperation {
  phase?:'prepared'|'copying'|'copied'|'applied'|'undoing';
  beforeHash?:string;
  afterHash?:string;
  records?:IndexedResource[];
  appliedRevisions?:Record<string,number>;
  createdFileIdentity?:{device:string;inode:string};
  recoveryFileIdentity?:{device:string;inode:string};
}
export interface CatalogState {version:1;topics:ResearchTopic[];roots:SourceRoot[];resources:IndexedResource[];operations:JournalOperation[];conferenceTimeline:ConferenceTimeline}
interface Statement {get(...args:unknown[]):unknown;run(...args:unknown[]):unknown}
interface Database {exec(sql:string):void;prepare(sql:string):Statement;close():void;pragma(sql:string):unknown}
const empty=():CatalogState=>({version:1,topics:[],roots:[],resources:[],operations:[],conferenceTimeline:{revision:0,conferences:[]}});

/** The catalog contains metadata and extracted search text, never original files. */
export async function openCatalog(workspaceRoot:string){
  const folder=await assertNoSymlinks(workspaceRoot,'workspace',true);await fs.mkdir(folder,{recursive:true,mode:0o700});await assertNoSymlinks(workspaceRoot,'workspace');
  const sqlite=await assertNoSymlinks(workspaceRoot,'workspace/catalog.sqlite',true),json=await assertNoSymlinks(workspaceRoot,'workspace/catalog.json',true);
  let db:Database|undefined;
  try{const Constructor=createRequire(import.meta.url)('better-sqlite3') as new(filename:string)=>Database;db=new Constructor(sqlite);}
  catch(error){
    // A damaged existing database must never silently become an empty catalog.
    if(await fs.lstat(sqlite).then(()=>true).catch(()=>false))throw error;
    const message=String((error as Error).message);if(!/module|bindings|NODE_MODULE_VERSION|dlopen|shared object/i.test(message))throw error;
  }
  let state:CatalogState,lastSaved:string|undefined;
  if(db){db.pragma('journal_mode = DELETE');db.pragma('synchronous = FULL');db.exec('CREATE TABLE IF NOT EXISTS catalog (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)');const row=db.prepare('SELECT payload FROM catalog WHERE id=1').get() as {payload:string}|undefined;state=row?JSON.parse(row.payload):empty();lastSaved=row?.payload;await fs.chmod(sqlite,0o600);}
  else{try{state=JSON.parse(await fs.readFile(json,'utf8'));lastSaved=JSON.stringify(state);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;state=empty();}}
  if(state?.version!==1||!['topics','roots','resources','operations'].every(key=>Array.isArray(state[key as keyof CatalogState])))throw new HttpError(409,'工作区目录索引格式无效，请保留 catalog 文件并检查。');
  if(state.conferenceTimeline===undefined)state.conferenceTimeline={revision:0,conferences:[]};
  if(!state.conferenceTimeline||!Number.isSafeInteger(state.conferenceTimeline.revision)||state.conferenceTimeline.revision<0||!Array.isArray(state.conferenceTimeline.conferences))throw new HttpError(409,'会议时间线格式无效，请保留 catalog 文件并检查。');
  return {state,async save(){const payload=JSON.stringify(state);if(payload===lastSaved)return;if(db)db.prepare('INSERT INTO catalog (id,payload) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(payload);else{await assertNoSymlinks(workspaceRoot,'workspace/catalog.json',true);await atomicWrite(json,payload+'\n');await fs.chmod(json,0o600);}lastSaved=payload;},checkpoint(){/* DELETE journaling commits each save; no WAL or optimization writes. */},close(){db?.close();}};
}
