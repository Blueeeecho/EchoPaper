import test from'node:test';import assert from'node:assert/strict';
import{normalizeWorkspaceSession,normalizeEditorPosition,normalizePdfPosition,resumeFile}from'../src/workspaceSession';
test('workspace restores navigation, selected file, target and layout while rejecting unsafe paths',()=>{
 const saved={version:1,screen:'project',projectId:'WWW',view:'reviews',path:'manuscript/tex/abstract.tex',targetId:'reply',aiOpen:true,editorPercent:60};
 assert.deepEqual(normalizeWorkspaceSession(saved),saved);
 assert.equal(normalizeWorkspaceSession({...saved,screen:'library'})?.screen,'library');
 for(const path of['../other.tex','/etc/passwd','manuscript/../secret','a\\b'])assert.equal(normalizeWorkspaceSession({...saved,path})?.path,'');
 assert.equal(normalizeWorkspaceSession({...saved,projectId:'../WWW'}),undefined);
 assert.equal(normalizeWorkspaceSession({...saved,version:2}),undefined);
 assert.equal(normalizeWorkspaceSession({...saved,view:'unknown',editorPercent:100})?.view,'writing');
});
test('deleted saved files fall back to the explicit main file, never another project or folder',()=>{
 const files=[{path:'manuscript/main.tex',type:'file'},{path:'manuscript/abstract.tex',type:'file'},{path:'notes',type:'directory'}];
 assert.equal(resumeFile(files,'manuscript/abstract.tex','manuscript/main.tex'),'manuscript/abstract.tex');
 assert.equal(resumeFile(files,'gone.tex','manuscript/main.tex'),'manuscript/main.tex');
 assert.equal(resumeFile(files,'notes','manuscript/main.tex'),'manuscript/main.tex');
});
test('reading positions clamp edited source offsets and reject corrupt or nonfinite storage',()=>{
 assert.deepEqual(normalizeEditorPosition({anchor:200,head:50,top:500,left:0},80),{anchor:80,head:50,top:500,left:0});
 assert.equal(normalizeEditorPosition({anchor:NaN,head:0,top:0,left:0},80),undefined);
 assert.equal(normalizePdfPosition({page:Infinity,offset:0,top:0,zoom:1}),undefined);
 assert.deepEqual(normalizePdfPosition({page:0,offset:-.2,top:600,zoom:5}),{page:1,offset:-.2,top:600,zoom:3});
});
