import {
 KNOWLEDGE_ENTITIES,
 KNOWLEDGE_RELATIONS,
 type KnowledgeEdge,
 type KnowledgeEntityKind,
 type KnowledgeNode,
 type KnowledgeReference,
} from '../../shared/literature-graph';
import {graphLabelLines} from './graph-label';

export type LayoutMode='layered'|'force';

export interface GraphEngineNode extends KnowledgeNode {
 refs:KnowledgeReference[];
 degree:number;
}

export interface GraphEngineCallbacks {
 onSelectNode?:(nodeId:string|null)=>void;
 onSelectEdge?:(edgeId:string|null)=>void;
 onZoomChange?:(percent:number)=>void;
}

export const ENTITY_COLORS:Record<KnowledgeEntityKind,string>={
 paper:'#244F7A',
 method:'#6D4C9E',
 problem:'#B45309',
 model:'#0F766E',
 dataset:'#2E6F40',
 metric:'#52606D',
};

const ENTITY_HULL_FILL:Record<KnowledgeEntityKind,string>={
 paper:'rgba(36, 79, 122, 0.045)',
 method:'rgba(109, 76, 158, 0.05)',
 problem:'rgba(180, 83, 9, 0.05)',
 model:'rgba(15, 118, 110, 0.05)',
 dataset:'rgba(46, 111, 64, 0.05)',
 metric:'rgba(82, 96, 109, 0.045)',
};

const ENTITY_HULL_STROKE:Record<KnowledgeEntityKind,string>={
 paper:'rgba(36, 79, 122, 0.18)',
 method:'rgba(109, 76, 158, 0.18)',
 problem:'rgba(180, 83, 9, 0.18)',
 model:'rgba(15, 118, 110, 0.18)',
 dataset:'rgba(46, 111, 64, 0.18)',
 metric:'rgba(82, 96, 109, 0.18)',
};

const CANVAS_BG='#FAF9F6';
const DOT_COLOR='#DCD7CB';
const EDGE_DEFAULT='#B9B2A3';
const EDGE_HIGHLIGHT='#244F7A';
const INK_PRIMARY='#181B20';
const INK_SECONDARY='#484E56';
const PILL_BG='rgba(255, 255, 254, 0.94)';
const PILL_BORDER='rgba(213, 207, 195, 0.9)';
const FONT_FAMILY='-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

interface Point {x:number;y:number}
interface Camera {x:number;y:number;k:number}
interface Rect {x1:number;y1:number;x2:number;y2:number}

interface ColumnHeader {
 x:number;
 topY:number;
 label:string;
 count:number;
}

interface EdgeGeometry {
 edge:KnowledgeEdge;
 sx:number;
 sy:number;
 cx:number;
 cy:number;
 tx:number;
 ty:number;
 ex:number;
 ey:number;
 midX:number;
 midY:number;
 angle:number;
}

const LAYER_COLUMN:Record<KnowledgeEntityKind,number>={
 paper:0,
 method:1,
 problem:1,
 model:2,
 dataset:2,
 metric:3,
};

const COLUMN_TITLES=['论文','方法 · 问题','模型 · 基准','指标'];

const FORCE_ANCHORS:Record<KnowledgeEntityKind,Point>={
 paper:{x:-240,y:0},
 method:{x:10,y:-175},
 problem:{x:-30,y:185},
 model:{x:230,y:-115},
 dataset:{x:235,y:125},
 metric:{x:395,y:0},
};

export function nodeRadius(node:Pick<GraphEngineNode,'kind'|'degree'|'refs'>):number{
 if(node.kind==='paper')return 13+Math.min(5,Math.sqrt(node.degree)*1.4);
 return 8+Math.min(8,Math.sqrt(Math.max(1,node.refs.length))*2.1);
}

/** Semantic left-to-right layered layout with barycenter crossing minimization and guaranteed zero overlap. */
export function computeLayeredLayout(
 nodes:GraphEngineNode[],
 edges:KnowledgeEdge[],
):{positions:Map<string,Point>;columnHeaders:ColumnHeader[]}{
 const positions=new Map<string,Point>();
 const columnHeaders:ColumnHeader[]=[];
 if(!nodes.length)return {positions,columnHeaders};

 const buckets:GraphEngineNode[][]=[[],[],[],[]];
 for(const node of nodes)buckets[LAYER_COLUMN[node.kind]].push(node);

 // Initial sort inside each column: kind group then degree desc then label
 for(const bucket of buckets){
  bucket.sort((a,b)=>{
   if(a.kind!==b.kind)return a.kind.localeCompare(b.kind);
   return b.degree-a.degree||b.refs.length-a.refs.length||a.label.localeCompare(b.label);
  });
 }

 const activeCols=buckets
  .map((items,rawIndex)=>({rawIndex,items}))
  .filter(col=>col.items.length>0);

 // Build adjacency for barycenter crossing minimization
 const adj=new Map<string,string[]>();
 for(const node of nodes)adj.set(node.id,[]);
 for(const edge of edges){
  adj.get(edge.source.id)?.push(edge.target.id);
  adj.get(edge.target.id)?.push(edge.source.id);
 }

 const orderIndex=new Map<string,number>();
 const refreshIndices=()=>{
  for(const col of activeCols){
   col.items.forEach((node,i)=>orderIndex.set(node.id,i));
  }
 };
 refreshIndices();

 // 4 sweeps of barycenter ordering (forward + backward)
 for(let pass=0;pass<4;pass++){
  const dir=pass%2===0?1:-1;
  const start=dir===1?1:activeCols.length-2;
  const end=dir===1?activeCols.length:-1;
  for(let ci=start;ci!==end;ci+=dir){
   const col=activeCols[ci];
   const neighborColSet=new Set(activeCols[ci-dir].items.map(n=>n.id));
   const scores=new Map<string,number>();
   for(const node of col.items){
    const neighbors=(adj.get(node.id)||[]).filter(id=>neighborColSet.has(id));
    if(neighbors.length){
     let sum=0;
     for(const id of neighbors)sum+=orderIndex.get(id)??0;
     scores.set(node.id,sum/neighbors.length);
    }else{
     scores.set(node.id,orderIndex.get(node.id)??0);
    }
   }
   col.items.sort((a,b)=>(scores.get(a.id)!-scores.get(b.id)!)||b.degree-a.degree||a.label.localeCompare(b.label));
   refreshIndices();
  }
 }

 const maxRows=Math.max(1,...activeCols.map(c=>c.items.length>14?Math.ceil(c.items.length/2):c.items.length));
 const colSpacing=activeCols.length<=2?360:Math.max(320,Math.min(680,Math.round(maxRows*34)));
 const totalWidth=(activeCols.length-1)*colSpacing;
 const startX=-totalWidth/2;

 for(let ci=0;ci<activeCols.length;ci++){
  const col=activeCols[ci];
  const baseX=startX+ci*colSpacing;
  const count=col.items.length;
  const splitSubCols=count>14;
  const rowCount=splitSubCols?Math.ceil(count/2):count;
  const pitch=splitSubCols?64:count>10?64:76;
  const totalHeight=(rowCount-1)*pitch;
  const topY=-totalHeight/2;

  for(let i=0;i<count;i++){
   const node=col.items[i];
   if(splitSubCols){
    const sub=i%2;
    const row=Math.floor(i/2);
    const x=baseX+(sub===0?-88:88);
    const y=topY+row*pitch+(sub===1?pitch*0.42:0);
    positions.set(node.id,{x,y});
   }else{
    positions.set(node.id,{x:baseX,y:topY+i*pitch});
   }
  }
  columnHeaders.push({
   x:baseX,
   topY:topY-54,
   label:COLUMN_TITLES[col.rawIndex],
   count,
  });
 }

 return {positions,columnHeaders};
}

