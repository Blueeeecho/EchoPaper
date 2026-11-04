export interface PdfClickIntent {button:number;detail:number;enabled:boolean;modified:boolean;interactive:boolean;dragged:boolean;selected:boolean}
/** Double-click explicitly locates source, even though the browser selects a word as part of that gesture. */
export function shouldLocatePdf(intent:PdfClickIntent){return intent.button===0&&intent.detail===2&&intent.enabled&&!intent.interactive&&!intent.dragged;}
export function mostVisiblePdfPage(pages:{page:number;top:number;bottom:number}[],top:number,bottom:number){let best:number|undefined,visible=0;for(const page of pages){const height=Math.max(0,Math.min(bottom,page.bottom)-Math.max(top,page.top));if(height>visible){best=page.page;visible=height;}}return best;}
