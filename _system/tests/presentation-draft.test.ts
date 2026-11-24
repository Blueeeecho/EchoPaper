import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverableOutline, withAddedMaterials } from '../src/academic/presentationDraft';
import type { PresentationFile, PresentationJob } from '../shared/presentation-types';

const baseline: PresentationFile = {
  hash: 'old',
  document: {
    schemaVersion: 1, id: 'ppt-demo', title: 'Original title', language: 'zh', notesLanguage: 'zh', preserveExamples: true,
    styleId: 'hzau-clean', styleVersion: '1.0.0', presenter: '', advisor: '', durationMinutes: 15, targetSlides: 10,
    sources: [], slides: [], createdAt: '2026-11-21T10:00:00Z', updatedAt: '2026-11-21T10:00:00Z',
  },
};

test('importing material preserves unsaved slide content and carries the disk source snapshot', () => {
  const local = {
    ...baseline.document, title: 'Unsaved title',
    slides: [{
      id: 'new', section: '研究内容' as const, layout: 'explanation' as const, title: 'Unsaved slide', titleEn: '',
      keyMessage: '', blocks: [], notes: { purpose: '', speech: '', transition: '', questions: '' }, sourceIds: [],
    }],
  };
  const next: PresentationFile = {
    hash: 'new',
    document: {
      ...baseline.document, updatedAt: '2026-11-21T10:01:00Z',
      sources: [{ id: 'src-demo', kind: 'text', name: 'Notes', text: 'Example', hash: 'sample' }],
    },
  };
  const merged = withAddedMaterials(next, local, baseline);
  assert.equal(merged.title, local.title);
  assert.equal(merged.slides, local.slides);
  assert.equal(merged.sources, next.document.sources);
  assert.equal(merged.updatedAt, next.document.updatedAt);
  assert.equal(withAddedMaterials(next, baseline.document, baseline), next.document);
});

test('recovery requires the exact unchanged document and a recoverable outline error', () => {
  const failed: PresentationJob = {
    id: 'job-demo', presentationId: baseline.document.id, kind: 'outline', status: 'failed', phase: '处理失败',
    createdAt: baseline.document.createdAt, documentHash: baseline.hash, sourceHash: '', styleHash: '',
    error: '模型大纲未通过结构校验：Unrecognized key: "captionEn"', checks: [],
  };
  assert.equal(recoverableOutline(failed, baseline, false), failed);
  assert.equal(recoverableOutline(failed, { ...baseline, hash: 'new' }, false), undefined);
  assert.equal(recoverableOutline(failed, baseline, true), undefined);
  assert.equal(recoverableOutline({ ...failed, error: '模型输出不是完整 JSON，大纲未写入。' }, baseline, false), undefined);
});