/** Fast collision-aware O(N² + E) cluster force layout with semantic gravity. */
export function computeForceLayout(
 nodes:GraphEngineNode[],
 edges:KnowledgeEdge[],
):Map<string,Point>{
 const positions=new Map<string,Point>();
 const n=nodes.length;
 if(!n)return positions;

 const x=new Float64Array(n);
 const y=new Float64Array(n);
 const vx=new Float64Array(n);
 const vy=new Float64Array(n);
 const radii=new Float64Array(n);
 const ax=new Float64Array(n);
 const ay=new Float64Array(n);
 const indexById=new Map<string,number>();

 const kindCounters:Record<string,number>={};
 for(let i=0;i<n;i++){
  const node=nodes[i];
  indexById.set(node.id,i);
  radii[i]=nodeRadius(node);
  const anchor=FORCE_ANCHORS[node.kind];
  ax[i]=anchor.x;
  ay[i]=anchor.y;
  const c=(kindCounters[node.kind]=(kindCounters[node.kind]||0)+1)-1;
  const angle=c*2.39996;
  const dist=32+Math.sqrt(c+1)*26;
  x[i]=anchor.x+Math.cos(angle)*dist;
  y[i]=anchor.y+Math.sin(angle)*dist;
 }

 const links:[number,number,number][]=[];
 for(const edge of edges){
  const s=indexById.get(edge.source.id);
  const t=indexById.get(edge.target.id);
  if(s!==undefined&&t!==undefined&&s!==t){
   links.push([s,t,1+Math.min(2,Math.log2(edge.refs.length+1)*0.4)]);
  }
 }

 const steps=n>180?120:170;
 for(let step=0;step<steps;step++){
  const alpha=1-step/(steps+30);
  // Reset velocity damping
  for(let i=0;i<n;i++){
   vx[i]*=0.62;
   vy[i]*=0.62;
   // Semantic cluster gravity + gentle global centering
   vx[i]+=(ax[i]-x[i])*0.017*alpha-x[i]*0.002*alpha;
   vy[i]+=(ay[i]-y[i])*0.017*alpha-y[i]*0.002*alpha;
  }
  // Pairwise repulsion + collision separation
  for(let i=0;i<n;i++){
   const xi=x[i],yi=y[i],ri=radii[i];
   for(let j=i+1;j<n;j++){
    let dx=xi-x[j],dy=yi-y[j];
    let d2=dx*dx+dy*dy;
    if(d2<0.25){
     dx=0.5;dy=0.5;d2=0.5;
    }
    const d=Math.sqrt(d2);
    const minDist=ri+radii[j]+42;
    const repulse=(2600/Math.max(80,d2))*alpha;
    let push=repulse/d;
    if(d<minDist){
     push+=((minDist-d)/d)*0.42;
    }
    const fx=dx*push,fy=dy*push;
    vx[i]+=fx;vy[i]+=fy;
    vx[j]-=fx;vy[j]-=fy;
   }
  }
  // Edge attraction
  const ideal=n>60?155:132;
  for(let k=0;k<links.length;k++){
   const [i,j,weight]=links[k];
   const dx=x[j]-x[i],dy=y[j]-y[i];
   const d=Math.max(1,Math.hypot(dx,dy));
   const f=(d-ideal)*0.024*weight*alpha;
   const fx=(dx/d)*f,fy=(dy/d)*f;
   vx[i]+=fx;vy[i]+=fy;
   vx[j]-=fx;vy[j]-=fy;
  }
  const maxStep=18*alpha+2;
  for(let i=0;i<n;i++){
   const mag=Math.hypot(vx[i],vy[i]);
   if(mag>maxStep){
    vx[i]=(vx[i]/mag)*maxStep;
    vy[i]=(vy[i]/mag)*maxStep;
   }
   x[i]+=vx[i];
   y[i]+=vy[i];
  }
 }

 // Hard overlap cleanup pass
 for(let iter=0;iter<8;iter++){
  for(let i=0;i<n;i++){
   for(let j=i+1;j<n;j++){
    const dx=x[i]-x[j],dy=y[i]-y[j];
    const d=Math.max(0.1,Math.hypot(dx,dy));
    const minDist=radii[i]+radii[j]+34;
    if(d<minDist){
     const shift=(minDist-d)*0.52;
     const ux=(dx/d)*shift,uy=(dy/d)*shift;
     x[i]+=ux;y[i]+=uy;
     x[j]-=ux;y[j]-=uy;
    }
   }
  }
 }

 for(let i=0;i<n;i++)positions.set(nodes[i].id,{x:x[i],y:y[i]});
 return positions;
}

/** Andrew's monotone chain convex hull for rendering subtle semantic cluster hulls. */
export function computeConvexHull(points:Point[]):Point[]{
 if(points.length<3)return points;
 const sorted=[...points].sort((a,b)=>a.x-b.x||a.y-b.y);
 const cross=(o:Point,a:Point,b:Point)=>(a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);
 const lower:Point[]=[];
 for(const p of sorted){
  while(lower.length>=2&&cross(lower[lower.length-2],lower[lower.length-1],p)<=0)lower.pop();
  lower.push(p);
 }
 const upper:Point[]=[];
 for(let i=sorted.length-1;i>=0;i--){
  const p=sorted[i];
  while(upper.length>=2&&cross(upper[upper.length-2],upper[upper.length-1],p)<=0)upper.pop();
  upper.push(p);
 }
 lower.pop();
 upper.pop();
 return [...lower,...upper];
}

function easeOutCubic(t:number){
 return 1-Math.pow(1-t,3);
}

function rectsOverlap(a:Rect,b:Rect,pad=4):boolean{
 return !(a.x2+pad<b.x1||a.x1-pad>b.x2||a.y2+pad<b.y1||a.y1-pad>b.y2);
}

