import test from 'node:test';
import assert from 'node:assert/strict';
import {isResourceGroup,resourceGroup} from '../shared/resource-kind';

test('bibliographic PDFs remain papers even when their titles contain survey or review',()=>{
 for(const name of ['1_A Survey of Multi-Agent Systems.pdf','Review and Analysis.PDF','论文.pdf'])assert.equal(resourceGroup(name),'paper');
});

test('reading cards and notes are separated from summaries and supporting data',()=>{
 for(const name of ['B01.md','N26-001.md','逐篇阅读索引.md','检索与覆盖说明.md','README.md','reviewers.md','文献笔记.txt'])assert.equal(resourceGroup(name),'note',name);
 for(const name of ['整体分析报告.md','课题总结.docx','文献综述.markdown','weekly-report.md','analysis_notes.md','allinone.md','synthesis.rst'])assert.equal(resourceGroup(name),'summary',name);
 for(const name of ['references.bib','library.json','analysis-notes.json','summary.csv','mechanism-matrix.tsv','tools.py','figure.png','notebook.ipynb'])assert.equal(resourceGroup(name),'other',name);
 assert.ok(isResourceGroup('summary'));assert.equal(isResourceGroup('reading'),false);
});
