import type { PresentationDocument, PresentationFile, PresentationJob } from '../../shared/presentation-types';

export function withAddedMaterials(next: PresentationFile, local?: PresentationDocument, baseline?: PresentationFile): PresentationDocument {
  if (!local || local === baseline?.document) return next.document;
  return { ...local, sources: next.document.sources, updatedAt: next.document.updatedAt };
}

export function recoverableOutline(job: PresentationJob | undefined, file: PresentationFile | undefined, dirty: boolean) {
  if (!file || dirty || job?.kind !== 'outline' || job.status !== 'failed' || job.documentHash !== file.hash) return undefined;
  return /模型大纲未通过结构校验|案例未与.*逐字匹配/.test(job.error || '') ? job : undefined;
}