function drawRoundedRect(ctx:CanvasRenderingContext2D,x:number,y:number,w:number,h:number,r:number){
 const radius=Math.min(r,w/2,h/2);
 ctx.beginPath();
 ctx.moveTo(x+radius,y);
 ctx.lineTo(x+w-radius,y);
 ctx.quadraticCurveTo(x+w,y,x+w,y+radius);
 ctx.lineTo(x+w,y+h-radius);
 ctx.quadraticCurveTo(x+w,y+h,x+w-radius,y+h);
 ctx.lineTo(x+radius,y+h);
 ctx.quadraticCurveTo(x,y+h,x,y+h-radius);
 ctx.lineTo(x,y+radius);
 ctx.quadraticCurveTo(x,y,x+radius,y);
 ctx.closePath();
}

export class GraphEngine {
 private canvas:HTMLCanvasElement;
 private ctx:CanvasRenderingContext2D;
 private callbacks:GraphEngineCallbacks;
 private resizeObserver?:ResizeObserver;
 private rafId=0;
 private width=960;
 private height=540;
 private dpr=1;
 private reducedMotion=false;

 private nodes:GraphEngineNode[]=[];
 private edges:KnowledgeEdge[]=[];
 private nodeById=new Map<string,GraphEngineNode>();
 private edgeById=new Map<string,KnowledgeEdge>();
 private neighbors=new Map<string,Set<string>>();
 private positions=new Map<string,Point>();
 private startPositions=new Map<string,Point>();
 private targetPositions=new Map<string,Point>();
 private pinnedIds=new Set<string>();
 private columnHeaders:ColumnHeader[]=[];
 private layoutMode:LayoutMode='layered';
 private showLabels=true;

 private camera:Camera={x:480,y:270,k:1};
 private startCamera:Camera={x:480,y:270,k:1};
 private targetCamera:Camera={x:480,y:270,k:1};
 private animStart=0;
 private animDuration=0;
 private lastReportedZoom=100;

 private selectedNodeId:string|null=null;
 private selectedEdgeId:string|null=null;
 private hoveredNodeId:string|null=null;
 private hoveredEdgeId:string|null=null;
 private pointerWorld:Point={x:0,y:0};

 private dragState:{
  pointerId:number;
  mode:'pan'|'node';
  nodeId?:string;
  startScreen:Point;
  lastScreen:Point;
  moved:boolean;
 }|null=null;

 private cachedEdges:EdgeGeometry[]=[];

 constructor(canvas:HTMLCanvasElement,callbacks:GraphEngineCallbacks={}){
  this.canvas=canvas;
  const ctx=canvas.getContext('2d');
  if(!ctx)throw new Error('2D Canvas context unavailable');
  this.ctx=ctx;
  this.callbacks=callbacks;
  this.reducedMotion=typeof window!=='undefined'&&window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  this.bindEvents();
  this.updateSize();
 }

 private bindEvents(){
  this.canvas.addEventListener('pointerdown',this.handlePointerDown);
  this.canvas.addEventListener('pointermove',this.handlePointerMove);
  this.canvas.addEventListener('pointerup',this.handlePointerUp);
  this.canvas.addEventListener('pointercancel',this.handlePointerUp);
  this.canvas.addEventListener('pointerleave',this.handlePointerLeave);
  this.canvas.addEventListener('dblclick',this.handleDoubleClick);
  this.canvas.addEventListener('wheel',this.handleWheel,{passive:false});
  this.canvas.addEventListener('keydown',this.handleKeyDown);

  if(typeof ResizeObserver!=='undefined'&&this.canvas.parentElement){
   this.resizeObserver=new ResizeObserver(()=>this.updateSize());
   this.resizeObserver.observe(this.canvas.parentElement);
  }
 }

 public destroy(){
  if(this.rafId)cancelAnimationFrame(this.rafId);
  this.resizeObserver?.disconnect();
  this.canvas.removeEventListener('pointerdown',this.handlePointerDown);
  this.canvas.removeEventListener('pointermove',this.handlePointerMove);
  this.canvas.removeEventListener('pointerup',this.handlePointerUp);
  this.canvas.removeEventListener('pointercancel',this.handlePointerUp);
  this.canvas.removeEventListener('pointerleave',this.handlePointerLeave);
  this.canvas.removeEventListener('dblclick',this.handleDoubleClick);
  this.canvas.removeEventListener('wheel',this.handleWheel);
  this.canvas.removeEventListener('keydown',this.handleKeyDown);
 }

 private updateSize(){
  const host=this.canvas.parentElement;
  if(!host)return;
  const rect=host.getBoundingClientRect();
  const nextW=Math.max(240,Math.floor(rect.width));
  const nextH=Math.max(240,Math.floor(rect.height));
  const nextDpr=Math.min(typeof window!=='undefined'?window.devicePixelRatio||1:1,2.5);
  if(nextW===this.width&&nextH===this.height&&nextDpr===this.dpr)return;
  const prevW=this.width,prevH=this.height;
  this.width=nextW;
  this.height=nextH;
  this.dpr=nextDpr;
  this.canvas.width=Math.round(nextW*nextDpr);
  this.canvas.height=Math.round(nextH*nextDpr);
  this.canvas.style.width=nextW+'px';
  this.canvas.style.height=nextH+'px';
  // Preserve center when container resizes (e.g. Evidence Inspector docks open/closed)
  if(prevW>0&&prevH>0){
   const dx=(nextW-prevW)/2,dy=(nextH-prevH)/2;
   this.camera.x+=dx;
   this.camera.y+=dy;
   this.targetCamera.x+=dx;
   this.targetCamera.y+=dy;
  }
  this.scheduleRender();
 }

 public setGraph(nodes:GraphEngineNode[],edges:KnowledgeEdge[],preserveSelection=false){
  const prevPositions=new Map(this.positions);
  this.nodes=nodes;
  this.edges=edges;
  this.nodeById=new Map(nodes.map(n=>[n.id,n]));
  this.edgeById=new Map(edges.map(e=>[e.id,e]));
  this.neighbors=new Map();
  for(const n of nodes)this.neighbors.set(n.id,new Set());
  for(const e of edges){
   this.neighbors.get(e.source.id)?.add(e.target.id);
   this.neighbors.get(e.target.id)?.add(e.source.id);
  }
  this.pinnedIds.clear();
  if(!preserveSelection){
   this.selectedNodeId=null;
   this.selectedEdgeId=null;
   this.hoveredNodeId=null;
   this.hoveredEdgeId=null;
  }else{
   if(this.selectedNodeId&&!this.nodeById.has(this.selectedNodeId))this.selectedNodeId=null;
   if(this.selectedEdgeId&&!this.edgeById.has(this.selectedEdgeId))this.selectedEdgeId=null;
  }

  this.applyLayout(prevPositions.size>0&&prevPositions.size===nodes.length,prevPositions);
 }

