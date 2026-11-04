import {keymap,runScopeHandlers,type EditorView,type Panel,type ViewUpdate} from '@codemirror/view';
import {Prec} from '@codemirror/state';
import {SearchQuery,search,getSearchQuery,setSearchQuery,openSearchPanel,closeSearchPanel,findNext,findPrevious,selectMatches,replaceNext,replaceAll} from '@codemirror/search';
import './editor-search.css';

const paths={search:'m21 21-4.3-4.3 M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0',up:'m6 15 6-6 6 6',down:'m6 9 6 6 6-6',close:'m6 6 12 12 M6 18 18 6',chevron:'m9 6 6 6-6 6',replace:'M4 7h12m-4-4 4 4-4 4 M20 17H8m4-4-4 4 4 4'};
function icon(name:keyof typeof paths){
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
 for(const [key,value] of Object.entries({viewBox:'0 0 24 24',width:'15',height:'15',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,value);
 const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',paths[name]);svg.append(path);return svg;
}
function element<K extends keyof HTMLElementTagNameMap>(tag:K,className:string){const node=document.createElement(tag);node.className=className;return node;}

class EditorSearchPanel implements Panel {
 readonly dom=element('div','ep-search-panel');
 readonly top=true;
 private query:SearchQuery;
 private field=element('input','ep-search-input');
 private replacement=element('input','ep-search-input');
 private count=element('span','ep-search-count');
 private options=new Map<'caseSensitive'|'wholeWord'|'regexp',HTMLButtonElement>();
 private replaceRow=element('div','ep-search-row ep-replace-row');
 private toggle:HTMLButtonElement;
 private previous:HTMLButtonElement;
 private next:HTMLButtonElement;
 private select:HTMLButtonElement;
 private replaceOne:HTMLButtonElement;
 private replaceEvery:HTMLButtonElement;
 private matches:{from:number;to:number}[]=[];
 private overflow=false;
 constructor(private view:EditorView){
  this.query=getSearchQuery(view.state);
  this.dom.setAttribute('role','search');this.dom.setAttribute('aria-label','文件内查找与替换');
  this.dom.addEventListener('keydown',event=>{
   if(event.isComposing)return;
   if(event.key==='Enter'&&(event.target===this.field||event.target===this.replacement)){
    event.preventDefault();this.commit();
    if(event.target===this.replacement&&!event.shiftKey){if(!view.state.readOnly)replaceNext(view);}
    else (event.shiftKey?findPrevious:findNext)(view);
   }else if(runScopeHandlers(view,event,'search-panel'))event.preventDefault();
  });
  const row=element('div','ep-search-row'),box=element('div','ep-search-box');
  this.toggle=this.button('展开替换','chevron',()=>{
   const expanded=this.replaceRow.hidden;this.replaceRow.hidden=!expanded;
   this.toggle.setAttribute('aria-expanded',String(expanded));this.toggle.setAttribute('aria-label',expanded?'收起替换':'展开替换');this.toggle.title=expanded?'收起替换':'展开替换';
   if(expanded)this.replacement.focus();
   view.requestMeasure();
  });
  this.toggle.setAttribute('aria-expanded','false');
  this.configureField(this.field,'查找','查找当前文件…');this.field.setAttribute('main-field','true');this.field.name='search';
  this.count.setAttribute('role','status');this.count.setAttribute('aria-live','polite');this.count.setAttribute('aria-atomic','true');
  box.append(icon('search'),this.field,this.count);
  this.previous=this.button('上一个匹配（Shift+Enter）','up',()=>{findPrevious(view);this.field.focus();});
  this.next=this.button('下一个匹配（Enter）','down',()=>{findNext(view);this.field.focus();});
  row.append(this.toggle,box,this.previous,this.next,this.button('关闭查找（Esc）','close',()=>closeSearchPanel(view)));
  const options=element('div','ep-search-options');
  for(const [key,label,symbol] of [['caseSensitive','区分大小写','Aa'],['wholeWord','全词匹配','ab'],['regexp','正则表达式','.*']] as const){
   const button=this.button(label,undefined,()=>view.dispatch({effects:setSearchQuery.of(new SearchQuery({...this.query,[key]:!this.query[key]}))}));
   const glyph=element('span','ep-search-option-glyph');glyph.textContent=symbol;
   const text=element('span','ep-search-option-label');text.textContent=label;button.append(glyph,text);button.className='ep-search-option';button.setAttribute('aria-pressed','false');options.append(button);this.options.set(key,button);
  }
  this.select=this.button('选中全部匹配',undefined,()=>{selectMatches(view);view.focus();});this.select.className='ep-search-select';this.select.textContent='选中全部';options.append(this.select);
  this.replaceRow.hidden=true;const replaceBox=element('div','ep-search-box');this.configureField(this.replacement,'替换为','替换为…');this.replacement.name='replace';replaceBox.append(icon('replace'),this.replacement);
  this.replaceOne=this.button('替换当前匹配',undefined,()=>replaceNext(view));this.replaceOne.className='ep-search-action';this.replaceOne.textContent='替换';
  this.replaceEvery=this.button('替换全部匹配',undefined,()=>replaceAll(view));this.replaceEvery.className='ep-search-action';this.replaceEvery.textContent='全部替换';
  this.replaceRow.append(replaceBox,this.replaceOne,this.replaceEvery);this.dom.append(row,this.replaceRow,options);
  this.refresh(true);
 }
 private button(label:string,glyph:keyof typeof paths|undefined,run:()=>unknown){
  const button=element('button','ep-search-icon');button.type='button';button.title=label;button.setAttribute('aria-label',label);if(glyph)button.append(icon(glyph));button.addEventListener('click',()=>run());return button;
 }
 private configureField(input:HTMLInputElement,label:string,placeholder:string){input.type='text';input.setAttribute('aria-label',label);input.placeholder=placeholder;input.spellcheck=false;input.autocomplete='off';input.addEventListener('input',()=>this.commit());}
 private commit(){
  const query=new SearchQuery({...this.query,search:this.field.value,replace:this.replacement.value});
  if(!query.eq(getSearchQuery(this.view.state)))this.view.dispatch({effects:setSearchQuery.of(query)});
 }
 private refresh(recount:boolean){
  this.query=getSearchQuery(this.view.state);
  if(this.field.value!==this.query.search)this.field.value=this.query.search;
  if(this.replacement.value!==this.query.replace)this.replacement.value=this.query.replace;
  this.options.forEach((button,key)=>button.setAttribute('aria-pressed',String(this.query[key])));
  const invalid=!!this.query.search&&!this.query.valid;
  this.field.setAttribute('aria-invalid',String(invalid));this.dom.classList.toggle('is-invalid',invalid);
  if(recount){
   this.matches=[];this.overflow=false;
   if(this.query.valid){const cursor=this.query.getCursor(this.view.state);for(let result=cursor.next();!result.done;result=cursor.next()){if(this.matches.length===10000){this.overflow=true;break;}this.matches.push(result.value);}}
  }
  const selection=this.view.state.selection.main,index=this.matches.findIndex(m=>m.from===selection.from&&m.to===selection.to),total=`${this.matches.length}${this.overflow?'+':''}`;
  this.count.textContent=invalid?'正则无效':!this.query.search?'当前文件':!this.matches.length?'无结果':index<0?`${total} 处`:`${index+1} / ${total}`;
  this.count.title=invalid?'正则表达式无效':this.query.search?`找到 ${total} 处匹配`:'仅查找当前打开的文件';
  this.count.classList.toggle('is-empty',!!this.query.search&&!this.matches.length);
  const unavailable=!this.matches.length||invalid;this.previous.disabled=this.next.disabled=this.select.disabled=unavailable;
  this.replaceOne.disabled=this.replaceEvery.disabled=unavailable||this.view.state.readOnly;this.toggle.disabled=this.view.state.readOnly;this.replacement.disabled=this.view.state.readOnly;
 }
 mount(){this.field.focus();this.field.select();}
 update(update:ViewUpdate){const query=getSearchQuery(update.state),changed=!query.eq(this.query);if(update.docChanged||update.selectionSet||changed)this.refresh(update.docChanged||changed);}
}

/** Also accept Ctrl+F on macOS, alongside the platform's standard Cmd+F. */
export const editorSearch=[search({top:true,createPanel:view=>new EditorSearchPanel(view)}),Prec.highest(keymap.of([{key:'Ctrl-f',run:openSearchPanel,scope:'editor search-panel'}]))];
