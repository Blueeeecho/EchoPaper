import {
 canonicalEntityLabel,
 knowledgeName,
 type KnowledgeEntity,
 type KnowledgeRelation,
} from '../../shared/literature-graph';
import type {ReadingTextBlock} from './reading-search';

export const EXTRACTOR_VERSION=3;

const namePattern=/^([A-Z\d][A-Za-z\d]*(?:[./_+&'’–-][A-Za-z\d]+)*\+*(?:[ \t]+[A-Z\d][A-Za-z\d]*(?:[./_+&'’–-][A-Za-z\d]+)*\+*){0,3})/;
const genericLead=/^(?:a|an|the|we|our|this|that|these|those|such|same|it|its|they|their|data|datasets?|baselines?|benchmarks?|methods?|models?|approaches?|frameworks?|systems?|pipelines?|architectures?|algorithms?|metrics?|experiments?|evaluations?|results?|scores?|tables?|tab|figures?|fig|sections?|sec|appendix|app|equations?|eq|eqn|chapters?|parts?|phases?|stages?|steps?|cases?|tasks?|rounds?|turns?|splits?|folds?|runs?|trials?|seeds?|layers?|blocks?|heads?|tokens?|prompts?|queries|inputs?|outputs?|all|both|each|every|any|some|many|most|few|other|another|different|several|various|multiple|diverse|common|standard|existing|previous|prior|recent|current|new|novel|proposed|original|raw|clean|full|whole|entire|simple|basic|general|specific|main|key|core|primary|secondary|strong|weak|best|better|worse|top|high|low|fast|slow|small|large|medium|tiny|base|single|multi|open[- ]?source|closed[- ]?source|proprietary|commercial|real[- ]?world|synthetic|human|expert|manual|automatic|random|zero[- ]?shot|few[- ]?shot|one[- ]?shot|state[- ]?of[- ]?the[- ]?art|sota|pdf|m?llms?|vlms?|lvms?|levels?|easy|medium|hard|coding|first|second|third|final|next|last|above|below|following|overall|average|mean|total|further|additional|extra|note|abstract|introduction|conclusion|discussion|related|background|overview|setup|settings?|ablation|limitation|limitations|ethics|references?|acknowledgments?)\b/i;
const structuralRef=/^(?:sec(?:tion)?|tab(?:le)?|fig(?:ure)?|eq(?:uation|n)?|alg(?:orithm)?|app(?:endix)?|step|phase|stage|case|part|chapter|prop(?:osition)?|theorem|lemma|corollary|remark|def(?:inition)?|ex(?:ample)?|exp(?:eriment)?|setting|scenario|group|split|fold|run|trial|round|turn|version|layer|block|item|row|col(?:umn)?|line|page)\s*(?:[.\-:]?\s*\d+|[A-Z](?:\.\d+)*|[IVX]+)?$/i;
const nameBoundary=/\s+(?:and|or|with|against|using|via|by|for|from|in|on|of|to|as|that|which|where|when|while|datasets?|benchmarks?|baselines?|methods?|models?|frameworks?|systems?|approaches?|algorithms?)\b/i;
const modelName=/^(?:GPT[- ]?\d|o[134](?:-mini|-preview|-pro)?\b|Qwen[- ]?\d|LlaMA[- ]?\d|Gemini[- ]?\d|Claude[- ]?\d|Gemma[- ]?\d|GLM[- ]?\d|ChatGLM[- ]?\d|Phi[- ]?\d|Kimi[- ]K|DeepSeek[- ]|Mistral[- ]|Mixtral[- ]|Yi[- ]?\d|InternLM[- ]?\d|InternVL[- ]?\d|Baichuan[- ]?\d|Command[- ]R|Falcon[- ]?\d|OLMo[- ]?\d|Vicuna[- ]|Alpaca[- ]|WizardLM[- ]|StarCoder[- ]?|CodeLlama[- ]?|DeBERTa[- ]?|RoBERTa[- ]?|Flan[- ]T5|T5[- ]|BERT[- ]|CLIP[- ]|BLIP[- ]|LLaVA[- ]|Whisper[- ]|SDXL\b)/i;
const unnamedTarget=/^(?:MAS|SA|AI|ML|DL|NLP|CV|RL|QA|IR|API|JSON|HTML|XML|SQL|GPU|CPU|TPU|RAM|VRAM|SDK|CLI|UI|UX|URL|HTTP|HTTPS|OK|YES|NO|NA|TBD|ETC|EG|IE|VS|CF|AL)$|^\d+(?:[.,%kKmMbB]+)?$|\b(?:GPUs?|CPUs?|TPUs?|A100|H100|H200|V100|A800|H800|L40S?|RTX\s*\d+)\b|-(?:style|like|based|only|free|level)$/i;
const allCapsHeader=/^[A-Z]{2,}(?:\s+[A-Z]{2,}){2,}$/;
const unasserted=/\b(?:not|never|cannot|can't|couldn't|wouldn't|could|would|might|may|should|will|plan to|intend to|leave|future work)\b[^,;]{0,28}$/i;
const zhUnasserted=/(?:没有|并未|未|不会|不能|难以|无法|未来将|计划)[^，。；]{0,12}$/;

const evaluation=/\b(?:evaluate[sd]?|evaluating|evaluation(?=\s+on\b)|test(?:s|ed|ing)?|benchmark(?:ed|ing)?)\s+([^,;:!?]{0,82}?)\bon\s+/gi;
const detachedOn=/\b(?:based|results?|statistics?|time|depending|relying|focus(?:ed|ing)?)\s*$/i;
const passiveSubject=/^(.+?)\s+(?:is|was|are|were)\s*$/i;
const comparison=/\b(?:compare[sd]?|comparing)\s+([^,;:!?]{0,82}?)\b(?:with|against|to)\s+/gi;
const baseline=/\b(?:we|this\s+(?:paper|work))\s+(?:use|include|adopt|select)\s+(.{1,90}?)\s+as\s+(?:(?:a|the|our)\s+)?(?:baselines?|benchmarks?)\b/gi;
const reporting=/\b(?:report(?:s|ed|ing)?|metrics?\s+(?:include|are)|measur(?:e[sd]?|ing)\s+(?:performance\s+)?(?:with|by|using))\s+/gi;
const measuring=/\b(?:using|measured by|in terms of)\s+/gi;
const proposesEn=/\b(?:we|this\s+(?:paper|work|study))\s+(?:propose[sd]?|introduce[sd]?|present(?:s|ed)?|develop(?:s|ed)?|design(?:s|ed)?)\s+(?:a\s+(?:(?:novel|new|unified|scalable|lightweight|simple|general|effective|efficient|end-to-end|automated|adaptive|modular|principled|training-free|zero-shot)\s+){0,2})?(?:(?:framework|method|approach|system|algorithm|model|architecture|benchmark|dataset|pipeline|tool|mechanism|technique|metric|agent|protocol)\s+(?:named|called|termed|denoted\s+as)\s+)?/gi;
const proposesNamedEn=/\b(?:named|called|termed)\s+([A-Z][A-Za-z\d]*(?:[./_+&-][A-Za-z\d]+)*)\b/g;
const addressesEn=/\b(?:(?:we|this\s+(?:paper|work|study)|our\s+(?:method|approach|framework|system|model)|([A-Z][A-Za-z\d]+(?:[._-][A-Za-z\d]+)*))\s+(?:address(?:es|ed)?|tackle[sd]?|solve[sd]?|mitigate[sd]?|alleviate[sd]?|overcome[sd]?|target(?:s|ed)?))\s+(?:the\s+)?(?:(?:problem|challenge|issue|limitation|bottleneck|task)\s+of\s+)?([^.;:!?]{5,96})/gi;
const buildsOnEn=/\b(?:(?:we|this\s+(?:paper|work)|our\s+(?:method|approach|framework|system|model)|([A-Z][A-Za-z\d]+(?:[._-][A-Za-z\d]+)*))\s+(?:(?:is|are)\s+)?(?:built?\s+(?:on|upon)(?:\s+top\s+of)?|builds?\s+(?:on|upon)(?:\s+top\s+of)?|extends?|improves?\s+upon|adapts?|inherits?\s+from|is\s+based\s+on))\s+/gi;
const outperformsEn=/\b(?:(?:consistently|significantly|substantially)\s+)?(?:outperforms?|surpass(?:es|ed)?|exceeds?|beats?|improves?\s+(?:over|upon))\s+/gi;
const prefixNamedActor=/(?:^|[\s,(;])([A-Z][A-Za-z\d]*(?:[._+-][A-Za-z\d]+)*)\s*$/;
const prefixConjunction=/\b(?:and|which|that)\s+(?:also\s+)?$/i;

// Chinese academic patterns
const zhProposes=/(?:本文|我们)(?:提出了?|设计了?|构建了?|引入了?)(?:一种|一个)?(?:名为|称为)?\s*([A-Z][A-Za-z\d._+-]{1,36}|[\u4e00-\u9fffA-Za-z\d-]{2,20}(?:方法|框架|模型|系统|算法|机制|基准|数据集))/g;
const zhAddresses=/(?:针对|为了?解决|面向|旨在缓解)\s*([^，。；：,\.;:!?]{3,36}?)(?:问题|挑战|难题|局限|瓶颈|任务)/g;
const zhBuildsOn=/(?:(?:本文(?:方法|框架|模型)?|我们(?:的方法|的框架)?|([A-Z][A-Za-z\d._+-]{1,32}))\s*)?(?:基于|改进自|扩展了?|构建于)\s*/g;
const zhOutperforms=/(?:(?:本文(?:方法|框架|模型)?|我们(?:的方法|的框架)?|([A-Z][A-Za-z\d._+-]{1,32}))\s*)?(?:显著|全面|持续)?(?:优于|超越了?|超过)\s*/g;
const zhEvaluates=/(?:在|于)\s*([A-Z][A-Za-z\d._+\s&-]{1,60}?)\s*(?:数据集|基准|模型)?上(?:进行)?(?:评测|评估|测试|验证)/g;
const zhCompares=/(?:与|同)\s*([A-Z][A-Za-z\d._+\s&-]{1,60}?)\s*(?:进行)?(?:对比|比较)/g;

const metric=/^(?:(?:the|mean|average)\s+)?(exact[\s-]+match(?:\s+accuracy)?|balanced\s+accuracy|classification\s+accuracy|top[- ]?\d+\s+accuracy|accuracy|success\s+rate|win\s+rate|pass\s+rate|macro[- ]?F1(?:[- ]score)?|micro[- ]?F1(?:[- ]score)?|F1(?:[- ]score)?|average\s+precision|recall(?:@\d+)?|precision(?:@\d+)?|ROC[- ]AUC|PR[- ]AUC|AUROC|AUPRC|AUC|BLEU(?:-\d+)?|ROUGE(?:-[L12])?|METEOR|BERTScore|CIDEr|SPICE|Pass@(?:\d+|k)|MRR|NDCG(?:@\d+)?|mAP(?:@[\d.]+)?|RMSE|MAE|MSE|PSNR|SSIM|FID|IoU|mIoU|WER|CER|perplexity|PPL|latency|throughput|solvability|completeness|non-redundancy)(?![\w-])/i;
const listSeparator=/^\s*(?:,\s*(?:and\s+)?|\band\s+|、|，|以及|和)\s*/i;
const titleAcronym=/^([A-Z][A-Za-z\d+_-]{1,28})\s*[:：]\s+\S/;
const badTitlePrefix=/^(?:abstract|introduction|background|method|methods|experiments?|results?|discussion|conclusion|references?|appendix|keywords?|acknowledgments?|table|figure|fig|section|sec|note|summary|overview|part|chapter|volume|arxiv|preprint|draft)$/i;

export function isNoisyEntity(label:string,kind:KnowledgeEntity['kind']):boolean{
 const clean=label.trim();
 if(!clean||clean.length<2||clean.length>100)return true;
 const openParens=(clean.match(/\(/g)||[]).length,closeParens=(clean.match(/\)/g)||[]).length;
 if(openParens!==closeParens)return true;
 if(/^\d+\s*\(/.test(clean)||/\(\s*\d+$/.test(clean))return true;
 if(kind==='problem'){
  if(clean.length<5||clean.length>64)return true;
  if(/^(?:this|that|these|those|the|a|an|its|their|our|such)\s+(?:problem|issue|challenge|limitation|gap|task|bottleneck|shortcoming|weakness|obstacle)s?\b/i.test(clean))return true;
  if(/^(?:it|them|this|that|these|those|all|both|many|several|various|such|earlier|previous|existing|current)\b/i.test(clean))return true;
  if(/^(?:by|from|with|for|in|on|at|to|of|as|or|and|but|while|where|when|how|what|why)\b/i.test(clean))return true;
  if(/\b(?:we|our|they|their|there\s+is|there\s+are|propose[sd]?|introduce[sd]?|present(?:s|ed)?|identify|reformulate|shown\s+to|rather\s+than)\b/i.test(clean))return true;
  if(/[—–;:]/.test(clean))return true;
  const words=clean.split(/\s+/).filter(Boolean);
  if(/^[A-Za-z0-9\s\-/]+$/.test(clean)&&(words.length<2||words.length>7))return true;
  return false;
 }
 if(kind==='metric')return false;
 if(structuralRef.test(clean))return true;
 if(genericLead.test(clean))return true;
 if(unnamedTarget.test(clean))return true;
 if(allCapsHeader.test(clean))return true;
 if(!/[A-Za-z\u4e00-\u9fff]/.test(clean))return true;
 if(/^[a-z]{1,3}$/.test(clean))return true;
 if(/^(?:et\s+al|e\.g|i\.e|vs|cf)\.?$/i.test(clean))return true;
 return false;
}

export function cleanProblemLabel(raw:string):string{
 let text=raw
  .replace(/\s+/g,' ')
  .replace(/[,，—–;；:：].*$/,'')
  .replace(/^(?:the|a|an)\s+/i,'')
  .replace(/^(?:(?:key|main|core|critical|fundamental|challenging|open|existing|long-standing|inherent|pervasive|severe)\s+){1,2}/i,'')
  .replace(/^(?:(?:problem|challenge|issue|limitation|bottleneck|task|difficulty|phenomenon)\s+of\s+)/i,'')
  .replace(/\s+(?:by|via|using|through|with|in\s+this\s+(?:paper|work|study)|in\s+order\s+to|so\s+that|which\s+is|that\s+is|whereas|while|when|without|beyond|rather\s+than)\b.*$/i,'')
  .replace(/[，,；;：:。.!?]+$/,'')
  .trim();
 if(text.length>60){
  const cut=text.slice(0,60).replace(/\s+\S*$/,'').trim();
  text=cut.length>=10?cut:text.slice(0,60).trim();
 }
 return text;
}

function readName(input:string){
 const nameInput=modelName.test(input)?input.charAt(0).toUpperCase()+input.slice(1):input;
 const candidate=namePattern.exec(nameInput)?.[1].split(nameBoundary)[0];
 if(!candidate||candidate.length<2||candidate.length>100||genericLead.test(candidate)||structuralRef.test(candidate)||!/[A-Za-z]/.test(candidate))return;
 const raw=input.slice(0,candidate.length).replace(/['’]s$/,'');
 const canonical=canonicalEntityLabel(raw);
 if(!canonical||isNoisyEntity(canonical,'method'))return;
 return {length:candidate.length,label:canonical};
}

function subject(text:string):KnowledgeEntity|undefined{
 const clean=text.trim().replace(/^(?:the|our)\s+/i,'');
 const name=readName(clean);
 if(name?.length===clean.length){
  const kind=modelName.test(name.label)?'model':'method';
  if(isNoisyEntity(name.label,kind))return;
  return {kind,label:name.label};
 }
}

function tailNames(input:string){
 let tail=input.replace(/^(?:(?:the|both|all|existing|prior|previous|recent|strong|several|multiple|various)\s+){0,2}(?:(?:following|[1-9]\d*|two|three|four|five|six|seven|eight)\s+)?(?:(?:datasets?|benchmarks?|baselines?|methods?|models?|frameworks?|systems?|approaches?)\b\s*[:(]?\s*)?/i,'');
 const names:string[]=[];
 while(names.length<8){
  const clean=tail.replace(/^(?:the|both)\s+/i,'');
  const name=readName(clean);
  if(!name)break;
  names.push(name.label);
  const rest=clean.slice(name.length).replace(/^\s*\b(?:datasets?|benchmarks?|baselines?|methods?|models?)\b/i,'');
  const separator=listSeparator.exec(rest);
  if(!separator)break;
  tail=rest.slice(separator[0].length);
 }
 return names;
}

function tailMetrics(input:string){
 const labels:string[]=[];
 let tail=input;
 while(labels.length<6){
  const match=metric.exec(tail);
  if(!match)break;
  labels.push(metricName(match[1]));
  const separator=listSeparator.exec(tail.slice(match[0].length));
  if(!separator)break;
  tail=tail.slice(match[0].length+separator[0].length);
 }
 return labels;
}

function metricName(raw:string){
 const label=raw.replace(/\s+/g,' ').replace(/^f1(?:[- ]score)?$/i,'F1').replace(/^exact[- ]match/i,'Exact match');
 if(/^(?:auroc|roc[- ]auc)$/i.test(label))return 'ROC-AUC';
 if(/^(?:auprc|pr[- ]auc)$/i.test(label))return 'PR-AUC';
 if(/^bertscore$/i.test(label))return 'BERTScore';
 if(/^cider$/i.test(label))return 'CIDEr';
 if(/^miou$/i.test(label))return 'mIoU';
 if(/^(?:pass|recall|precision)@/i.test(label)||label.includes(' ')||/^[a-z-]{6,}$/i.test(label)){
  return label.charAt(0).toUpperCase()+label.slice(1).toLowerCase();
 }
 return label.toUpperCase();
}

function excerpt(translation?:string){
 return translation&&translation.length>1000?translation.slice(0,1000).trimEnd()+'…':translation;
}

const isUnasserted=(quote:string,index:number)=>unasserted.test(quote.slice(Math.max(0,index-40),index))||zhUnasserted.test(quote.slice(Math.max(0,index-20),index));

/** Extract explicit academic relations (proposals, problems, lineage, superiority, evaluation, comparison, metrics). */
export function extractKnowledgeRelations(blocks:ReadingTextBlock[],options?:{title?:string}):KnowledgeRelation[]{
 const relations=new Map<string,KnowledgeRelation>();
 const addRelation=(
  predicate:KnowledgeRelation['predicate'],
  kind:KnowledgeEntity['kind'],
  labels:string[],
  page:number,
  sentence:string,
  translation?:string,
  actor?:KnowledgeEntity,
 )=>{
  for(const rawLabel of labels){
   const label=kind==='problem'?cleanProblemLabel(rawLabel):canonicalEntityLabel(rawLabel,kind);
   if(!label||isNoisyEntity(label,kind))continue;
   if(actor?.kind===kind&&knowledgeName(actor.label)===knowledgeName(label))continue;
   const key=JSON.stringify([predicate,actor&&knowledgeName(actor.label),kind,knowledgeName(label)]);
   if(!relations.has(key)){
    relations.set(key,{predicate,subject:actor,object:{kind,label},page,quote:sentence,translation,source:'local'});
   }
  }
 };

 // Optional title acronym detection (e.g. "RVProbe: Probing Reasoning Verification...")
 if(options?.title&&blocks.length){
  const match=titleAcronym.exec(options.title.trim());
  if(match&&!badTitlePrefix.test(match[1])&&!isNoisyEntity(match[1],'method')){
   const firstPage=blocks[0]?.page||1;
   addRelation('proposes','method',[match[1]],firstPage,options.title.trim(),excerpt(blocks[0]?.translations?.[0]));
  }
 }

 for(const block of blocks){
  const text=block.text.replace(/\s+/g,' ').trim();
  const blockTranslation=excerpt(block.translations?.[0]);

  // Detect title-style acronym at top of page 1 if not already added
  if(block.page===1&&text.length>=16&&text.length<=240){
   const m=titleAcronym.exec(text);
   if(m&&!badTitlePrefix.test(m[1])&&!isNoisyEntity(m[1],'method')&&!/\b(?:evaluation|results|experiments|table|figure)\b/i.test(m[1])){
    addRelation('proposes','method',[m[1]],block.page,text,blockTranslation);
   }
  }

  for(const quote of text.match(/[^!?。！？]+?(?:[.!?。！？](?=\s|$)|$)/g)??[]){
   const sentence=quote.trim();
   if(sentence.length>650||sentence.length<15)continue;
   const add=(predicate:KnowledgeRelation['predicate'],kind:KnowledgeEntity['kind'],labels:string[],actor?:KnowledgeEntity)=>
    addRelation(predicate,kind,labels,block.page,sentence,blockTranslation,actor);

   // 1. Evaluation (evaluates_on, evaluates_with_model, measures_with)
   for(const match of sentence.matchAll(evaluation)){
    if(isUnasserted(sentence,match.index)||detachedOn.test(match[1]))continue;
    const passive=passiveSubject.exec(sentence.slice(0,match.index)),actor=subject(match[1])??(passive?subject(passive[1]):undefined);
    const tail=sentence.slice(match.index+match[0].length);
    const names=tailNames(tail).filter(name=>!unnamedTarget.test(name));
    for(const name of names){
     const measure=metric.exec(name);
     if(measure?.[0]===name)add('measures_with','metric',[metricName(measure[1])],actor);
     else if(modelName.test(name))add('evaluates_with_model','model',[name],actor);
     else if(!/^(?:\d+[.\d]*\s+){2,}\d/.test(tail.slice(tail.indexOf(name)+name.length).trim())){
      add('evaluates_on','dataset',[name],actor);
     }
    }
    if(names.length)for(const marker of tail.matchAll(measuring)){
     const start=match.index+match[0].length+marker.index;
     if(isUnasserted(sentence,start))continue;
     const target=sentence.slice(start+marker[0].length);
     add('measures_with','metric',tailMetrics(target),actor);
     if(/^using\b/i.test(marker[0])){
      add('evaluates_with_model','model',tailNames(target).filter(name=>modelName.test(name)),actor);
     }
    }
   }

   // 2. Comparison (compares_with)
   for(const match of sentence.matchAll(comparison)){
    if(isUnasserted(sentence,match.index))continue;
    const labels=tailNames(sentence.slice(match.index+match[0].length)),actor=subject(match[1]);
    add('compares_with','method',labels.filter(label=>!modelName.test(label)),actor);
    add('compares_with','model',labels.filter(label=>modelName.test(label)),actor);
   }
   for(const match of sentence.matchAll(baseline)){
    if(isUnasserted(sentence,match.index))continue;
    const labels=tailNames(match[1]);
    add('compares_with','method',labels.filter(label=>!modelName.test(label)));
    add('compares_with','model',labels.filter(label=>modelName.test(label)));
   }

   // 3. Metrics reporting (measures_with)
   for(const match of sentence.matchAll(reporting)){
    if(!isUnasserted(sentence,match.index))add('measures_with','metric',tailMetrics(sentence.slice(match.index+match[0].length)));
   }

   // 4. Proposes (EN)
   for(const match of sentence.matchAll(proposesEn)){
    if(isUnasserted(sentence,match.index))continue;
    const tail=sentence.slice(match.index+match[0].length);
    const isBenchmark=/\b(?:benchmark|dataset)\b/i.test(match[0]);
    const direct=readName(tail);
    if(direct&&!modelName.test(direct.label)){
     add('proposes',isBenchmark?'dataset':'method',[direct.label]);
    }else{
     const named=proposesNamedEn.exec(tail.slice(0,90));
     proposesNamedEn.lastIndex=0;
     if(named){
      const clean=canonicalEntityLabel(named[1]);
      if(clean&&!isNoisyEntity(clean,'method'))add('proposes',isBenchmark?'dataset':'method',[clean]);
     }
    }
   }

   // 5. Addresses (EN)
   for(const match of sentence.matchAll(addressesEn)){
    if(isUnasserted(sentence,match.index))continue;
    const actor=match[1]?subject(match[1]):undefined;
    const problem=cleanProblemLabel(match[2]);
    if(problem&&problem.split(/\s+/).length>=2&&!isNoisyEntity(problem,'problem')){
     add('addresses','problem',[problem],actor);
    }
   }

   // 6. Builds on (EN)
   for(const match of sentence.matchAll(buildsOnEn)){
    if(isUnasserted(sentence,match.index))continue;
    const actor=match[1]?subject(match[1]):undefined;
    const labels=tailNames(sentence.slice(match.index+match[0].length));
    add('builds_on','model',labels.filter(l=>modelName.test(l)),actor);
    add('builds_on','method',labels.filter(l=>!modelName.test(l)),actor);
   }

   // 7. Outperforms (EN)
   for(const match of sentence.matchAll(outperformsEn)){
    if(isUnasserted(sentence,match.index))continue;
    const prefix=sentence.slice(0,match.index);
    let actor:KnowledgeEntity|undefined;
    if(!/\bour\s+(?:method|approach|framework|system|model)\s*$/i.test(prefix)){
     const direct=prefixNamedActor.exec(prefix)?.[1];
     if(direct)actor=subject(direct);
     else if(prefixConjunction.test(prefix)){
      const lead=sentence.match(/^([A-Z][A-Za-z\d]*(?:[._+-][A-Za-z\d]+)*)\s+/)?.[1];
      if(lead)actor=subject(lead);
     }
    }
    const labels=tailNames(sentence.slice(match.index+match[0].length));
    add('outperforms','model',labels.filter(l=>modelName.test(l)),actor);
    add('outperforms','method',labels.filter(l=>!modelName.test(l)),actor);
   }

   // 8. Chinese academic clauses (ZH)
   if(/[\u4e00-\u9fff]/.test(sentence)){
    for(const match of sentence.matchAll(zhProposes)){
     if(isUnasserted(sentence,match.index))continue;
     const label=match[1].trim();
     const isBench=/(?:基准|数据集)$/.test(label);
     add('proposes',isBench?'dataset':'method',[label]);
    }
    for(const match of sentence.matchAll(zhAddresses)){
     if(isUnasserted(sentence,match.index))continue;
     const problem=match[1].trim();
     if(problem.length>=3&&problem.length<=40)add('addresses','problem',[problem]);
    }
    for(const match of sentence.matchAll(zhBuildsOn)){
     if(isUnasserted(sentence,match.index))continue;
     const actor=match[1]?subject(match[1]):undefined;
     const labels=tailNames(sentence.slice(match.index+match[0].length));
     add('builds_on','model',labels.filter(l=>modelName.test(l)),actor);
     add('builds_on','method',labels.filter(l=>!modelName.test(l)),actor);
    }
    for(const match of sentence.matchAll(zhOutperforms)){
     if(isUnasserted(sentence,match.index))continue;
     const actor=match[1]?subject(match[1]):undefined;
     const labels=tailNames(sentence.slice(match.index+match[0].length));
     add('outperforms','model',labels.filter(l=>modelName.test(l)),actor);
     add('outperforms','method',labels.filter(l=>!modelName.test(l)),actor);
    }
    for(const match of sentence.matchAll(zhEvaluates)){
     if(isUnasserted(sentence,match.index))continue;
     const labels=tailNames(match[1]);
     add('evaluates_with_model','model',labels.filter(l=>modelName.test(l)));
     add('evaluates_on','dataset',labels.filter(l=>!modelName.test(l)));
    }
    for(const match of sentence.matchAll(zhCompares)){
     if(isUnasserted(sentence,match.index))continue;
     const labels=tailNames(match[1]);
     add('compares_with','model',labels.filter(l=>modelName.test(l)));
     add('compares_with','method',labels.filter(l=>!modelName.test(l)));
    }
   }

   if(relations.size>=80)return [...relations.values()].slice(0,80);
  }
 }
 return [...relations.values()];
}
