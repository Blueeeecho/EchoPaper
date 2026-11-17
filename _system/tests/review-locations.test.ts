import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewLocations} from '../src/reviewLocations';

test('review anchors preserve explicit source paths and lines without guessing prose',()=>{
 assert.deepEqual(reviewLocations('方法章节；`manuscript/tex/4a_Method.tex:28`；notes/evidence.md:7'),[{path:'manuscript/tex/4a_Method.tex',line:28},{path:'notes/evidence.md',line:7}]);
 assert.deepEqual(reviewLocations('Methods section; 第4页，第2段'),[]);
 assert.deepEqual(reviewLocations('manuscript/main.tex:3 manuscript/main.tex:3'),[{path:'manuscript/main.tex',line:3}]);
});
test('unsafe or non-source locations cannot become source navigation actions',()=>{
 for(const value of ['/etc/secret.tex:2','../secret.tex:2','manuscript/../../secret.tex','https://example.org/paper.tex:2','C:\\secret.tex:2','manuscript/main.tex:0','manuscript/main.tex:1000001','<script>alert(1)</script>'])assert.deepEqual(reviewLocations(value),[],value);
});