 public setLayoutMode(mode:LayoutMode){
  if(mode===this.layoutMode)return;
  this.layoutMode=mode;
  this.pinnedIds.clear();
  this.applyLayout(true,new Map(this.positions));
 }

 public setShowLabels(show:boolean){
  if(this.showLabels===show)return;
  this.showLabels=show;
  this.scheduleRender();
 }

 public setSelection(nodeId:string|null,edgeId:string|null){
  if(this.selectedNodeId===nodeId&&this.selectedEdgeId===edgeId)return;
  this.selectedNodeId=nodeId;
  this.selectedEdgeId=edgeId;
  this.scheduleRender();
 }

 public zoomBy(factor:number,screenCenter?:Point){
  const anchor=screenCenter??{x:this.width/2,y:this.height/2};
  const base=this.animDuration>0?this.targetCamera:this.camera;
  const nextK=Math.max(0.18,Math.min(4.2,base.k*factor));
  const ratio=nextK/base.k;
  const nextCam:Camera={
   x:anchor.x-(anchor.x-base.x)*ratio,
   y:anchor.y-(anchor.y-base.y)*ratio,
   k:nextK,
  };
  this.animateTo(this.positions,nextCam,this.reducedMotion?0:150);
 }

 public fitToView(animate=true){
  const cam=this.computeFitCamera(this.targetPositions.size?this.targetPositions:this.positions);
  this.animateTo(this.positions,cam,animate&&!this.reducedMotion?280:0);
 }

 public focusNode(nodeId:string){
  const pos=this.positions.get(nodeId);
  if(!pos)return;
  this.selectedNodeId=nodeId;
  this.selectedEdgeId=null;
  const k=Math.max(1.05,Math.min(1.65,this.camera.k<0.9?1.2:this.camera.k));
  const nextCam:Camera={
   x:this.width/2-pos.x*k,
   y:this.height/2-pos.y*k,
   k,
  };
  this.animateTo(this.positions,nextCam,this.reducedMotion?0:320);
 }

 private applyLayout(animate:boolean,prevPositions:Map<string,Point>){
  let nextPos:Map<string,Point>;
  if(this.layoutMode==='layered'){
   const res=computeLayeredLayout(this.nodes,this.edges);
   nextPos=res.positions;
   this.columnHeaders=res.columnHeaders;
  }else{
   nextPos=computeForceLayout(this.nodes,this.edges);
   this.columnHeaders=[];
  }

  const fitCam=this.computeFitCamera(nextPos);

  if(animate&&!this.reducedMotion&&prevPositions.size>0){
   this.startPositions=new Map();
   for(const node of this.nodes){
    const old=prevPositions.get(node.id)??nextPos.get(node.id)??{x:0,y:0};
    this.startPositions.set(node.id,{x:old.x,y:old.y});
   }
   this.targetPositions=nextPos;
   this.startCamera={...this.camera};
   this.targetCamera=fitCam;
   this.animStart=performance.now();
   this.animDuration=340;
  }else{
   this.positions=new Map();
   for(const [id,p] of nextPos)this.positions.set(id,{x:p.x,y:p.y});
   this.startPositions=new Map(this.positions);
   this.targetPositions=new Map(this.positions);
   this.camera={...fitCam};
   this.targetCamera={...fitCam};
   this.animDuration=0;
   this.reportZoom();
  }
  this.scheduleRender();
 }

 private animateTo(nextPositions:Map<string,Point>,nextCam:Camera,duration:number){
  if(duration<=0){
   this.camera={...nextCam};
   this.targetCamera={...nextCam};
   this.animDuration=0;
   this.reportZoom();
   this.scheduleRender();
   return;
  }
  this.startPositions=new Map();
  this.targetPositions=new Map();
  for(const [id,p] of this.positions){
   this.startPositions.set(id,{x:p.x,y:p.y});
   const target=nextPositions.get(id)??p;
   this.targetPositions.set(id,{x:target.x,y:target.y});
  }
  this.startCamera={...this.camera};
  this.targetCamera={...nextCam};
  this.animStart=performance.now();
  this.animDuration=duration;
  this.scheduleRender();
 }

 private computeFitCamera(posMap:Map<string,Point>):Camera{
  if(!posMap.size)return {x:this.width/2,y:this.height/2,k:1};
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for(const p of posMap.values()){
   if(p.x<minX)minX=p.x;
   if(p.x>maxX)maxX=p.x;
   if(p.y<minY)minY=p.y;
   if(p.y>maxY)maxY=p.y;
  }
  if(this.layoutMode==='layered'&&this.columnHeaders.length){
   minY=Math.min(minY,Math.min(...this.columnHeaders.map(h=>h.topY))-16);
  }
  const padX=92,padY=78;
  const spanX=Math.max(160,maxX-minX+140);
  const spanY=Math.max(140,maxY-minY+110);
  const availW=Math.max(160,this.width-padX*2);
  const availH=Math.max(140,this.height-padY*2);
  const k=Math.max(0.24,Math.min(1.38,availW/spanX,availH/spanY));
  const cx=(minX+maxX)/2,cy=(minY+maxY)/2;
  return {
   x:this.width/2-cx*k,
   y:this.height/2-cy*k,
   k,
  };
 }

 private screenToWorld(sx:number,sy:number):Point{
  return {x:(sx-this.camera.x)/this.camera.k,y:(sy-this.camera.y)/this.camera.k};
 }

 private worldToScreen(wx:number,wy:number):Point{
  return {x:wx*this.camera.k+this.camera.x,y:wy*this.camera.k+this.camera.y};
 }

 private eventToLocal(event:PointerEvent|WheelEvent|MouseEvent):Point{
  const rect=this.canvas.getBoundingClientRect();
  return {x:event.clientX-rect.left,y:event.clientY-rect.top};
 }

 private hitTestNode(world:Point):GraphEngineNode|null{
  const pad=7/Math.max(0.4,this.camera.k);
  for(let i=this.nodes.length-1;i>=0;i--){
   const node=this.nodes[i];
   const p=this.positions.get(node.id);
   if(!p)continue;
   const r=nodeRadius(node)+pad;
   if(Math.hypot(world.x-p.x,world.y-p.y)<=r)return node;
  }
  return null;
 }

