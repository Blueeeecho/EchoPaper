import type {FileEntry} from '../shared/types';
export function fileParent(path:string){const slash=path.lastIndexOf('/');return slash<0?'':path.slice(0,slash);}
export function dropDirectory(entry:Pick<FileEntry,'path'|'type'>){return entry.type==='directory'?entry.path:fileParent(entry.path);}
export function defaultFileDirectory(files:FileEntry[],selected:string){const entry=files.find(file=>file.path===selected);return entry?dropDirectory(entry):'manuscript';}
export function hasDroppedFiles(transfer:Pick<DataTransfer,'types'>){return Array.from(transfer.types).includes('Files');}
