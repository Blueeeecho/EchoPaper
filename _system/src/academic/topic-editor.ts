import type {ResearchStage,ResearchTopic} from '../../shared/workspace-types';

export type TopicEditorDraft=Pick<ResearchTopic,'title'|'description'|'paperIds'|'presentationIds'|'researchBasis'>&{stage?:ResearchStage};

// This form owns these fields only. File links, archive state and notes have other editors.
export function topicEditorPayload(draft:TopicEditorDraft,baseline?:ResearchTopic|null){
 return {title:draft.title.trim(),description:draft.description,researchBasis:draft.researchBasis||'',paperIds:[...draft.paperIds],presentationIds:[...draft.presentationIds],...(draft.stage?{stage:draft.stage}:{}),...(baseline?{expectedRevision:baseline.revision}:{})};
}