 private hitTestEdge(screen:Point):KnowledgeEdge|null{
  const threshold=9;
  let best:KnowledgeEdge|null=null;
  let bestDist=threshold;
  for(const geom of this.cachedEdges){
   for(let step=1;step<=11;step++){
    const t=step/12;
    const mt=1-t;
    const wx=mt*mt*geom.sx+2*mt*t*geom.cx+t*t*geom.ex;
    const wy=mt*mt*geom.sy+2*mt*t*geom.cy+t*t*geom.ey;
    const sp=this.worldToScreen(wx,wy);
    const d=Math.hypot(screen.x-sp.x,screen.y-sp.y);
    if(d<bestDist){
     bestDist=d;
     best=geom.edge;
    }
   }
  }
  return best;
 }

 private handlePointerDown=(event:PointerEvent)=>{
  if(event.button!==0||!this.nodes.length)return;
  this.canvas.focus({preventScroll:true});
  const local=this.eventToLocal(event);
  const world=this.screenToWorld(local.x,local.y);
  this.animDuration=0;
  const hitNode=this.hitTestNode(world);
  if(hitNode){
   this.dragState={
    pointerId:event.pointerId,
    mode:'node',
    nodeId:hitNode.id,
    startScreen:local,
    lastScreen:local,
    moved:false,
   };
   this.canvas.style.cursor='grabbing';
  }else{
   this.dragState={
    pointerId:event.pointerId,
    mode:'pan',
    startScreen:local,
    lastScreen:local,
    moved:false,
   };
   this.canvas.style.cursor='grabbing';
  }
  this.canvas.setPointerCapture(event.pointerId);
 };

 private handlePointerMove=(event:PointerEvent)=>{
  const local=this.eventToLocal(event);
  const world=this.screenToWorld(local.x,local.y);
  this.pointerWorld=world;

  if(this.dragState&&this.dragState.pointerId===event.pointerId){
   const dx=local.x-this.dragState.lastScreen.x;
   const dy=local.y-this.dragState.lastScreen.y;
   if(Math.hypot(local.x-this.dragState.startScreen.x,local.y-this.dragState.startScreen.y)>3){
    this.dragState.moved=true;
   }
   this.dragState.lastScreen=local;

   if(this.dragState.mode==='node'&&this.dragState.nodeId){
    const p=this.positions.get(this.dragState.nodeId);
    if(p){
     p.x+=dx/this.camera.k;
     p.y+=dy/this.camera.k;
     this.pinnedIds.add(this.dragState.nodeId);
    }
   }else{
    this.camera.x+=dx;
    this.camera.y+=dy;
    this.targetCamera={...this.camera};
   }
   this.scheduleRender();
   return;
  }

  // Hover hit testing (no React re-render!)
  const hitNode=this.hitTestNode(world);
  const nextHoverNode=hitNode?.id??null;
  const nextHoverEdge=hitNode?null:(this.hitTestEdge(local)?.id??null);
  if(nextHoverNode!==this.hoveredNodeId||nextHoverEdge!==this.hoveredEdgeId){
   this.hoveredNodeId=nextHoverNode;
   this.hoveredEdgeId=nextHoverEdge;
   this.canvas.style.cursor=nextHoverNode||nextHoverEdge?'pointer':'grab';
   this.scheduleRender();
  }
 };

 private handlePointerUp=(event:PointerEvent)=>{
  const drag=this.dragState;
  if(!drag||drag.pointerId!==event.pointerId)return;
  this.dragState=null;
  if(this.canvas.hasPointerCapture(event.pointerId)){
   this.canvas.releasePointerCapture(event.pointerId);
  }
  const local=this.eventToLocal(event);
  const world=this.screenToWorld(local.x,local.y);

  if(!drag.moved){
   if(drag.mode==='node'&&drag.nodeId){
    this.selectedNodeId=drag.nodeId;
    this.selectedEdgeId=null;
    this.callbacks.onSelectNode?.(drag.nodeId);
   }else{
    const hitEdge=this.hitTestEdge(local);
    if(hitEdge){
     this.selectedEdgeId=hitEdge.id;
     this.selectedNodeId=null;
     this.callbacks.onSelectEdge?.(hitEdge.id);
    }else if(this.selectedNodeId||this.selectedEdgeId){
     this.selectedNodeId=null;
     this.selectedEdgeId=null;
     this.callbacks.onSelectNode?.(null);
    }
   }
  }
  const stillOver=this.hitTestNode(world)||this.hitTestEdge(local);
  this.canvas.style.cursor=stillOver?'pointer':'grab';
  this.scheduleRender();
 };

 private handlePointerLeave=()=>{
  if(this.dragState)return;
  if(this.hoveredNodeId||this.hoveredEdgeId){
   this.hoveredNodeId=null;
   this.hoveredEdgeId=null;
   this.scheduleRender();
  }
 };

 private handleDoubleClick=(event:MouseEvent)=>{
  const local=this.eventToLocal(event);
  const world=this.screenToWorld(local.x,local.y);
  const hit=this.hitTestNode(world);
  if(hit){
   this.pinnedIds.delete(hit.id);
   this.focusNode(hit.id);
   this.callbacks.onSelectNode?.(hit.id);
  }else{
   this.fitToView(true);
  }
 };

 private handleWheel=(event:WheelEvent)=>{
  if(!this.nodes.length)return;
  event.preventDefault();
  const local=this.eventToLocal(event);
  const delta=event.deltaMode===1?event.deltaY*24:event.deltaY;
  const clamped=Math.max(-140,Math.min(140,delta));
  const factor=Math.exp(-clamped*0.0024);
  // Direct responsive cursor-centered zoom (instantaneous 60fps feedback)
  this.animDuration=0;
  const nextK=Math.max(0.18,Math.min(4.2,this.camera.k*factor));
  const ratio=nextK/this.camera.k;
  if(nextK===this.camera.k)return;
  this.camera={
   x:local.x-(local.x-this.camera.x)*ratio,
   y:local.y-(local.y-this.camera.y)*ratio,
   k:nextK,
  };
  this.targetCamera={...this.camera};
  this.reportZoom();
  this.scheduleRender();
 };

 private handleKeyDown=(event:KeyboardEvent)=>{
  if(event.key==='+'||event.key==='='){
   event.preventDefault();
   this.zoomBy(1.22);
  }else if(event.key==='-'){
   event.preventDefault();
   this.zoomBy(0.82);
  }else if(event.key==='0'){
   event.preventDefault();
   this.fitToView(true);
  }else if(event.key==='Escape'&&(this.selectedNodeId||this.selectedEdgeId)){
   event.preventDefault();
   this.selectedNodeId=null;
   this.selectedEdgeId=null;
   this.callbacks.onSelectNode?.(null);
   this.scheduleRender();
  }
 };

 private reportZoom(){
  const pct=Math.round(this.camera.k*100);
  if(pct!==this.lastReportedZoom){
   this.lastReportedZoom=pct;
   this.callbacks.onZoomChange?.(pct);
  }
 }

 private scheduleRender(){
  if(this.rafId)return;
  this.rafId=requestAnimationFrame(this.frame);
 }

