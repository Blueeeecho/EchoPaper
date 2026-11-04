export interface TranslationPlacement{x:number;y:number;width:number;height:number;pinned:boolean}
export const defaultTranslationPlacement:TranslationPlacement={x:72,y:92,width:600,height:620,pinned:false};
export function clampTranslationPlacement(value:TranslationPlacement,viewport:{width:number;height:number}):TranslationPlacement{
 const vw=Math.max(1,viewport.width),vh=Math.max(1,viewport.height),gap=Math.min(10,vw/10,vh/10);
 const width=Math.min(Math.max(280,Number.isFinite(value.width)?value.width:560),vw-gap*2);
 const height=Math.min(Math.max(250,Number.isFinite(value.height)?value.height:480),vh-gap*2);
 return {x:Math.max(gap,Math.min(Number.isFinite(value.x)?value.x:72,vw-width-gap)),y:Math.max(gap,Math.min(Number.isFinite(value.y)?value.y:92,vh-height-gap)),width,height,pinned:value.pinned===true};
}
/** Control is the physical Ctrl key (⌃ on Mac), never Command/Meta. */
export function translationGesture(event:{ctrlKey:boolean;metaKey?:boolean;altKey?:boolean;button:number},inSurface:boolean){return inSurface&&event.button===0&&event.ctrlKey&&!event.metaKey&&!event.altKey;}
export function translationKeyboardGesture(event:{ctrlKey:boolean;metaKey?:boolean;altKey?:boolean;shiftKey:boolean;key:string},inSurface:boolean){return inSurface&&event.ctrlKey&&!event.metaKey&&!event.altKey&&event.shiftKey&&/^(?:Arrow(?:Left|Right|Up|Down)|Home|End)$/.test(event.key);}
export function dismissSelectionTranslation(state:{open:boolean;pinned:boolean;manual:boolean;inside:boolean;settings:boolean}){return state.open&&!state.pinned&&!state.manual&&!state.inside&&!state.settings;}
