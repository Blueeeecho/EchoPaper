import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import type {ResearchTopic,SourceRoot,Resource,FileOperation} from '../../shared/workspace-types.ts';
import type {ResearchNoteSection} from '../../shared/research-notes';
import type {ConferenceTimeline} from '../../shared/conference-timeline.ts';
import {atomicWrite} from '../storage.ts';
import {assertNoSymlinks,HttpError} from '../security.ts';

export interface IndexedResource extends Resource {text?:string}
export interface JournalOperation extends FileOperation {
  researchNote?:{topicId:string;section:ResearchNoteSection;noteId:string;name:string;legacyField?:'experimentPlan'|'resultSummary';legacyContent?:string};
  phase?:'prepared'|'copying'|'copied'|'applied'|'undoing';
  beforeHash?:string;
  afterHash?:string;
  records?:IndexedResource[];
  appliedRevisions?:Record<string,number>;
  createdFileIdentity?:{device:string;inode:string};
  recoveryFileIdentity?:{device:string;inode:string};
}
export interface CatalogState {version:1;topics:ResearchTopic[];roots:SourceRoot[];resources:IndexedResource[];operations:JournalOperation[];conferenceTimeline:ConferenceTimeline}
interface Statement {get(...args:unknown[]):unknown;all(...args:unknown[]):unknown[];run(...args:unknown[]):unknown}
interface Database {exec(sql:string):void;prepare(sql:string):Statement;transaction<T extends (...args:any[])=>any>(fn:T):T;close():void;pragma(sql:string,options?:{simple?:boolean}):unknown}

const empty=():CatalogState=>({version:1,topics:[],roots:[],resources:[],operations:[],conferenceTimeline:{revision:0,conferences:[]}});

function validateState(state:CatalogState){
  if(state?.version!==1||!['topics','roots','resources','operations'].every(key=>Array.isArray(state[key as keyof CatalogState]))){
    throw new HttpError(409,'工作区目录索引格式无效，请保留 catalog 文件并检查。');
  }
  if(state.conferenceTimeline===undefined)state.conferenceTimeline={revision:0,conferences:[]};
  if(!state.conferenceTimeline||!Number.isSafeInteger(state.conferenceTimeline.revision)||state.conferenceTimeline.revision<0||!Array.isArray(state.conferenceTimeline.conferences)){
    throw new HttpError(409,'会议时间线格式无效，请保留 catalog 文件并检查。');
  }
}

function stripText(resource:IndexedResource):Resource{
  if(!Object.hasOwn(resource,'text'))return resource;
  const {text:_text,...meta}=resource;
  return meta;
}

const SCHEMA_SQL=`
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS topics (id TEXT PRIMARY KEY, ord INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS roots (id TEXT PRIMARY KEY, ord INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS resources (id TEXT PRIMARY KEY, ord INTEGER NOT NULL, root_id TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS resource_text (id TEXT PRIMARY KEY, hash TEXT NOT NULL, text TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, ord INTEGER NOT NULL, data TEXT NOT NULL);
`;

