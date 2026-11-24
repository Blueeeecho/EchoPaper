import fs from 'node:fs/promises';
import path from 'node:path';
import type {DocumentLayout} from '../../shared/bilingual';
import {textFingerprint} from '../../shared/bilingual-cache';
import {paperTitle} from '../../shared/resource-order';
import type {Resource} from '../../shared/workspace-types';
import {assertNoSymlinks} from '../security';
import {atomicWrite} from '../storage';

export interface PaperMetadata {
  titleZh?: string;
  venue?: string;
  year?: string;
  keywords?: string[];
}

interface AnalysisBlock {
  page?: number;
  type?: string;
  role?: string;
  text?: string;
  translationKey?: string;
}

interface AnalysisCache {
  blocks?: AnalysisBlock[];
}

interface CacheEntry {
  sig: string;
  meta: PaperMetadata;
}

const CACHE_VERSION = 1;
const SAFE_ID = /^[a-zA-Z0-9_-]{1,100}$/;

const BOILERPLATE_TITLE = /^(?:open access|citation|copyright|abstract|keywords|index terms|introduction|research|research paper|original research|brief research report|article|review|how to cite|article history|reuse|graphical abstract|publisher'?s note|correspondence|highlights|contents lists available at sciencedirect)$/i;

const CONFERENCES: ReadonlyArray<readonly [string, RegExp]> = [
  ['ACL Findings', /Findings of (?:the Association for Computational Linguistics:\s*)?ACL\b|\bACL\s+Findings\b/i],
  ['EMNLP Findings', /Findings of (?:the Association for Computational Linguistics:\s*)?EMNLP\b|\bEMNLP\s+Findings\b/i],
  ['NAACL Findings', /Findings of (?:the Association for Computational Linguistics:\s*)?NAACL\b|\bNAACL\s+Findings\b/i],
  ['EACL Findings', /Findings of (?:the Association for Computational Linguistics:\s*)?EACL\b|\bEACL\s+Findings\b/i],
  ['NeurIPS', /\b(?:NeurIPS|NIPS)\b|Conference on Neural Information Processing Systems/i],
  ['ICLR', /\bICLR\b|International Conference on Learning Representations/i],
  ['ICML', /\bICML\b|International Conference on Machine Learning/i],
  ['ACL', /\bACL\b|Annual Meeting of the Association for Computational Linguistics/i],
  ['EMNLP', /\bEMNLP\b|Conference on Empirical Methods in Natural Language Processing/i],
  ['NAACL', /\bNAACL\b|North American Chapter of the Association for Computational Linguistics/i],
  ['EACL', /\bEACL\b/i],
  ['AAAI', /\bAAAI\b|AAAI Conference on Artificial Intelligence/i],
  ['IJCAI', /\bIJCAI\b|International Joint Conference on Artificial Intelligence/i],
  ['CVPR', /\bCVPR\b|Computer Vision and Pattern Recognition/i],
  ['ICCV', /\bICCV\b|International Conference on Computer Vision/i],
  ['ECCV', /\bECCV\b|European Conference on Computer Vision/i],
  ['COLM', /\bCOLM\b|Conference on Language Modeling/i],
  ['WWW', /\b(?:WWW|TheWebConf)\b|ACM Web Conference/i],
  ['KDD', /\bKDD\b|Knowledge Discovery and Data Mining/i],
  ['SIGIR', /\bSIGIR\b/i],
  ['AAMAS', /\bAAMAS\b|Autonomous Agents and Multiagent Systems/i],
  ['AISTATS', /\bAISTATS\b/i],
  ['UAI', /\bUAI\b/i],
  ['COLT', /\bCOLT\b/i],
  ['CoRL', /\bCoRL\b/i],
  ['RSS', /\bRobotics:\s*Science and Systems\b/i],
  ['ICRA', /\bICRA\b/i],
  ['IROS', /\bIROS\b/i],
  ['CHI', /\bCHI\b/i],
  ['UIST', /\bUIST\b/i],
  ['ICSE', /\bICSE\b/i],
  ['FSE', /\bFSE\b/i],
  ['ASE', /\bASE\b/i],
  ['ISSTA', /\bISSTA\b/i],
  ['CCS', /\bCCS\b/i],
  ['USENIX Security', /\bUSENIX Security\b/i],
  ['NDSS', /\bNDSS\b/i],
  ['IEEE S&P', /\bIEEE\s+S&P\b|Symposium on Security and Privacy/i],
  ['OSDI', /\bOSDI\b/i],
  ['SOSP', /\bSOSP\b/i],
  ['NSDI', /\bNSDI\b/i],
  ['VLDB', /\bVLDB\b/i],
  ['SIGMOD', /\bSIGMOD\b/i],
  ['TMLR', /\bTMLR\b|Transactions on Machine Learning Research/i],
  ['TACL', /\bTACL\b|Transactions of the Association for Computational Linguistics/i],
  ['JMLR', /\bJMLR\b|Journal of Machine Learning Research/i],
  ['TPAMI', /\bTPAMI\b/i],
  ['Nature', /\bNature\s+(?:Machine Intelligence|Communications|Methods|Biotechnology)\b/i],
];

const CONCEPT_LEXICON: ReadonlyArray<readonly [string, RegExp, ReadonlyArray<string>?]> = [
  ['多智能体', /\bmulti[- ]?agent|\bMAS\b|agent-to-agent|多智能体|多代理|多\s*agent/i, ['多 agent', '多代理']],
  ['通信拓扑', /\btopolog|\bcommunication\s+(?:graph|network|structure|protocol)|\borchestrat|\bworkflow|\bgraph\s+generat|通信拓扑|拓扑演化|拓扑进化|编排|工作流/i, ['通信拓扑与自动编排']],
  ['辩论与共识', /\bdebate|\bconsensus|\bvoting|\bvote\b|\bdeliberat|\bjudge|\bdiscussion|辩论|共识|投票/i, ['辩论、共识与推理可靠性']],
  ['协作诊断', /\bdiagnos|\bfailure|\bcollaborat(?:ion|or)\s+fail|\bbreakdown|\bhold\s+experts\s+back|\berror\s+recogni|协作失败|失败诊断|诊断研究/i, ['协作失败与协议评测']],
  ['层次记忆', /\bmemory\b|\bepisodic\s+memory|\bhierarchical\s+memory|记忆机制|层次化?记忆/i],
  ['规划与协同', /\bplanning|\bcoordinat|\btask\s+allocat|\bdelegat|\bschedul|规划|协同|任务分配/i],
  ['协议安全', /\bprotocol[- ]?aware|\bsecurity|\bsafeguard|\battack|\bdefense|\bjailbreak|\bbackdoor|\bpoison|\bsafety|安全|防护|协议安全|漏洞/i],
  ['基准评测', /\bbenchmark|\bevaluat|\bdataset|\bmetric|\baudit|基准|评测|评估/i, ['协作失败与协议评测']],
  ['自我改进', /\bself[- ]?improv|\bself[- ]?evolv|\brecursive\s+self|\bRSI\b|\bbootstrapped|\bevolving|自我改进|自演化|递归改进/i, ['RSI', '系统自演化与递归改进', '协作训练、自博弈与自我改进']],
  ['强化学习', /\breinforcement\s+learning|\bMARL\b|\bPPO\b|\bGRPO\b|\bDPO\b|\bRLHF\b|\bpolicy\s+optimi|\bcredit\s+assignment|强化学习|信用分配|奖励模型/i],
  ['知识蒸馏', /\bdistill|\bteacher[- ]?student|蒸馏/i],
  ['提示优化', /\bprompt\s+optim|\bprompt\s+rule|\bmeta[- ]?prompt|提示优化|提示词/i],
  ['思维链推理', /\bchain[- ]?of[- ]?thought|\bCoT\b|\bmeta[- ]?think|\breasoning|\btest[- ]?time\s+(?:scaling|compute)|思维链|元思考|深度推理/i, ['CoT、多样性与自我改进理论']],
  ['推理加速', /\bprefix\s+cach|\bKV[- ]?cache|\baccelerat|\blatency|\bthroughput|\befficien(?:t|cy)\s+(?:infer|serving|comm)|前缀缓存|推理效率|加速/i, ['通信表示与推理效率']],
  ['代码生成', /\bcode\s+generat|\bsoftware\s+engineering|\bprogram\s+synthesis|\bcoding\s+agent|代码生成|编程/i],
  ['工具调用', /\btool[- ]?use|\btool\s+call|\bfunction\s+call|\bMCP\b|\bA2A\b|工具调用|协议/i],
  ['检索增强', /\bretrieval[- ]?augmented|\bRAG\b|检索增强/i],
  ['知识图谱', /\bknowledge\s+graph|知识图谱/i],
  ['微调对齐', /\bfine[- ]?tun|\bLoRA\b|\balign(?:ment|ing)|微调|对齐/i],
  ['多模态', /\bmultimodal|\bvision[- ]?language|\bVLM\b|多模态|视觉语言/i],
  ['扩散生成', /\bdiffusion\b|\bscore[- ]?based|扩散模型/i],
  ['图建模', /\btemporal\s+graph|\bgraph\s+neural|\bGNN\b|时序图|图神经网络/i],
  ['智能问答', /\bquestion\s+answering|\bQA\b|\bintent\s+recogni|智能问答|问答系统|意图识别/i],
  ['智慧渔业', /\bfisher(?:y|ies)|\baquaculture|\bfish\s+(?:farm|pond|feed)|\bshrimp|\bprawn|\blarvi|\bhatchery|\bshellfish|\bbass\b|\bcatfish|\bseabream|\btambaqui|水产|渔业|养殖|对虾|沼虾|贝类|幼鱼|投喂/i],
  ['物联网', /\bIoT\b|\bsensor\s+network|物联网/i],
  ['综述', /\bsurvey\b|\breview\b|综述|研究进展/i],
];

const TITLE_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'for', 'to', 'with', 'via', 'from', 'into', 'by', 'at', 'as', 'and', 'or', 'are', 'is', 'be', 'can', 'do', 'does', 'when', 'how', 'why', 'what', 'which',
  'using', 'based', 'towards', 'toward', 'through', 'under', 'over', 'between', 'among', 'within', 'without', 'across', 'beyond',
  'study', 'paper', 'approach', 'method', 'methods', 'framework', 'system', 'systems', 'model', 'models', 'large', 'language', 'llm', 'llms', 'ai', 'new', 'novel', 'improved', 'improving',
  'effective', 'efficient', 'comprehensive', 'feasibility', 'analysis', 'design', 'implementation', 'research', 'application', 'applications', 'use', 'case', 'real', 'world', 'single', 'good', 'bad', 'make', 'yields', 'better', 'automating', 'learning', 'tracing', 'navigating', 'boosting', 'establishing', 'integrating',
]);