 private frame=(now:number)=>{
  this.rafId=0;
  let animating=false;
  if(this.animDuration>0){
   const elapsed=now-this.animStart;
   const t=Math.min(1,elapsed/this.animDuration);
   const e=easeOutCubic(t);
   this.camera={
    x:this.startCamera.x+(this.targetCamera.x-this.startCamera.x)*e,
    y:this.startCamera.y+(this.targetCamera.y-this.startCamera.y)*e,
    k:this.startCamera.k+(this.targetCamera.k-this.startCamera.k)*e,
   };
   for(const node of this.nodes){
    const s=this.startPositions.get(node.id);
    const d=this.targetPositions.get(node.id);
    if(s&&d){
     this.positions.set(node.id,{x:s.x+(d.x-s.x)*e,y:s.y+(d.y-s.y)*e});
    }
   }
   this.reportZoom();
   if(t<1){
    animating=true;
   }else{
    this.animDuration=0;
   }
  }
  this.render();
  if(animating)this.scheduleRender();
 };

 private computeEdgeGeometries():EdgeGeometry[]{
  // Group parallel edges between the same unordered pair so curves fan out cleanly
  const pairMap=new Map<string,KnowledgeEdge[]>();
  for(const edge of this.edges){
   const a=edge.source.id,b=edge.target.id;
   const pairKey=a<b?`${a}|${b}`:`${b}|${a}`;
   const list=pairMap.get(pairKey)??[];
   list.push(edge);
   pairMap.set(pairKey,list);
  }

  const out:EdgeGeometry[]=[];
  for(const group of pairMap.values()){
   const count=group.length;
   for(let idx=0;idx<count;idx++){
    const edge=group[idx];
    const pA=this.positions.get(edge.source.id);
    const pB=this.positions.get(edge.target.id);
    const nB=this.nodeById.get(edge.target.id);
    if(!pA||!pB||!nB)continue;

    const dx=pB.x-pA.x,dy=pB.y-pA.y;
    const dist=Math.max(1,Math.hypot(dx,dy));
    const nx=-dy/dist,ny=dx/dist;

    let offset=0;
    if(count===1){
     // Subtle editorial arc proportional to distance
     offset=this.layoutMode==='layered'
      ?Math.max(-28,Math.min(28,(pA.y-pB.y)*0.08))
      :Math.min(24,dist*0.09);
    }else{
     const slot=idx-(count-1)/2;
     offset=slot*36;
    }

    const cx=(pA.x+pB.x)/2+nx*offset;
    const cy=(pA.y+pB.y)/2+ny*offset;

    // Trim end of curve right outside target node radius
    const targetR=nodeRadius(nB)+5;
    const endDx=pB.x-cx,endDy=pB.y-cy;
    const endLen=Math.max(1,Math.hypot(endDx,endDy));
    const ex=pB.x-(endDx/endLen)*targetR;
    const ey=pB.y-(endDy/endLen)*targetR;
    const angle=Math.atan2(endDy,endDx);

    // Quadratic midpoint at t=0.5
    const midX=0.25*pA.x+0.5*cx+0.25*ex;
    const midY=0.25*pA.y+0.5*cy+0.25*ey;

    out.push({edge,sx:pA.x,sy:pA.y,cx,cy,tx:pB.x,ty:pB.y,ex,ey,midX,midY,angle});
   }
  }
  return out;
 }

 private render(){
  const ctx=this.ctx;
  const w=this.width,h=this.height;
  ctx.save();
  ctx.setTransform(this.dpr,0,0,this.dpr,0,0);

  // 1. Warm archival paper background
  ctx.fillStyle=CANVAS_BG;
  ctx.fillRect(0,0,w,h);

  // 2. Adaptive subtle dot-grid
  this.drawDotGrid(ctx,w,h);

  // Spotlight state
  const activeNode=this.hoveredNodeId||this.selectedNodeId;
  const activeEdge=this.hoveredEdgeId||this.selectedEdgeId;
  const hasSpotlight=!!(activeNode||activeEdge);
  const spotlightNodes=new Set<string>();
  if(activeNode){
   spotlightNodes.add(activeNode);
   for(const nb of this.neighbors.get(activeNode)??[])spotlightNodes.add(nb);
  }
  if(activeEdge){
   const e=this.edgeById.get(activeEdge);
   if(e){
    spotlightNodes.add(e.source.id);
    spotlightNodes.add(e.target.id);
   }
  }

  // 3. World-space layer
  ctx.save();
  ctx.translate(this.camera.x,this.camera.y);
  ctx.scale(this.camera.k,this.camera.k);

  // 3a. Semantic hulls (force mode) or column headers (layered mode)
  if(this.layoutMode==='force'){
   this.drawClusterHulls(ctx);
  }else if(this.columnHeaders.length){
   this.drawColumnHeaders(ctx);
  }

  // 3b. Curved edges with directional arrowheads
  this.cachedEdges=this.computeEdgeGeometries();
  for(const geom of this.cachedEdges){
   const {edge,sx,sy,cx,cy,ex,ey,angle}=geom;
   const isExact=activeEdge===edge.id;
   const isConnected=isExact
    ||(activeNode!==null&&(edge.source.id===activeNode||edge.target.id===activeNode));
   const alpha=!hasSpotlight?0.82:isConnected?1:0.12;
   const baseWidth=Math.min(3.4,1.15+Math.log2(edge.refs.length+1)*0.65);

   ctx.save();
   ctx.globalAlpha=alpha;
   ctx.beginPath();
   ctx.moveTo(sx,sy);
   ctx.quadraticCurveTo(cx,cy,ex,ey);
   ctx.strokeStyle=isExact?EDGE_HIGHLIGHT:isConnected&&hasSpotlight?ENTITY_COLORS[edge.source.kind]:EDGE_DEFAULT;
   ctx.lineWidth=(isExact?baseWidth+1.1:baseWidth)/Math.pow(this.camera.k,0.35);
   ctx.stroke();

   // Crisp directional arrowhead
   const arrowLen=Math.max(6.5,Math.min(10,8.5/Math.pow(this.camera.k,0.25)));
   const arrowWidth=arrowLen*0.52;
   ctx.fillStyle=isExact?EDGE_HIGHLIGHT:isConnected&&hasSpotlight?ENTITY_COLORS[edge.source.kind]:'#989182';
   ctx.beginPath();
   ctx.moveTo(ex,ey);
   ctx.lineTo(ex-Math.cos(angle)*arrowLen+Math.sin(angle)*arrowWidth,ey-Math.sin(angle)*arrowLen-Math.cos(angle)*arrowWidth);
   ctx.lineTo(ex-Math.cos(angle)*arrowLen-Math.sin(angle)*arrowWidth,ey-Math.sin(angle)*arrowLen+Math.cos(angle)*arrowWidth);
   ctx.closePath();
   ctx.fill();
   ctx.restore();
  }

  // 3c. Nodes
  for(const node of this.nodes){
   const p=this.positions.get(node.id);
   if(!p)continue;
   const r=nodeRadius(node);
   const color=ENTITY_COLORS[node.kind];
   const isSelected=this.selectedNodeId===node.id;
   const isHovered=this.hoveredNodeId===node.id;
   const isActive=!hasSpotlight||spotlightNodes.has(node.id);

   ctx.save();
   ctx.globalAlpha=isActive?1:0.18;

   // Outer focus/hover ring
   if(isSelected||isHovered){
    ctx.beginPath();
    if(node.kind==='paper'){
     drawRoundedRect(ctx,p.x-r-5,p.y-r-5,(r+5)*2,(r+5)*2,9);
    }else{
     ctx.arc(p.x,p.y,r+6,0,Math.PI*2);
    }
    ctx.fillStyle=color;
    ctx.globalAlpha=isSelected?0.22:0.14;
    ctx.fill();
    ctx.globalAlpha=1;
   }

   // Main node silhouette (papers: editorial rounded square; entities: refined circle)
   if(node.kind==='paper'){
    drawRoundedRect(ctx,p.x-r,p.y-r,r*2,r*2,6);
    ctx.fillStyle=color;
    ctx.fill();
    ctx.lineWidth=isSelected?2.8:2;
    ctx.strokeStyle='#FFFFFF';
    ctx.stroke();

    // Inner subtle book-spine dot mark
    ctx.fillStyle='rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(p.x,p.y,Math.max(2.2,r*0.22),0,Math.PI*2);
    ctx.fill();
   }else{
    ctx.beginPath();
    ctx.arc(p.x,p.y,r,0,Math.PI*2);
    ctx.fillStyle=color;
    ctx.fill();
    ctx.lineWidth=isSelected?2.8:2;
    ctx.strokeStyle='#FFFFFF';
    ctx.stroke();
   }

   // Pinned indicator dot
   if(this.pinnedIds.has(node.id)){
    ctx.beginPath();
    ctx.arc(p.x+r*0.72,p.y-r*0.72,3,0,Math.PI*2);
    ctx.fillStyle='#FAF9F6';
    ctx.fill();
    ctx.lineWidth=1.4;
    ctx.strokeStyle=color;
    ctx.stroke();
   }

   ctx.restore();
  }

  ctx.restore(); // end world transform

  // 4. Screen-space crisp labels (collision-free priority placement)
  this.drawLabels(ctx,hasSpotlight,spotlightNodes,activeNode,activeEdge);

  ctx.restore();
 }

