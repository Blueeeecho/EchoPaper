import test from 'node:test';
import assert from 'node:assert/strict';
import {extractPaperKeywords, extractTranslatedTitle, extractVenueYear, isVenueLikeTag} from '../server/workspace/paper-metadata';

test('extractVenueYear resolves conferences, journals, and arXiv with tier priority', () => {
  assert.deepEqual(
    extractVenueYear({metaLines: ['Published as a conference paper at ICLR 2026', 'arXiv:2601.12345v1']}),
    {venue: 'ICLR', year: '2026'},
  );
  assert.deepEqual(
    extractVenueYear({metaLines: ['Proceedings of the 43rd International Conference on Machine Learning, Seoul, South Korea. PMLR 306, 2026.']}),
    {venue: 'ICML', year: '2026'},
  );
  assert.deepEqual(
    extractVenueYear({metaLines: ['39th Conference on Neural Information Processing Systems (NeurIPS 2025).']}),
    {venue: 'NeurIPS', year: '2025'},
  );
  assert.deepEqual(
    extractVenueYear({metaLines: ['第43卷第3期 2026年5月', '广东工业大学学报 Journal of Guangdong University of Technology']}),
    {venue: '广东工业大学学报', year: '2026'},
  );
  assert.deepEqual(
    extractVenueYear({tags: ['NeurIPS 2025，Datasets &amp; Benchmarks']}),
    {venue: 'NeurIPS', year: '2025'},
  );
  assert.deepEqual(
    extractVenueYear({filename: 'N26-010-2601.10560v1.pdf'}),
    {venue: 'arXiv', year: '2026'},
  );
  assert.equal(isVenueLikeTag('ICLR 2025'), true);
  assert.equal(isVenueLikeTag('通信拓扑与自动编排'), false);
});

test('extractTranslatedTitle ignores Frontiers boilerplate headings and skips Chinese originals', () => {
  const translated = extractTranslatedTitle({
    originalTitle: 'FMRAG: retrieval-augmented multimodal large language models for fisheries intelligence',
    analysis: {
      blocks: [
        {page: 0, type: 'title', role: 'doc_title', text: 'OPEN ACCESS', translationKey: 'k1'},
        {page: 0, type: 'title', role: 'title', text: 'FMRAG: retrieval-augmented multimodal large language models for fisheries intelligence', translationKey: 'k2'},
      ],
    },
    translations: {k1: '开放获取', k2: 'FMRAG：面向渔业智能的检索增强多模态大语言模型'},
  });
  assert.equal(translated, 'FMRAG：面向渔业智能的检索增强多模态大语言模型');

  const alreadyZh = extractTranslatedTitle({
    originalTitle: '基于知识图谱与意图识别的对虾养殖智能问答模型研究',
    analysis: {blocks: [{page: 0, type: 'title', role: 'doc_title', text: '基于知识图谱与意图识别的对虾养殖智能问答模型研究', translationKey: 'k1'}]},
    translations: {k1: '基于知识图谱与意图识别的对虾养殖智能问答模型研究'},
  });
  assert.equal(alreadyZh, undefined);
});

test('extractPaperKeywords strips venue tags, keeps user tags, and infers domain keywords for untagged papers', () => {
  const fromTags = extractPaperKeywords({
    tags: ['多 agent', 'ICLR 2025', '通信拓扑与自动编排', 'NeurIPS 2025，Datasets &amp; Benchmarks'],
    title: 'AFlow: Automating Agentic Workflow Generation',
  });
  assert.ok(fromTags.includes('多 agent'));
  assert.ok(fromTags.includes('通信拓扑与自动编排'));
  assert.ok(!fromTags.some(k => /ICLR|NeurIPS/.test(k)));

  const inferred = extractPaperKeywords({
    tags: [],
    title: 'A2ASecBench: A Protocol-Aware Security Benchmark for Agent-to-Agent Multi-Agent Systems',
    titleZh: 'A2ASecBench：面向代理间多智能体系统的协议感知安全基准',
  });
  assert.ok(inferred.length >= 2 && inferred.length <= 4);
  assert.ok(inferred.includes('多智能体'));
  assert.ok(inferred.includes('协议安全'));
  assert.ok(inferred.includes('基准评测'));
});
