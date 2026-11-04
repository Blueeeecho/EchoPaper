import {HttpError} from '../security';
const states=new Map<string,{locked:boolean}>();
export function workspaceMaintenance(root:string){
 let state=states.get(root);if(!state){state={locked:false};states.set(root,state);}const current=state;
 return {isLocked:()=>current.locked,assertAvailable(){if(current.locked)throw new HttpError(503,'工作区正在备份或恢复，请稍后重试。');},async withMaintenance<T>(work:()=>Promise<T>):Promise<T>{if(current.locked)throw new HttpError(409,'工作区维护操作尚未完成。');current.locked=true;try{return await work();}finally{current.locked=false;}}};
}
