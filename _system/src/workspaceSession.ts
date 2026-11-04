/** Per-tab navigation and reading state. Never stores manuscript content or secrets. */
export type WorkspaceView='writing'|'reviews'|'submissions'|'history'|'settings'|'backups';
export interface WorkspaceSession{version:1;screen:'library'|'project';projectId:string;view:WorkspaceView;path:string;targetId:string;aiOpen:boolean;editorPercent:number}
export interface EditorPosition{anchor:number;head:number;top:number;left:number}
export interface PdfPosition{page:number;offset:number;top:number;zoom:number}
const views=['writing','reviews','submissions','history','settings','backups'];
const project=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);
const source=(value:unknown):value is string=>typeof value==='string'&&value.length<=2000&&!/[\\\x00-\x1f]/.test(value)&&!value.startsWith('/')&&!value.split('/').some(part=>!part||part==='.'||part==='..');
const bounded=(value:unknown,min:number,max:number,fallback:number)=>typeof value==='number'&&Number.isFinite(value)?Math.min(max,Math.max(min,value)):fallback;
export function normalizeWorkspaceSession(raw:any):WorkspaceSession|undefined{
 if(!raw||raw.version!==1||!['library','project'].includes(raw.screen)||!project(raw.projectId))return;
 return{version:1,screen:raw.screen,projectId:raw.projectId,view:views.includes(raw.view)?raw.view:'writing',path:source(raw.path)?raw.path:'',targetId:project(raw.targetId)?raw.targetId:'',aiOpen:raw.aiOpen===true,editorPercent:bounded(raw.editorPercent,25,75,48)};
}
export const workspaceSessionKey='echopaper:workspace:v1';
export function readSession<T>(key:string):T|undefined{try{return JSON.parse(sessionStorage.getItem(key)||'null')||undefined;}catch{return;}}
export function writeSession(key:string,value:unknown){try{sessionStorage.setItem(key,JSON.stringify(value));}catch{/* Navigation remains usable with storage disabled. */}}
export function initialWorkspace():WorkspaceSession{
 const saved=normalizeWorkspaceSession(readSession(workspaceSessionKey));if(saved)return saved;
 let legacy='';try{legacy=localStorage.getItem('motai:project')||'';}catch{}
 return{version:1,screen:project(legacy)?'project':'library',projectId:project(legacy)?legacy:'',view:'writing',path:'',targetId:'',aiOpen:false,editorPercent:48};
}
export const editorPositionKey=(projectId:string,path:string)=>`echopaper:editor-position:v1:${projectId}:${path}`;
export const pdfPositionKey=(projectId:string,targetId:string)=>`echopaper:pdf-position:v1:${projectId}:${targetId}`;
export function normalizeEditorPosition(raw:any,length:number):EditorPosition|undefined{
 if(!raw||![raw.anchor,raw.head,raw.top,raw.left].every(v=>typeof v==='number'&&Number.isFinite(v)))return;
 return{anchor:Math.floor(bounded(raw.anchor,0,length,0)),head:Math.floor(bounded(raw.head,0,length,0)),top:bounded(raw.top,0,1e8,0),left:bounded(raw.left,0,1e8,0)};
}
export function normalizePdfPosition(raw:any):PdfPosition|undefined{
 if(!raw||![raw.page,raw.offset,raw.top,raw.zoom].every(v=>typeof v==='number'&&Number.isFinite(v)))return;
 return{page:Math.floor(bounded(raw.page,1,100000,1)),offset:bounded(raw.offset,-2,2,0),top:bounded(raw.top,0,1e8,0),zoom:bounded(raw.zoom,.5,3,1)};
}
export function resumeFile(files:readonly{path:string;type?:string}[],saved:string,main:string){return files.some(f=>f.path===saved&&f.type!=='directory')?saved:main;}
