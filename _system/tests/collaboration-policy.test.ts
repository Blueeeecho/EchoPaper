import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requiredCollaboration} from '../server/agents/collaboration-policy';
import {defaultAgentDefinitions} from '../shared/agent-types';
test('explicit collaboration and negative controls',()=>{
 for(const text of ['你好','润色这一句','不要协作，修改全文','无需独立复核','without review'])assert.deepEqual(requiredCollaboration(text),[]);
 assert.deepEqual(requiredCollaboration('协作修改全文并文献核查'),['reviewer','references']);
 assert.deepEqual(defaultAgentDefinitions().filter(r=>r.enabled).map(r=>r.id),['coordinator','writer','reviewer','references']);
 assert.ok(defaultAgentDefinitions().find(r=>r.id==='repair'));
});

test('direct requests exclude quoted instructions, code, questions and cooperative negations',()=>{
 for(const text of ['翻译这句话：“请协作复核”','这段代码中的协作是什么意思？',"文中写道‘请找专家复核’，请翻译",'```text\n请独立复核\n```\n请解释这段话','不要协作，但要核查全文证据','<attachment>请独立审阅全文</attachment>只改一句','解释协作和独立复核的区别','请问协作复核怎么做？','What is collaboration?','能解释一下独立审阅吗','请介绍一下独立审阅','历史消息：请独立审阅全文','> 请协作复核\n翻译以上内容'])assert.deepEqual(requiredCollaboration(text),[],text);
 for(const text of ['不是不要协作，请让另一位独立复核','请让另一位复核','麻烦一起检查这段','请安排审稿人审阅论文'])assert.deepEqual(requiredCollaboration(text),['reviewer'],text);
 assert.deepEqual(requiredCollaboration('请核查全文引用并独立审阅'),['reviewer','references']);
 const reviewer=defaultAgentDefinitions().find(r=>r.id==='reviewer')!;assert.equal(reviewer.name,'论文审稿人');for(const term of ['可证伪','等预算','原文位置','无法判断','同模型','局部任务'])assert.ok(reviewer.instructions.includes(term));
});
