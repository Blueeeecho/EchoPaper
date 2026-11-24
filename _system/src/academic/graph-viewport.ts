export interface GraphPoint {x:number;y:number}
export interface GraphCamera extends GraphPoint {k:number}
export const graphViewport={width:960,height:520};

export function boundGraphPoint(point:GraphPoint,padding:number):GraphPoint{
 return {
  x:Math.max(padding,Math.min(graphViewport.width-padding,point.x)),
  y:Math.max(padding,Math.min(graphViewport.height-padding,point.y)),
 };
}

/** Keep at least one node in view when zooming around empty space or panning. */
export function keepGraphInView(camera:GraphCamera,points:GraphPoint[]):GraphCamera{
 let closest:GraphPoint|undefined,distance=Infinity;
 const padding=Math.min(140,Math.max(28,16*camera.k));
 for(const point of points){
  const projected={x:camera.x+point.x*camera.k,y:camera.y+point.y*camera.k};
  const bounded=boundGraphPoint(projected,padding);
  const shift={x:bounded.x-projected.x,y:bounded.y-projected.y};
  const squared=shift.x*shift.x+shift.y*shift.y;
  if(squared===0)return camera;
  if(squared<distance){closest=shift;distance=squared;}
 }
 return closest?{x:camera.x+closest.x,y:camera.y+closest.y,k:camera.k}:camera;
}
