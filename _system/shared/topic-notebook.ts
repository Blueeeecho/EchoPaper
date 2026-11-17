/** Per-topic thinking space: ideas/hypotheses/questions and the few key papers. */
export type IdeaKind = 'idea' | 'hypothesis' | 'question' | 'todo';
export const IDEA_KIND_LABELS: Record<IdeaKind, string> = {idea: '想法', hypothesis: '假设', question: '疑问', todo: '待验证'};
export interface TopicIdea {id: string; kind: IdeaKind; text: string; createdAt: string; updatedAt: string; done?: boolean}
export interface KeyReference {resourceId: string; note: string; addedAt: string}
export interface TopicNotebook {version: 1; topicId: string; ideas: TopicIdea[]; keyRefs: KeyReference[]}
export function emptyTopicNotebook(topicId: string): TopicNotebook {return {version: 1, topicId, ideas: [], keyRefs: []};}
export function validTopicNotebook(value: unknown, topicId: string): value is TopicNotebook {
  const v = value as TopicNotebook;
  if (!v || v.version !== 1 || v.topicId !== topicId || !Array.isArray(v.ideas) || !Array.isArray(v.keyRefs) || v.ideas.length > 5000 || v.keyRefs.length > 500) return false;
  const kinds = new Set(Object.keys(IDEA_KIND_LABELS));
  return v.ideas.every(i => i && typeof i.id === 'string' && i.id.length <= 100 && kinds.has(i.kind) && typeof i.text === 'string' && i.text.length <= 20000 && typeof i.createdAt === 'string' && typeof i.updatedAt === 'string' && (i.done === undefined || typeof i.done === 'boolean'))
    && v.keyRefs.every(r => r && typeof r.resourceId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(r.resourceId) && typeof r.note === 'string' && r.note.length <= 2000 && typeof r.addedAt === 'string');
}
