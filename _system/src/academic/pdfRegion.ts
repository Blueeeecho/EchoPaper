import type {BilingualBlock} from '../../shared/bilingual';

export interface PdfRegionBounds {x:number;y:number;width:number;height:number}

/** Parser coordinates and PDF viewports can have different horizontal and vertical scales. */
export function pdfRegionBounds(block:Pick<BilingualBlock,'rect'|'cropRect'|'pageWidth'|'pageHeight'>,viewport:{width:number;height:number}):PdfRegionBounds|undefined{
 const rect=block.cropRect||block.rect;
 const width=block.pageWidth,height=block.pageHeight;
 if(!rect||!width||!height||![...rect,width,height,viewport.width,viewport.height].every(Number.isFinite))return;
 if(width<=0||height<=0||rect[2]<=0||rect[3]<=0||viewport.width<=0||viewport.height<=0)return;
 const [rx,ry,rw,rh]=rect;
 const x=Math.max(0,rx/width*viewport.width),y=Math.max(0,ry/height*viewport.height);
 const right=Math.min(viewport.width,(rx+rw)/width*viewport.width);
 const bottom=Math.min(viewport.height,(ry+rh)/height*viewport.height);
 if(right<=x||bottom<=y)return;
 return {x,y,width:right-x,height:bottom-y};
}