export function cleanDisplayTag(tag: string): string {
  return tag
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const countHan = (text: string) => text.match(/\p{Script=Han}/gu)?.length ?? 0;

interface VenueCandidate {
  venue: string;
  year?: string;
  tier: 1 | 2 | 3;
}

function parseVenueFromLine(raw: string, allowJournal: boolean): VenueCandidate | null {
  const text = cleanDisplayTag(raw || '');
  if (!text) return null;

  for (const [name, re] of CONFERENCES) {
    if (re.test(text)) {
      const year = text.match(/\b(20[12]\d)\b/)?.[1];
      return {venue: name, year, tier: 1};
    }
  }

  if (allowJournal) {
    // Chinese journals in header/footer/citation line
    const zhJournal = text.match(/([\u4e00-\u9fa5]{2,14}(?:学报|科学|杂志|研究|进展|期刊))/);
    if (zhJournal && !/基金|项目|资助|研究方向|重点实验室|工程学院|人工智能学院|研究所|大学学院|通信工程学院/.test(text)) {
      const year = text.match(/(20[12]\d)\s*[年，,.\)）]|\b(20[12]\d)\b/)?.[1] || text.match(/\b(20[12]\d)\b/)?.[1];
      return {venue: zhJournal[1], year, tier: 1};
    }
    // Frontiers in ...
    const frontiers = text.match(/\b(Frontiers in [A-Za-z][A-Za-z &]{2,45})\b/);
    if (frontiers) {
      const year = text.match(/\b(20[12]\d)\b/)?.[1];
      return {venue: frontiers[1].trim(), year, tier: 1};
    }
    // "... Journal of ..." (e.g. Turkish Journal of Fisheries & Aquatic Sciences)
    const generalJournal = text.match(/\b((?:[A-Z][A-Za-z&]+\s+){0,2}Journal\s+of\s+[A-Z][A-Za-z&\s]{2,50}?)(?=\s*(?:\(|,|\.|\d|Online|ISSN|$))/i);
    if (generalJournal && !/^(?:a|the|this)\s+journal\b/i.test(generalJournal[1])) {
      const venue = generalJournal[1].replace(/\s+/g, ' ').trim();
      if (venue.length >= 10 && venue.length <= 64) {
        const year = text.match(/\b(20[12]\d)\b/)?.[1];
        return {venue: toTitleCaseIfAllCaps(venue), year, tier: 1};
      }
    }
    // Elsevier / repository "published in <Journal>"
    const publishedIn = text.match(/published\s+in\s+([A-Z][A-Za-z&\s]{4,60}?)(?=\.|,|\s+©|\s+by\b|\s+is\b|\s*\(|$)/);
    if (publishedIn && !/^(?:Proceedings|Association|Workshop|Preprint)/i.test(publishedIn[1])) {
      const year = text.match(/\b(20[12]\d)\b/)?.[1];
      return {venue: publishedIn[1].trim(), year, tier: 1};
    }
    // Springer / Nature / Elsevier header: "Discover Computing (2025) 28:135"
    const springer = text.match(/(?:et al\.\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z&]+){0,5})\s*\((20[12]\d)\)\s*\d+/);
    if (springer && !/^(?:Preprint|Author|Copyright|Figure|Table|Page|Vol|Issue)$/i.test(springer[1])) {
      return {venue: springer[1].trim(), year: springer[2], tier: 1};
    }
    // MDPI / footer citation: "Fishes 2026, 11, 517" / "Aquac. J. 2025, 5, 15"
    const mdpi = text.match(/^([A-Z][A-Za-z.\s]{2,42}?)\s+(20[12]\d),\s*\d+(?:\(\d+\))?,\s*[e\d]+/);
    if (mdpi && !/^(?:Preprint|Received|Accepted|Published|Copyright|Page|Vol|Issue|Figure|Table)/i.test(mdpi[1])) {
      let venue = mdpi[1].trim().replace(/\.$/, '');
      if (/^Aquac\.?\s*J$/i.test(venue)) venue = 'Aquaculture Journal';
      return {venue, year: mdpi[2], tier: 1};
    }
  }

  const arxiv = text.match(/\barXiv\s*[:.]?\s*(\d{2})(\d{2})\.\d{4,5}/i);
  if (arxiv && Number(arxiv[1]) >= 12 && Number(arxiv[1]) <= 39) {
    return {venue: 'arXiv', year: `20${arxiv[1]}`, tier: 2};
  }
  const arxivZh = text.match(/(20[12]\d)\s*年(?:\s*\d{1,2}\s*月)?\s*arXiv/i);
  if (arxivZh) return {venue: 'arXiv', year: arxivZh[1], tier: 2};
  if (/\barXiv\b/i.test(text)) {
    const year = text.match(/\b(20[12]\d)\b/)?.[1];
    return {venue: 'arXiv', year, tier: 2};
  }
  if (/\bpreprint\b/i.test(text)) {
    const year = text.match(/\b(20[12]\d)\b/)?.[1];
    return {venue: 'Preprint', year, tier: 3};
  }
  return null;
}

