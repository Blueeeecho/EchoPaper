export const ANALYSIS_FIELDS={problem:'研究问题',innovation:'创新点',method:'方法',model:'模型',dataset:'数据集',evidence:'实验与证据',limitation:'局限'} as const;
export type AnalysisField=keyof typeof ANALYSIS_FIELDS;
export interface LiteratureFact {id:string;field:AnalysisField;entity?:string;value:string;page:number;quote:string;verified:boolean}
export interface ResearchDirection {id:string;question:string;rationale:string;experiment:string;factIds:string[]}
export interface ArticleAnalysis {resourceId:string;filename:string;sourceHash:string;pageCount:number;title:string;facts:LiteratureFact[];directions:ResearchDirection[];model:string;analyzedAt:string}
export interface LiteratureAnalysis {version:1;topicId:string;articles:ArticleAnalysis[];updatedAt:string}
export interface AnalysisFile {document:LiteratureAnalysis;hash:string|null}
export interface AnalysisPage {page:number;text:string}
