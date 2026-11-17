import type { PresentationSummary } from '../../shared/presentation-types';
export function paperPresentations(summaries: PresentationSummary[], paperId?: string): PresentationSummary[] {
  return paperId ? summaries.filter(item => item.paperId === paperId) : summaries;
}
