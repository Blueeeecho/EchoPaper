/** Bibliographic PDFs, reading cards, synthesis documents, and supporting files. */
export type ResourceGroup = 'paper' | 'note' | 'summary' | 'other';
export const RESOURCE_GROUP_LABELS: Record<ResourceGroup, string> = {paper: '论文文献', note: '笔记与阅读卡', summary: '总结与报告', other: '其他资料'};
const NOTE = /\.(md|markdown|txt|tex|org|rst|docx?|rtf)$/i;
const SUMMARY = /总结|报告|综述|汇总|综合分析|整体分析|(?:^|[\s_.-])(?:summary|summaries|report|reports|review|survey|overview|synthesis|analysis|all[-_ ]?in[-_ ]?one)(?:$|[\s_.-])/i;
export function resourceGroup(name: string): ResourceGroup {
  if (/\.pdf$/i.test(name)) return 'paper';
  if (NOTE.test(name)) return SUMMARY.test(name)?'summary':'note';
  return 'other';
}
export function isResourceGroup(value: unknown): value is ResourceGroup {
  return value === 'paper' || value === 'note' || value === 'summary' || value === 'other';
}