 private drawDotGrid(ctx:CanvasRenderingContext2D,w:number,h:number){
  let spacing=28*this.camera.k;
  while(spacing<18)spacing*=2;
  while(spacing>56)spacing/=2;
  const offsetX=((this.camera.x%spacing)+spacing)%spacing;
  const offsetY=((this.camera.y%spacing)+spacing)%spacing;
  ctx.fillStyle=DOT_COLOR;
  for(let gx=offsetX;gx<w;gx+=spacing){
   for(let gy=offsetY;gy<h;gy+=spacing){
    ctx.fillRect(gx,gy,1.25,1.25);
   }
  }
 }

 private drawColumnHeaders(ctx:CanvasRenderingContext2D){
  ctx.save();
  ctx.font=`600 12px ${FONT_FAMILY}`;
  ctx.textAlign='center';
  ctx.textBaseline='middle';
  for(const header of this.columnHeaders){
   const text=`${header.label} · ${header.count}`;
   const tw=ctx.measureText(text).width;
   const pw=tw+20,ph=24;
   drawRoundedRect(ctx,header.x-pw/2,header.topY-ph/2,pw,ph,12);
   ctx.fillStyle='rgba(243, 240, 232, 0.92)';
   ctx.fill();
   ctx.strokeStyle='#DFD9CD';
   ctx.lineWidth=1;
   ctx.stroke();
   ctx.fillStyle=INK_SECONDARY;
   ctx.fillText(text,header.x,header.topY+0.5);
  }
  ctx.restore();
 }

 private drawClusterHulls(ctx:CanvasRenderingContext2D){
  const byKind=new Map<KnowledgeEntityKind,Point[]>();
  for(const node of this.nodes){
   const p=this.positions.get(node.id);
   if(!p)continue;
   const list=byKind.get(node.kind)??[];
   list.push(p);
   byKind.set(node.kind,list);
  }

  for(const [kind,pts] of byKind){
   if(pts.length<3)continue;
   const hull=computeConvexHull(pts);
   if(hull.length<3)continue;

   // Compute centroid to expand hull outward smoothly
   let cx=0,cy=0;
   for(const p of hull){cx+=p.x;cy+=p.y;}
   cx/=hull.length;cy/=hull.length;
   const expanded=hull.map(p=>{
    const dx=p.x-cx,dy=p.y-cy;
    const len=Math.max(1,Math.hypot(dx,dy));
    return {x:p.x+(dx/len)*36,y:p.y+(dy/len)*36};
   });

   ctx.save();
   ctx.beginPath();
   const len=expanded.length;
   for(let i=0;i<len;i++){
    const curr=expanded[i];
    const next=expanded[(i+1)%len];
    const midX=(curr.x+next.x)/2,midY=(curr.y+next.y)/2;
    if(i===0){
     const prev=expanded[len-1];
     ctx.moveTo((prev.x+curr.x)/2,(prev.y+curr.y)/2);
    }
    ctx.quadraticCurveTo(curr.x,curr.y,midX,midY);
   }
   ctx.closePath();
   ctx.fillStyle=ENTITY_HULL_FILL[kind];
   ctx.fill();
   ctx.setLineDash([5,5]);
   ctx.strokeStyle=ENTITY_HULL_STROKE[kind];
   ctx.lineWidth=1.2;
   ctx.stroke();
   ctx.restore();
  }
 }