function toTitleCaseIfAllCaps(text: string): string {
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (!letters || letters.replace(/[^A-Z]/g, '').length / letters.length < 0.7) return text;
  const small = new Set(['of', 'and', 'in', 'on', 'for', 'the', 'to', 'with', '&']);
  return text.split(/\s+/).map((w, i) => {
    const lower = w.toLowerCase();
    return i > 0 && small.has(lower) ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ');
}

export function isVenueLikeTag(tag: string): boolean {
  const cleaned = cleanDisplayTag(tag);
  if (!cleaned) return false;
  if (parseVenueFromLine(cleaned, false)) return true;
  return /^(?:20[12]\d)\s*(?:年.*)?(?:arXiv|预印本|preprint)$/i.test(cleaned);
}

export function extractVenueYear(input: {
  tags?: string[];
  metaLines?: string[];
  filename?: string;
}): {venue?: string; year?: string} {
  let best: VenueCandidate | null = null;
  let fallbackYear = '';

  const consider = (candidate: VenueCandidate | null) => {
    if (!candidate) return;
    if (!best) { best = candidate; return; }
    if (candidate.tier < best.tier) { best = candidate; return; }
    if (candidate.tier === best.tier) {
      if (!best.year && candidate.year) best = {...best, year: candidate.year};
      else if (best.venue === candidate.venue && !best.year && candidate.year) best = candidate;
    }
  };

  for (const tag of input.tags ?? []) {
    consider(parseVenueFromLine(tag, false));
  }
  for (const line of input.metaLines ?? []) {
    consider(parseVenueFromLine(line, true));
    if (!fallbackYear) {
      const y = line.match(/(?:published|accepted|copyright|©|vol\.|期|\(|^|\s)(20[12]\d)\b/i)?.[1]
        || line.match(/\b(20[12]\d)\b/)?.[1];
      if (y) fallbackYear = y;
    }
  }
  const fn = input.filename || '';
  const fnArx = fn.match(/(?:^|[^0-9])(\d{2})(\d{2})\.\d{4,5}(?:v\d+)?/);
  if (fnArx && Number(fnArx[1]) >= 15 && Number(fnArx[1]) <= 35) {
    consider({venue: 'arXiv', year: `20${fnArx[1]}`, tier: 2});
  }
  if (!fallbackYear) {
    fallbackYear = fn.match(/(?:^|[^0-9])(20[12]\d)(?:[^0-9]|$)/)?.[1] || '';
  }

  const resolved = best as VenueCandidate | null;
  const venue = resolved?.venue;
  const year = resolved?.year || fallbackYear || undefined;
  return {...(venue ? {venue} : {}), ...(year ? {year} : {})};
}

function tokenOverlap(a: string, b: string): number {
  const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\p{Script=Han}]+/gu, ' ').split(' ').filter(w => w.length >= 2));
  const sa = tokens(a), sb = tokens(b);
  if (!sa.size || !sb.size) return 0;
  let hits = 0;
  for (const w of sa) if (sb.has(w)) hits++;
  return hits / Math.max(sa.size, sb.size);
}

