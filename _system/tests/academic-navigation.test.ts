import test from 'node:test';
import assert from 'node:assert/strict';
import {academicRoute,academicPath} from '../src/academic/navigation';
test('academic deep links identify paper views and standalone presentations',()=>{
 assert.deepEqual(academicRoute('#/papers/WWW/reviews'),{section:'papers',paperId:'WWW',paperView:'reviews'});
 assert.deepEqual(academicRoute('#/papers'),{section:'papers'});
 assert.deepEqual(academicRoute('#/presentations?paper=WWW'),{section:'presentations',sourcePaperId:'WWW'});
 assert.equal(academicPath(academicRoute('#/papers/WWW')),'/papers/WWW/writing');
});
test('malformed or unsafe routes fall back to the academic home',()=>{
 for(const input of ['#/papers/%2e%2e%2foutside','#/papers/%E0%A4%A','#/presentations/%2fetc','#/papers/a/b/c','#/unknown',''])assert.deepEqual(academicRoute(input),{section:'home'});
 assert.equal(academicRoute('#/papers/WWW/unknown').paperView,'writing');
});
test('selected presentation template and version survive navigation and refresh URLs',()=>{
 const path='/presentations?paper=WWW&style=hzau-clean&version=1.0.0';
 assert.deepEqual(academicRoute('#'+path),{section:'presentations',sourcePaperId:'WWW',styleId:'hzau-clean',styleVersion:'1.0.0'});
 assert.equal(academicPath(academicRoute('#'+path)),path);
 for(const path of ['/presentations?style=hzau-clean','/presentations?style=../outside&version=1.0.0'])assert.deepEqual(academicRoute(path),{section:'presentations'});
 assert.equal(academicRoute('/presentations/ppt-one?style=other&version=1.0.0').styleId,undefined);
});
