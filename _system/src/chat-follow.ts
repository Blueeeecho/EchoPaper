import type {PersistedMessage} from '../shared/chat-merge';
export interface VisibleChat {id:string;content:string}
export function visibleChat(id:string,messages:PersistedMessage[]):VisibleChat{return{id,content:JSON.stringify(messages.map(m=>[m.taskId||m.id,m.role,m.content,m.error,m.attachments?.map(a=>a.id)]))};}
export function shouldFollowChat(previous:VisibleChat|undefined,next:VisibleChat,wasAtBottom:boolean):boolean{return wasAtBottom&&(!previous||previous.id!==next.id||previous.content!==next.content);}
