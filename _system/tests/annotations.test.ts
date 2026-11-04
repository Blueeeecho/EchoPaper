import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/index.ts';
import { HttpError } from '../server/security.ts';
import type { Build, BuildService, PdfAnnotation } from '../shared/types.ts';

const builds: Record<string, Build> = {
  'build-alpha': { id: 'build-alpha', projectId: 'Alpha', targetId: 'main', status: 'succeeded', createdAt: '', log: '', diagnostics: [], pdf: 'main.pdf', sourceHash: 'a'.repeat(64) },
  'build-alpha-new': { id: 'build-alpha-new', projectId: 'Alpha', targetId: 'main', status: 'succeeded', createdAt: '', log: '', diagnostics: [], pdf: 'main.pdf', sourceHash: 'b'.repeat(64) },
  'build-beta': { id: 'build-beta', projectId: 'Beta', targetId: 'main', status: 'succeeded', createdAt: '', log: '', diagnostics: [], pdf: 'main.pdf' },
  'build-supplement': { id: 'build-supplement', projectId: 'Alpha', targetId: 'supplement', status: 'succeeded', createdAt: '', log: '', diagnostics: [], pdf: 'supplement.pdf' },
  'build-failed': { id: 'build-failed', projectId: 'Alpha', targetId: 'main', status: 'failed', createdAt: '', log: '', diagnostics: [] },
};
const fakeBuilds: BuildService = {
  async get(id) { if (!builds[id]) throw new HttpError(404, 'missing build'); return builds[id]; },
  async request() { throw new Error('unused'); }, async cancel() { throw new Error('unused'); }, async list() { return []; }, async artifact() { throw new Error('unused'); }, async createSubmission() { throw new Error('unused'); }, async listSubmissions() { return []; }, async submissionArtifact() { throw new Error('unused'); }, async close() {},
};
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echopaper-annotations-'));
  await fs.mkdir(path.join(root, 'papers'));
  for (const id of ['Alpha', 'Beta']) {
    await fs.mkdir(path.join(root, 'papers', id, 'manuscript'), { recursive: true });
    await fs.writeFile(path.join(root, 'papers', id, 'manuscript', 'main.tex'), 'Unmodified source');
    await fs.writeFile(path.join(root, 'papers', id, 'project.json'), JSON.stringify({ schemaVersion: 1, id, title: id, stage: 'writing', venue: '', deadline: '', targets: [{ id: 'main', label: '主论文', main: 'manuscript/main.tex' }, { id: 'supplement', label: '补充材料', main: 'manuscript/supplement.tex' }], createdAt: '', updatedAt: '', autoCompile: true }));
  }
  const makeApp = () => createApp({ workspaceRoot: root, buildService: fakeBuilds, watch: false });
  const app = await makeApp();
  return { root, app, makeApp, cleanup: async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
const payload = { targetId: 'main', buildId: 'build-alpha', page: 2, kind: 'highlight', quote: 'Words\non two lines', rects: [{ x: .12, y: .3, width: .45, height: .02 }], comment: '' };

test('PDF annotations persist by project, target and build without changing manuscript', async () => {
  const { root, app, makeApp, cleanup } = await fixture();
  try {
    const response = await app.inject({ method: 'POST', url: '/api/projects/Alpha/annotations', payload });
    assert.equal(response.statusCode, 201, response.body);
    const annotation = response.json<PdfAnnotation>();
    assert.equal(annotation.sourceHash, 'a'.repeat(64)); assert.equal(annotation.revision, 1); assert.deepEqual(annotation.rects, payload.rects);
    const next = await app.inject({ method: 'POST', url: '/api/projects/Alpha/annotations', payload: { ...payload, buildId: 'build-alpha-new', kind: 'comment', comment: '第二次编译的备注' } });
    assert.equal(next.statusCode, 201, next.body);
    const supplement = await app.inject({ method: 'POST', url: '/api/projects/Alpha/annotations', payload: { ...payload, targetId: 'supplement', buildId: 'build-supplement' } });
    assert.equal(supplement.statusCode, 201, supplement.body);
    assert.equal((await app.inject('/api/projects/Alpha/annotations?targetId=supplement')).json().annotations.length, 1);
    assert.equal((await app.inject('/api/projects/Beta/annotations?targetId=main')).json().annotations.length, 0);
    assert.equal((await app.inject('/api/projects/Alpha/annotations?targetId=missing')).statusCode, 400);
    assert.equal(await fs.readFile(path.join(root, 'papers/Alpha/manuscript/main.tex'), 'utf8'), 'Unmodified source');
    await app.close(); const reopened = await makeApp();
    try {
      const result = (await reopened.inject('/api/projects/Alpha/annotations?targetId=main')).json();
      assert.equal(result.annotations.length, 2); assert.equal(result.revision, 3);
      assert.equal(result.annotations[0].buildId, 'build-alpha'); assert.equal(result.annotations[1].buildId, 'build-alpha-new');
    } finally { await reopened.close(); }
  } finally { await cleanup(); }
});

test('annotation revisions prevent simultaneous changes and stale deletions', async () => {
  const { app, cleanup } = await fixture();
  try {
    const created = (await app.inject({ method: 'POST', url: '/api/projects/Alpha/annotations', payload })).json<PdfAnnotation>();
    const endpoint = `/api/projects/Alpha/annotations/${created.id}`;
    const edits = await Promise.all(['first note', 'second note'].map(comment => app.inject({ method: 'PATCH', url: endpoint, payload: { expectedUpdatedAt: created.updatedAt, comment } })));
    assert.deepEqual(edits.map(edit => edit.statusCode).sort(), [200, 409]);
    const winner = edits.find(edit => edit.statusCode === 200)!.json<PdfAnnotation>();
    assert.deepEqual(edits.find(edit => edit.statusCode === 409)!.json().current, winner);
    assert.equal(winner.revision, 2); assert.notEqual(winner.updatedAt, created.updatedAt);
    assert.equal((await app.inject({ method: 'DELETE', url: `${endpoint}?expectedUpdatedAt=${encodeURIComponent(created.updatedAt)}` })).statusCode, 409);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/projects/Beta/annotations/${created.id}`, payload: { expectedUpdatedAt: winner.updatedAt, comment: 'cross-project' } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'DELETE', url: `${endpoint}?expectedUpdatedAt=${encodeURIComponent(winner.updatedAt)}` })).statusCode, 200);
    assert.equal((await app.inject('/api/projects/Alpha/annotations?targetId=main')).json().annotations.length, 0);
  } finally { await cleanup(); }
});

test('invalid PDF builds, coordinates, offsets and oversized annotation fields are rejected', async () => {
  const { app, cleanup } = await fixture();
  try {
    const invalid = [{}, { ...payload, buildId: '../build-alpha' }, { ...payload, buildId: 'build-beta' }, { ...payload, buildId: 'build-failed' }, { ...payload, page: 0 }, { ...payload, page: 1.5 }, { ...payload, kind: 'script' }, { ...payload, quote: 'x'.repeat(10001) }, { ...payload, quote: '' }, { ...payload, kind: 'comment', comment: '' }, { ...payload, rects: [] }, { ...payload, rects: [{ x: -1, y: 0, width: .1, height: .1 }] }, { ...payload, rects: [{ x: .9, y: 0, width: .2, height: .1 }] }, { ...payload, rects: [{ x: 0, y: 0, width: .1, height: 0 }] }, { ...payload, rects: [{ x: '0', y: 0, width: .1, height: .1 }] }, { ...payload, startOffset: 1 }, { ...payload, startOffset: 3, endOffset: 2 }, { ...payload, startOffset: -1, endOffset: 2 }, { ...payload, startOffset: .5, endOffset: 2 }, { ...payload, startOffset: 1, endOffset: 1000001 }];
    for (const candidate of invalid) {
      const response = await app.inject({ method: 'POST', url: '/api/projects/Alpha/annotations', payload: candidate });
      assert.equal(response.statusCode, 400, `${JSON.stringify(candidate)}: ${response.body}`);
    }
    const response = await app.inject({ method: 'POST', url: '/api/projects/Alpha/annotations', payload: { ...payload, kind: 'bold', startOffset: 0, endOffset: 22 } });
    assert.equal(response.statusCode, 201, response.body); assert.equal(response.json().startOffset, 0); assert.equal(response.json().endOffset, 22);
    assert.equal((await app.inject({ method: 'POST', url: '/api/projects/Alpha/annotations', headers: { origin: 'https://elsewhere.example' }, payload })).statusCode, 403);
  } finally { await cleanup(); }
});

test('annotation writes reject notes symlinks and preserve malformed existing metadata', async () => {
  const { root, app, cleanup } = await fixture();
  try {
    const outside = path.join(root, 'outside'); await fs.mkdir(outside); await fs.symlink(outside, path.join(root, 'papers/Alpha/notes'));
    assert.equal((await app.inject({ method: 'POST', url: '/api/projects/Alpha/annotations', payload })).statusCode, 403); assert.equal((await fs.readdir(outside)).length, 0);
    await fs.unlink(path.join(root, 'papers/Alpha/notes')); await fs.mkdir(path.join(root, 'papers/Alpha/notes'));
    const metadata = path.join(root, 'papers/Alpha/notes/pdf-annotations.json'); await fs.writeFile(metadata, '{broken metadata');
    const response = await app.inject({ method: 'POST', url: '/api/projects/Alpha/annotations', payload });
    assert.equal(response.statusCode, 409, response.body); assert.equal(await fs.readFile(metadata, 'utf8'), '{broken metadata');
    await fs.unlink(metadata); await fs.writeFile(path.join(outside, 'metadata.json'), '{}'); await fs.symlink(path.join(outside, 'metadata.json'), metadata);
    assert.equal((await app.inject('/api/projects/Alpha/annotations?targetId=main')).statusCode, 403); assert.equal(await fs.readFile(path.join(outside, 'metadata.json'), 'utf8'), '{}');
  } finally { await cleanup(); }
});

test('malformed persisted annotation records return 409 without rewriting metadata', async () => {
  const { root, app, cleanup } = await fixture();
  try {
    const created = (await app.inject({ method: 'POST', url: '/api/projects/Alpha/annotations', payload })).json<PdfAnnotation>();
    const metadata = path.join(root, 'papers/Alpha/notes/pdf-annotations.json');
    for (const patch of [{ rects: [] }, { kind: 'unsupported' }, { status: 'unsupported' }, { source: { path: '../secret.tex', line: 1 } }, { updatedAt: 1 }, { createdAt: 'not-a-date' }, { revision: 0 }, { page: 10001 }, { quote: 'x'.repeat(10001) }, { comment: 'x'.repeat(20001) }, { startOffset: 10, endOffset: 2 }, { sourceHash: 'malformed' }]) {
      const content = JSON.stringify({ schemaVersion: 1, revision: 1, annotations: [{ ...created, ...patch }] });
      await fs.writeFile(metadata, content);
      const result = await app.inject('/api/projects/Alpha/annotations?targetId=main');
      assert.equal(result.statusCode, 409, `${Object.keys(patch)[0]}: ${result.body}`);
      assert.equal(await fs.readFile(metadata, 'utf8'), content);
    }
  } finally { await cleanup(); }
});

test('annotation workflow status and source anchors use version checks and reject unsafe paths', async () => {
  const { app, cleanup } = await fixture();
  try {
    const original = (await app.inject({method:'POST',url:'/api/projects/Alpha/annotations',payload})).json<PdfAnnotation>();
    const endpoint = `/api/projects/Alpha/annotations/${original.id}`;
    let response = await app.inject({method:'PATCH',url:endpoint,payload:{expectedUpdatedAt:original.updatedAt,status:'changed',source:{path:'manuscript/main.tex',line:1}}});
    assert.equal(response.statusCode,200,response.body);const changed=response.json<PdfAnnotation>();assert.equal(changed.status,'changed');assert.equal(changed.source?.line,1);
    for(const patch of [{status:'done'}, {source:{path:'../secret.tex',line:1}}, {source:{path:'notes/secret.md',line:1}}, {source:{path:'manuscript/main.tex',line:0}}]) {
      response=await app.inject({method:'PATCH',url:endpoint,payload:{expectedUpdatedAt:changed.updatedAt,...patch}});assert.equal(response.statusCode,400,response.body);
    }
    response=await app.inject({method:'PATCH',url:endpoint,payload:{expectedUpdatedAt:changed.updatedAt,status:'verified',source:null}});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().status,'verified');assert.equal(response.json().source,undefined);
  }finally{await cleanup();}
});

test('confirmed cross-version annotation migration preserves original and rejects duplicate or stale requests',async()=>{
  const {app,cleanup}=await fixture();
  try {
    const original=(await app.inject({method:'POST',url:'/api/projects/Alpha/annotations',payload:{...payload,comment:'待处理问题'}})).json<PdfAnnotation>();
    const endpoint=`/api/projects/Alpha/annotations/${original.id}/migrate`;
    const migration={confirmed:true,expectedUpdatedAt:original.updatedAt,buildId:'build-alpha-new',page:3,quote:'New candidate words',rects:[{x:.2,y:.4,width:.3,height:.02}],startOffset:20,endOffset:39};
    assert.equal((await app.inject({method:'POST',url:endpoint,payload:{...migration,confirmed:false}})).statusCode,400);
    const response=await app.inject({method:'POST',url:endpoint,payload:migration});assert.equal(response.statusCode,201,response.body);
    const {annotation,migrated,original:updated}=response.json();assert.equal(annotation.migratedFrom,original.id);assert.equal(annotation.comment,original.comment);assert.equal(annotation.buildId,'build-alpha-new');assert.deepEqual(updated.migratedTo,[annotation.id]);assert.equal(updated.buildId,'build-alpha');assert.equal(migrated,undefined);
    assert.equal((await app.inject({method:'POST',url:endpoint,payload:migration})).statusCode,409);
    assert.equal((await app.inject({method:'POST',url:endpoint,payload:{...migration,expectedUpdatedAt:updated.updatedAt}})).statusCode,409);
    assert.equal((await app.inject('/api/projects/Alpha/annotations?targetId=main')).json().annotations.length,2);
    const note=(await app.inject({method:'POST',url:'/api/projects/Alpha/annotations',payload:{...payload,kind:'comment',quote:'',comment:'位置备注'}})).json<PdfAnnotation>();
    assert.equal((await app.inject({method:'POST',url:`/api/projects/Alpha/annotations/${note.id}/migrate`,payload:{...migration,expectedUpdatedAt:note.updatedAt}})).statusCode,400);
  }finally{await cleanup();}
});

test('annotation lists export correct build only and reject cross-project or unsupported formats',async()=>{
  const {app,cleanup}=await fixture();
  try {
    await app.inject({method:'POST',url:'/api/projects/Alpha/annotations',payload:{...payload,comment:'中文备注'}});
    await app.inject({method:'POST',url:'/api/projects/Alpha/annotations',payload:{...payload,buildId:'build-alpha-new'}});
    const response=await app.inject('/api/projects/Alpha/annotations/export?targetId=main&buildId=build-alpha&format=json');assert.equal(response.statusCode,200,response.body);assert.equal(response.json().annotations.length,1);assert.match(response.headers['content-disposition'] as string,/annotations.json/);
    const markdown=await app.inject('/api/projects/Alpha/annotations/export?targetId=main&buildId=build-alpha&format=md');assert.match(markdown.body,/中文备注/);assert.match(markdown.body,/待处理/);
    assert.equal((await app.inject('/api/projects/Alpha/annotations/export?targetId=main&buildId=build-beta&format=json')).statusCode,400);
    assert.equal((await app.inject('/api/projects/Alpha/annotations/export?targetId=main&buildId=build-alpha&format=html')).statusCode,400);
  }finally{await cleanup();}
});
