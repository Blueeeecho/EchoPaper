export interface ComparedFile { path: string; change: 'added'|'removed'|'modified'; beforeHash?:string;afterHash?:string }
export interface BuildComparison { leftId:string;rightId:string;targetId:string;files:ComparedFile[];unchanged:number;before?:string;after?:string;file?:string;binary?:boolean }