export function extractTranslatedTitle(input: {
  originalTitle: string;
  analysis?: AnalysisCache | null;
  translations?: Record<string, string> | null;
}): string | undefined {
  const original = input.originalTitle.trim();
  if (!original || countHan(original) >= 4) return undefined;
  const blocks = input.analysis?.blocks;
  const translations = input.translations;
  if (!blocks?.length || !translations) return undefined;

  const lookup = (block: AnalysisBlock): string | undefined => {
    const direct = block.translationKey ? translations[block.translationKey] : undefined;
    if (typeof direct === 'string' && direct.trim()) return direct;
    if (!block.text) return undefined;
    const fp = textFingerprint('zh-CN', block.text);
    for (const [key, value] of Object.entries(translations)) {
      if (typeof value === 'string' && value.trim() && key.endsWith(`|${fp}`)) return value;
    }
    return undefined;
  };

  const candidates = blocks.filter(b =>
    (b.page ?? 0) === 0
    && (b.role === 'doc_title' || b.type === 'title')
    && typeof b.text === 'string'
    && b.text.trim().length >= 8
    && !BOILERPLATE_TITLE.test(b.text.replace(/^#+\s*/, '').trim()),
  );
  if (!candidates.length) return undefined;

  let bestBlock = candidates[0];
  let bestScore = -1;
  for (const b of candidates) {
    const cleanText = (b.text || '').replace(/^#+\s*/, '').trim();
    const score = tokenOverlap(original, cleanText) + (b.role === 'doc_title' ? 0.25 : 0);
    if (score > bestScore) { bestScore = score; bestBlock = b; }
  }

  const rawZh = lookup(bestBlock);
  if (!rawZh) return undefined;
  const cleaned = rawZh
    .replace(/^#+\s*/, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (countHan(cleaned) < 2) return undefined;
  if (cleaned.toLowerCase() === original.toLowerCase()) return undefined;
  return cleaned;
}

function extractExplicitAuthorKeywords(blocks: Array<{type?: string; text?: string}>): string[] {
  const results: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const raw = (blocks[i].text || '').trim();
    if (!raw) continue;
    let kwLine = '';
    if (/^(?:KEYWORDS|Keywords|Index Terms|关键词)\s*$/i.test(raw) && blocks[i + 1]?.text) {
      kwLine = blocks[i + 1].text || '';
    } else {
      const m = raw.match(/(?:^|\n)\s*(?:Keywords|Index Terms|Key\s*words|关键词)\s*[:：—-]\s*([^\n]{3,240})/i);
      if (m) kwLine = m[1];
    }
    if (!kwLine) continue;
    kwLine = kwLine
      .replace(/中图分类号.*$/s, '')
      .replace(/文献标志码.*$/s, '')
      .replace(/\bdoi\s*:.*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const parts = kwLine.split(/[;；,，、·\n]+/).map(s => s.replace(/^[•\-–—\s]+|[.\s]+$/g, '').trim());
    for (const part of parts) {
      if (part.length >= 2 && part.length <= 28 && !/^\d+$/.test(part) && !isVenueLikeTag(part)) {
        results.push(part);
      }
    }
    if (results.length) break;
  }
  return results;
}

export function extractPaperKeywords(input: {
  tags?: string[];
  title: string;
  titleZh?: string;
  abstractText?: string;
  authorKeywords?: string[];
  max?: number;
}): string[] {
  const max = input.max ?? 4;
  const out: string[] = [];
  const seenLower = new Set<string>();

  const add = (kw: string) => {
    const clean = cleanDisplayTag(kw);
    if (!clean || clean.length < 2 || clean.length > 36) return;
    if (isVenueLikeTag(clean)) return;
    const key = clean.toLowerCase();
    if (seenLower.has(key)) return;
    seenLower.add(key);
    out.push(clean);
  };

  // 1. Preserve user's non-venue tags first
  for (const tag of input.tags ?? []) add(tag);
  if (out.length >= max) return out.slice(0, max);

  // 2. Explicit author keywords from PDF if user hasn't already filled 2+ tags
  if (out.length < 2 && input.authorKeywords?.length) {
    for (const kw of input.authorKeywords) {
      add(kw);
      if (out.length >= max) return out.slice(0, max);
    }
  }

  // 3. Domain concept scoring on title (3x), titleZh (2x), abstract (1x)
  if (out.length < 3) {
    const titleText = input.title || '';
    const zhText = input.titleZh || '';
    const absText = (input.abstractText || '').slice(0, 1800);
    const existingText = out.join(' ').toLowerCase();

    const scored: Array<{label: string; score: number}> = [];
    for (const [label, re, aliases] of CONCEPT_LEXICON) {
      if (seenLower.has(label.toLowerCase())) continue;
      if (aliases?.some(alias => existingText.includes(alias.toLowerCase()))) continue;
      let score = 0;
      if (re.test(titleText)) score += 3;
      if (zhText && re.test(zhText)) score += 2;
      if (absText && re.test(absText)) score += 1;
      if (score > 0) scored.push({label, score});
    }
    scored.sort((a, b) => b.score - a.score);
    for (const item of scored) {
      add(item.label);
      if (out.length >= Math.min(max, 3)) break;
    }
  }

  // 4. Fallback salient terms from title if still < 2 keywords
  if (out.length < 2) {
    const words = (input.title || '')
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !TITLE_STOPWORDS.has(w.toLowerCase()) && !/^\d+$/.test(w));
    for (const w of words) {
      add(w);
      if (out.length >= 2) break;
    }
  }

  return out.slice(0, max);
}

async function fileStamp(filename: string): Promise<string> {
  try {
    const stat = await fs.stat(filename);
    return `${Math.trunc(stat.mtimeMs)}:${stat.size}`;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return '';
    return '';
  }
}

async function readJsonSafe<T>(filename: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function createPaperMetadataService(workspaceRoot: string) {
  const memory = new Map<string, CacheEntry>();
  let diskLoaded = false;
  let dirty = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  async function cacheFilePath() {
    return assertNoSymlinks(workspaceRoot, 'workspace/reading-layout/_paper-meta-cache.json', true);
  }

  async function ensureDiskLoaded() {
    if (diskLoaded) return;
    diskLoaded = true;
    try {
      const file = await cacheFilePath();
      const parsed = await readJsonSafe<{version?: number; entries?: Record<string, CacheEntry>}>(file);
      if (parsed?.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object') {
        for (const [id, entry] of Object.entries(parsed.entries)) {
          if (entry && typeof entry.sig === 'string' && entry.meta && typeof entry.meta === 'object') {
            memory.set(id, entry);
          }
        }
      }
    } catch { /* ignore unreadable cache */ }
  }

  function scheduleSave() {
    if (saveTimer) return;
    dirty = true;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      if (!dirty) return;
      dirty = false;
      void (async () => {
        try {
          const file = await cacheFilePath();
          await fs.mkdir(path.dirname(file), {recursive: true});
          const entries = Object.fromEntries(memory.entries());
          await atomicWrite(file, JSON.stringify({version: CACHE_VERSION, entries}));
        } catch { /* best-effort disk cache */ }
      })();
    }, 300);
    saveTimer.unref?.();
  }

  async function layoutPaths(id: string) {
    const base = `workspace/reading-layout/${id}`;
    return {
      layout: await assertNoSymlinks(workspaceRoot, `${base}.json`, true),
      analysis: await assertNoSymlinks(workspaceRoot, `${base}.analysis.json`, true),
      translations: await assertNoSymlinks(workspaceRoot, `${base}.translations.json`, true),
    };
  }

  async function resolveLayoutId(resource: Resource, byHash?: Map<string, Resource[]>): Promise<string> {
    if (!SAFE_ID.test(resource.id)) return resource.id;
    const own = await layoutPaths(resource.id);
    if (await fileStamp(own.layout)) return resource.id;
    if (resource.hash && byHash) {
      for (const peer of byHash.get(resource.hash) ?? []) {
        if (peer.id === resource.id || !SAFE_ID.test(peer.id)) continue;
        const peerPaths = await layoutPaths(peer.id);
        if (await fileStamp(peerPaths.layout)) return peer.id;
      }
    }
    return resource.id;
  }

  async function computeMeta(resource: Resource, byHash?: Map<string, Resource[]>): Promise<PaperMetadata> {
    if (resource.kind !== 'file' || !/\.pdf$/i.test(resource.name)) return {};
    await ensureDiskLoaded();
    const layoutId = await resolveLayoutId(resource, byHash);
    const paths = SAFE_ID.test(layoutId) ? await layoutPaths(layoutId) : null;
    const [layoutSt, analysisSt, transSt] = paths
      ? await Promise.all([fileStamp(paths.layout), fileStamp(paths.analysis), fileStamp(paths.translations)])
      : ['', '', ''];

    const title = paperTitle(resource);
    const sig = `${CACHE_VERSION}|${layoutId}|${layoutSt}|${analysisSt}|${transSt}|${title}|${resource.name}|${resource.tags.join('\u0000')}`;
    const cached = memory.get(resource.id);
    if (cached && cached.sig === sig) return cached.meta;

    const metaLines: string[] = [];
    let abstractText = '';
    let authorKeywords: string[] = [];
    let titleZh: string | undefined;

    if (paths && layoutSt) {
      const [layout, analysis, translations] = await Promise.all([
        readJsonSafe<DocumentLayout>(paths.layout),
        analysisSt ? readJsonSafe<AnalysisCache>(paths.analysis) : Promise.resolve(null),
        transSt ? readJsonSafe<Record<string, string>>(paths.translations) : Promise.resolve(null),
      ]);
      if (layout?.pages?.length) {
        const p0 = layout.pages[0]?.layouts ?? [];
        const p1 = layout.pages[1]?.layouts ?? [];
        for (const b of [...p0, ...p1]) {
          if (b.type && ['header', 'footer', 'page_footnote', 'aside_text', 'footnote'].includes(b.type) && b.text) {
            metaLines.push(b.text);
          }
        }
        // Also capture repository/copyright "published in ..." lines on page 0
        for (const b of p0) {
          if (b.text && /published\s+in\b|accepted\s+at\b|proceedings\s+of\b|conference\s+paper\s+at\b/i.test(b.text)) {
            metaLines.push(b.text);
          }
        }
        authorKeywords = extractExplicitAuthorKeywords([...p0, ...p1.slice(0, 6)]);
        abstractText = p0.filter(b => b.type === 'text' && b.text).map(b => b.text).join(' ').slice(0, 2000);
      }
      titleZh = extractTranslatedTitle({originalTitle: title, analysis, translations});
    }

    const {venue, year} = extractVenueYear({
      tags: resource.tags,
      metaLines,
      filename: resource.name,
    });

    const keywords = extractPaperKeywords({
      tags: resource.tags,
      title,
      titleZh,
      abstractText,
      authorKeywords,
    });

    const meta: PaperMetadata = {
      ...(titleZh ? {titleZh} : {}),
      ...(venue ? {venue} : {}),
      ...(year ? {year} : {}),
      ...(keywords.length ? {keywords} : {}),
    };
    memory.set(resource.id, {sig, meta});
    scheduleSave();
    return meta;
  }

  function buildHashIndex(allResources?: Resource[]): Map<string, Resource[]> | undefined {
    if (!allResources?.length) return undefined;
    const map = new Map<string, Resource[]>();
    for (const r of allResources) {
      if (!r.hash || r.kind !== 'file' || !/\.pdf$/i.test(r.name)) continue;
      let list = map.get(r.hash);
      if (!list) { list = []; map.set(r.hash, list); }
      list.push(r);
    }
    return map;
  }

  async function enrichOne(resource: Resource, allResources?: Resource[]): Promise<Resource> {
    if (resource.kind !== 'file' || !/\.pdf$/i.test(resource.name)) return resource;
    const meta = await computeMeta(resource, buildHashIndex(allResources));
    return {...resource, ...meta};
  }

  async function enrich(resources: Resource[], allResources?: Resource[]): Promise<Resource[]> {
    const byHash = buildHashIndex(allResources ?? resources);
    const results: Resource[] = new Array(resources.length);
    const BATCH = 12;
    for (let i = 0; i < resources.length; i += BATCH) {
      const slice = resources.slice(i, i + BATCH);
      const enriched = await Promise.all(slice.map(async r => {
        if (r.kind !== 'file' || !/\.pdf$/i.test(r.name)) return r;
        const meta = await computeMeta(r, byHash);
        return {...r, ...meta};
      }));
      for (let j = 0; j < enriched.length; j++) results[i + j] = enriched[j];
    }
    return results;
  }

  function close() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
  }

  return {enrich, enrichOne, computeMeta, close};
}