/** The catalog stores metadata in normalized SQLite tables and keeps extracted search text out of RAM. */
export async function openCatalog(workspaceRoot:string){
  const folder=await assertNoSymlinks(workspaceRoot,'workspace',true);
  await fs.mkdir(folder,{recursive:true,mode:0o700});
  await assertNoSymlinks(workspaceRoot,'workspace');
  const sqlite=await assertNoSymlinks(workspaceRoot,'workspace/catalog.sqlite',true);
  const json=await assertNoSymlinks(workspaceRoot,'workspace/catalog.json',true);
  let db:Database|undefined;
  try{
    const Constructor=createRequire(import.meta.url)('better-sqlite3') as new(filename:string)=>Database;
    db=new Constructor(sqlite);
  }catch(error){
    // A damaged existing database must never silently become an empty catalog.
    if(await fs.lstat(sqlite).then(()=>true).catch(()=>false))throw error;
    const message=String((error as Error).message);
    if(!/module|bindings|NODE_MODULE_VERSION|dlopen|shared object/i.test(message))throw error;
  }

  let state:CatalogState;
  const fallbackTexts=new Map<string,string>();
  let lastJsonSaved:string|undefined;
  let walActive=false;
  let dirtySinceCheckpoint=false;

  const savedTopics=new Map<string,string>();
  const savedRoots=new Map<string,string>();
  const savedResources=new Map<string,string>();
  const savedOperations=new Map<string,string>();
  let savedTimeline='';

  function snapshotSaved(current:CatalogState){
    savedTopics.clear();
    current.topics.forEach((item,ord)=>savedTopics.set(item.id,`${ord}:${JSON.stringify(item)}`));
    savedRoots.clear();
    current.roots.forEach((item,ord)=>savedRoots.set(item.id,`${ord}:${JSON.stringify(item)}`));
    savedResources.clear();
    current.resources.forEach((item,ord)=>savedResources.set(item.id,`${ord}:${JSON.stringify(stripText(item))}`));
    savedOperations.clear();
    current.operations.forEach((item,ord)=>savedOperations.set(item.id,`${ord}:${JSON.stringify(item)}`));
    savedTimeline=JSON.stringify(current.conferenceTimeline);
  }

  if(db){
    db.pragma('busy_timeout = 5000');
    const tables=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name));
    const hasNormalized=tables.has('meta')&&(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as {value:string}|undefined)?.value==='2';
    if(hasNormalized){
      const versionRow=db.prepare("SELECT value FROM meta WHERE key='version'").get() as {value:string}|undefined;
      const timelineRow=db.prepare("SELECT value FROM meta WHERE key='conferenceTimeline'").get() as {value:string}|undefined;
      const topics=(db.prepare('SELECT data FROM topics ORDER BY ord').all() as {data:string}[]).map(r=>JSON.parse(r.data) as ResearchTopic);
      const roots=(db.prepare('SELECT data FROM roots ORDER BY ord').all() as {data:string}[]).map(r=>JSON.parse(r.data) as SourceRoot);
      const resources=(db.prepare('SELECT data FROM resources ORDER BY ord').all() as {data:string}[]).map(r=>JSON.parse(r.data) as IndexedResource);
      const operations=(db.prepare('SELECT data FROM operations ORDER BY ord').all() as {data:string}[]).map(r=>JSON.parse(r.data) as JournalOperation);
      state={
        version:(versionRow?Number(versionRow.value):1) as 1,
        topics,roots,resources,operations,
        conferenceTimeline:timelineRow?JSON.parse(timelineRow.value):{revision:0,conferences:[]},
      };
      validateState(state);
      snapshotSaved(state);
    }else if(tables.has('catalog')){
      const row=db.prepare('SELECT payload FROM catalog WHERE id=1').get() as {payload:string}|undefined;
      state=row?JSON.parse(row.payload):empty();
      validateState(state);
      // Seamless one-time migration from legacy single-row blob to normalized tables.
      db.exec(SCHEMA_SQL);
      const migrate=db.transaction(()=>{
        const putMeta=db.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
        const putTopic=db.prepare('INSERT INTO topics (id,ord,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET ord=excluded.ord, data=excluded.data');
        const putRoot=db.prepare('INSERT INTO roots (id,ord,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET ord=excluded.ord, data=excluded.data');
        const putResource=db.prepare('INSERT INTO resources (id,ord,root_id,data) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET ord=excluded.ord, root_id=excluded.root_id, data=excluded.data');
        const putText=db.prepare('INSERT INTO resource_text (id,hash,text) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash, text=excluded.text');
        const putOp=db.prepare('INSERT INTO operations (id,ord,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET ord=excluded.ord, data=excluded.data');
        putMeta.run('schema_version','2');
        putMeta.run('version',String(state.version));
        putMeta.run('conferenceTimeline',JSON.stringify(state.conferenceTimeline));
        state.topics.forEach((item,ord)=>putTopic.run(item.id,ord,JSON.stringify(item)));
        state.roots.forEach((item,ord)=>putRoot.run(item.id,ord,JSON.stringify(item)));
        state.resources.forEach((item,ord)=>{
          if(typeof item.text==='string'){
            putText.run(item.id,item.hash??'',item.text);
            delete item.text;
          }
          putResource.run(item.id,ord,item.rootId,JSON.stringify(stripText(item)));
        });
        state.operations.forEach((item,ord)=>putOp.run(item.id,ord,JSON.stringify(item)));
        db!.exec('DROP TABLE IF EXISTS catalog');
      });
      migrate();
      db.exec('VACUUM');
      snapshotSaved(state);
      await fs.chmod(sqlite,0o600);
    }else{
      state=empty();
      db.pragma('journal_mode = DELETE');
      db.pragma('synchronous = NORMAL');
      db.exec(SCHEMA_SQL);
      db.transaction(()=>{
        const putMeta=db.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
        putMeta.run('schema_version','2');
        putMeta.run('version','1');
        putMeta.run('conferenceTimeline',JSON.stringify(state.conferenceTimeline));
      })();
      snapshotSaved(state);
      await fs.chmod(sqlite,0o600);
    }
  }else{
    try{
      state=JSON.parse(await fs.readFile(json,'utf8'));
      validateState(state);
      for(const item of state.resources){
        if(typeof item.text==='string'){fallbackTexts.set(item.id,item.text);delete item.text;}
      }
      lastJsonSaved=JSON.stringify(state);
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      state=empty();
    }
  }

  const getTextStmt=db?db.prepare('SELECT text FROM resource_text WHERE id = ?'):undefined;
  const upsertMetaStmt=db?db.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'):undefined;
  const upsertTopicStmt=db?db.prepare('INSERT INTO topics (id,ord,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET ord=excluded.ord, data=excluded.data'):undefined;
  const deleteTopicStmt=db?db.prepare('DELETE FROM topics WHERE id = ?'):undefined;
  const upsertRootStmt=db?db.prepare('INSERT INTO roots (id,ord,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET ord=excluded.ord, data=excluded.data'):undefined;
  const deleteRootStmt=db?db.prepare('DELETE FROM roots WHERE id = ?'):undefined;
  const upsertResourceStmt=db?db.prepare('INSERT INTO resources (id,ord,root_id,data) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET ord=excluded.ord, root_id=excluded.root_id, data=excluded.data'):undefined;
  const deleteResourceStmt=db?db.prepare('DELETE FROM resources WHERE id = ?'):undefined;
  const upsertTextStmt=db?db.prepare('INSERT INTO resource_text (id,hash,text) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash, text=excluded.text'):undefined;
  const deleteTextStmt=db?db.prepare('DELETE FROM resource_text WHERE id = ?'):undefined;
  const upsertOpStmt=db?db.prepare('INSERT INTO operations (id,ord,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET ord=excluded.ord, data=excluded.data'):undefined;
  const deleteOpStmt=db?db.prepare('DELETE FROM operations WHERE id = ?'):undefined;

  function ensureWal(){
    if(!db||walActive)return;
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    walActive=true;
  }

  function flushCheckpoint(){
    if(!db||(!walActive&&!dirtySinceCheckpoint))return;
    try{
      db.pragma('wal_checkpoint(TRUNCATE)');
      if(walActive){
        db.pragma('journal_mode = DELETE');
        walActive=false;
      }
    }catch(error){
      if((error as {code?:string}).code!=='SQLITE_BUSY')throw error;
    }
    dirtySinceCheckpoint=false;
  }

  return {
    state,
    getPersistedText(id:string):string|undefined{
      if(getTextStmt){
        const row=getTextStmt.get(id) as {text:string}|undefined;
        return row?.text;
      }
      return fallbackTexts.get(id);
    },
    async save(){
      if(db){
        const topicUpserts:Array<[string,number,string,string]>=[];
        const seenTopics=new Set<string>();
        state.topics.forEach((item,ord)=>{
          seenTopics.add(item.id);
          const data=JSON.stringify(item),key=`${ord}:${data}`;
          if(savedTopics.get(item.id)!==key)topicUpserts.push([item.id,ord,data,key]);
        });
        const topicDeletes=[...savedTopics.keys()].filter(id=>!seenTopics.has(id));

        const rootUpserts:Array<[string,number,string,string]>=[];
        const seenRoots=new Set<string>();
        state.roots.forEach((item,ord)=>{
          seenRoots.add(item.id);
          const data=JSON.stringify(item),key=`${ord}:${data}`;
          if(savedRoots.get(item.id)!==key)rootUpserts.push([item.id,ord,data,key]);
        });
        const rootDeletes=[...savedRoots.keys()].filter(id=>!seenRoots.has(id));

        const resourceUpserts:Array<[string,number,string,string,string]>=[];
        const textUpserts:Array<[string,string,string]>=[];
        const textDeletes:string[]=[];
        const seenResources=new Set<string>();
        state.resources.forEach((item,ord)=>{
          seenResources.add(item.id);
          if(Object.hasOwn(item,'text')){
            if(typeof item.text==='string')textUpserts.push([item.id,item.hash??'',item.text]);
            else textDeletes.push(item.id);
          }
          const data=JSON.stringify(stripText(item)),key=`${ord}:${data}`;
          if(savedResources.get(item.id)!==key)resourceUpserts.push([item.id,ord,item.rootId,data,key]);
        });
        const resourceDeletes=[...savedResources.keys()].filter(id=>!seenResources.has(id));

        const opUpserts:Array<[string,number,string,string]>=[];
        const seenOps=new Set<string>();
        state.operations.forEach((item,ord)=>{
          seenOps.add(item.id);
          const data=JSON.stringify(item),key=`${ord}:${data}`;
          if(savedOperations.get(item.id)!==key)opUpserts.push([item.id,ord,data,key]);
        });
        const opDeletes=[...savedOperations.keys()].filter(id=>!seenOps.has(id));

        const timelineJson=JSON.stringify(state.conferenceTimeline??{revision:0,conferences:[]});
        const timelineChanged=timelineJson!==savedTimeline;

        if(!topicUpserts.length&&!topicDeletes.length&&!rootUpserts.length&&!rootDeletes.length
           &&!resourceUpserts.length&&!resourceDeletes.length&&!textUpserts.length&&!textDeletes.length
           &&!opUpserts.length&&!opDeletes.length&&!timelineChanged){
          return;
        }

        ensureWal();
        db.transaction(()=>{
          for(const [id,ord,data] of topicUpserts)upsertTopicStmt!.run(id,ord,data);
          for(const id of topicDeletes)deleteTopicStmt!.run(id);
          for(const [id,ord,data] of rootUpserts)upsertRootStmt!.run(id,ord,data);
          for(const id of rootDeletes)deleteRootStmt!.run(id);
          for(const [id,ord,rootId,data] of resourceUpserts)upsertResourceStmt!.run(id,ord,rootId,data);
          for(const id of resourceDeletes){deleteResourceStmt!.run(id);deleteTextStmt!.run(id);}
          for(const [id,fileHash,text] of textUpserts)upsertTextStmt!.run(id,fileHash,text);
          for(const id of textDeletes)deleteTextStmt!.run(id);
          for(const [id,ord,data] of opUpserts)upsertOpStmt!.run(id,ord,data);
          for(const id of opDeletes)deleteOpStmt!.run(id);
          if(timelineChanged)upsertMetaStmt!.run('conferenceTimeline',timelineJson);
        })();

        for(const [id,,,key] of topicUpserts)savedTopics.set(id,key);
        for(const id of topicDeletes)savedTopics.delete(id);
        for(const [id,,,key] of rootUpserts)savedRoots.set(id,key);
        for(const id of rootDeletes)savedRoots.delete(id);
        for(const [id,,,,key] of resourceUpserts)savedResources.set(id,key);
        for(const id of resourceDeletes)savedResources.delete(id);
        for(const [id,,,key] of opUpserts)savedOperations.set(id,key);
        for(const id of opDeletes)savedOperations.delete(id);
        if(timelineChanged)savedTimeline=timelineJson;
        // Free persisted extracted text from in-memory catalog objects.
        for(const item of state.resources){if(Object.hasOwn(item,'text'))delete item.text;}
        dirtySinceCheckpoint=true;
        return;
      }

      // JSON fallback when better-sqlite3 native bindings are unavailable.
      for(const item of state.resources){
        if(Object.hasOwn(item,'text')){
          if(typeof item.text==='string')fallbackTexts.set(item.id,item.text);
          else fallbackTexts.delete(item.id);
          delete item.text;
        }
      }
      const serializable={...state,resources:state.resources.map(item=>fallbackTexts.has(item.id)?{...item,text:fallbackTexts.get(item.id)}:item)};
      const payload=JSON.stringify(serializable);
      if(payload===lastJsonSaved)return;
      await assertNoSymlinks(workspaceRoot,'workspace/catalog.json',true);
      await atomicWrite(json,payload+'\n');
      await fs.chmod(json,0o600);
      lastJsonSaved=payload;
    },
    checkpoint(){flushCheckpoint();},
    close(){flushCheckpoint();db?.close();},
  };
}