 private drawLabels(
  ctx:CanvasRenderingContext2D,
  hasSpotlight:boolean,
  spotlightNodes:Set<string>,
  activeNode:string|null,
  activeEdge:string|null,
 ){
  const placed:Rect[]=[];

  // Priority-sorted nodes for collision-free pill labels
  const ranked=[...this.nodes].sort((a,b)=>{
   const score=(n:GraphEngineNode)=>{
    if(n.id===this.selectedNodeId)return 10000;
    if(n.id===this.hoveredNodeId)return 9500;
    if(hasSpotlight&&spotlightNodes.has(n.id))return 7000+n.degree*10;
    if(n.kind==='paper')return 2000+n.degree*15;
    return n.degree*25+n.refs.length*5;
   };
   return score(b)-score(a);
  });

  const fontSize=11.5;
  ctx.font=`500 ${fontSize}px ${FONT_FAMILY}`;
  ctx.textAlign='center';
  ctx.textBaseline='middle';

  for(const node of ranked){
   const p=this.positions.get(node.id);
   if(!p)continue;
   const isPriority=node.id===this.selectedNodeId||node.id===this.hoveredNodeId||(hasSpotlight&&spotlightNodes.has(node.id));
   if(!this.showLabels&&!isPriority)continue;
   if(hasSpotlight&&!spotlightNodes.has(node.id)&&this.nodes.length>18)continue;

   const sp=this.worldToScreen(p.x,p.y);
   const rScreen=nodeRadius(node)*this.camera.k;
   // Skip off-screen labels quickly
   if(sp.x<-140||sp.x>this.width+140||sp.y<-60||sp.y>this.height+60)continue;

   const lines=graphLabelLines(node.label);
   if(!lines.length)continue;
   const isEmphasis=node.id===this.selectedNodeId||node.id===this.hoveredNodeId;
   ctx.font=`${isEmphasis?'600':'500'} ${fontSize}px ${FONT_FAMILY}`;

   let maxW=0;
   for(const line of lines){
    const w=ctx.measureText(line).width;
    if(w>maxW)maxW=w;
   }
   const padX=7,padY=3.5,lineH=14.5;
   const boxW=maxW+padX*2;
   const boxH=lines.length*lineH+padY*2;
   const boxX=sp.x-boxW/2;
   const boxY=sp.y+rScreen+6;
   const rect:Rect={x1:boxX,y1:boxY,x2:boxX+boxW,y2:boxY+boxH};

   // Collision check (only hovered/selected bypass collision)
   if(!isEmphasis&&placed.some(existing=>rectsOverlap(existing,rect,4))){
    continue;
   }
   placed.push(rect);

   ctx.save();
   ctx.globalAlpha=!hasSpotlight||spotlightNodes.has(node.id)?1:0.28;
   drawRoundedRect(ctx,boxX,boxY,boxW,boxH,5);
   ctx.fillStyle=isEmphasis?'#FFFFFF':PILL_BG;
   ctx.fill();
   ctx.strokeStyle=isEmphasis?ENTITY_COLORS[node.kind]:PILL_BORDER;
   ctx.lineWidth=isEmphasis?1.4:0.9;
   ctx.stroke();

   ctx.fillStyle=isEmphasis?INK_PRIMARY:'#2A2F36';
   for(let li=0;li<lines.length;li++){
    ctx.fillText(lines[li],sp.x,boxY+padY+lineH*li+lineH/2);
   }
   ctx.restore();
  }

  // Edge predicate pills for hovered/selected edge or connected edges when small
  const showAllEdgePills=this.showLabels&&this.cachedEdges.length<=14&&this.camera.k>=0.65;
  ctx.font=`500 10.5px ${FONT_FAMILY}`;
  for(const geom of this.cachedEdges){
   const {edge,midX,midY}=geom;
   const isExact=activeEdge===edge.id;
   const isIncident=activeNode!==null&&(edge.source.id===activeNode||edge.target.id===activeNode);
   if(!isExact&&!(isIncident&&this.cachedEdges.length<=60)&&!showAllEdgePills)continue;

   const sp=this.worldToScreen(midX,midY);
   if(sp.x<-80||sp.x>this.width+80||sp.y<-40||sp.y>this.height+40)continue;
   const text=edge.refs.length>1
    ?`${KNOWLEDGE_RELATIONS[edge.predicate]} · ${edge.refs.length}`
    :KNOWLEDGE_RELATIONS[edge.predicate];
   const tw=ctx.measureText(text).width;
   const bw=tw+12,bh=18;
   const rect:Rect={x1:sp.x-bw/2,y1:sp.y-bh/2,x2:sp.x+bw/2,y2:sp.y+bh/2};
   if(!isExact&&placed.some(existing=>rectsOverlap(existing,rect,3)))continue;
   placed.push(rect);

   ctx.save();
   drawRoundedRect(ctx,rect.x1,rect.y1,bw,bh,9);
   ctx.fillStyle=isExact?'#244F7A':'rgba(255, 255, 254, 0.94)';
   ctx.fill();
   ctx.strokeStyle=isExact?'#244F7A':'#D5CFC3';
   ctx.lineWidth=1;
   ctx.stroke();
   ctx.fillStyle=isExact?'#FFFFFF':INK_SECONDARY;
   ctx.fillText(text,sp.x,sp.y+0.5);
   ctx.restore();
  }

  // Floating full-title tooltip above hovered node or hovered edge
  if(this.hoveredNodeId){
   const node=this.nodeById.get(this.hoveredNodeId);
   const p=node?this.positions.get(node.id):undefined;
   if(node&&p){
    const sp=this.worldToScreen(p.x,p.y);
    const kindLabel=KNOWLEDGE_ENTITIES[node.kind];
    const title=`[${kindLabel}] ${node.label} · ${node.refs.length} 条依据`;
    this.drawTooltip(ctx,sp.x,sp.y-nodeRadius(node)*this.camera.k-12,title,ENTITY_COLORS[node.kind]);
   }
  }else if(this.hoveredEdgeId){
   const edge=this.edgeById.get(this.hoveredEdgeId);
   if(edge){
    const sp=this.worldToScreen(this.pointerWorld.x,this.pointerWorld.y);
    const title=`${edge.source.label} · ${KNOWLEDGE_RELATIONS[edge.predicate]} · ${edge.target.label}（${edge.refs.length} 条依据）`;
    this.drawTooltip(ctx,sp.x,sp.y-14,title,EDGE_HIGHLIGHT);
   }
  }
 }

 private drawTooltip(ctx:CanvasRenderingContext2D,anchorX:number,anchorY:number,text:string,accent:string){
  ctx.save();
  ctx.font=`500 12px ${FONT_FAMILY}`;
  const clipped=text.length>78?text.slice(0,77)+'…':text;
  const tw=ctx.measureText(clipped).width;
  const pw=tw+20,ph=28;
  let x=anchorX-pw/2;
  let y=anchorY-ph;
  x=Math.max(10,Math.min(this.width-pw-10,x));
  y=Math.max(10,y);
  drawRoundedRect(ctx,x,y,pw,ph,6);
  ctx.fillStyle='rgba(24, 27, 32, 0.94)';
  ctx.fill();
  ctx.strokeStyle=accent;
  ctx.lineWidth=1.2;
  ctx.stroke();
  ctx.fillStyle='#FAF9F6';
  ctx.textAlign='center';
  ctx.textBaseline='middle';
  ctx.fillText(clipped,x+pw/2,y+ph/2+0.5);
  ctx.restore();
 }
}
