export const STAGES = ['writing', 'polishing', 'submitted', 'rebuttal', 'revision', 'accepted'] as const;
export type Stage = typeof STAGES[number];
export const STAGE_LABELS: Record<Stage, string> = { writing: '写作中', polishing: '润色中', submitted: '已投稿', rebuttal: 'Rebuttal', revision: '修回中', accepted: '已录用' };
export interface CompileTarget { id: string; label: string; main: string }
export interface DeadlineSource { sourceUrl: string; conferenceId: string; year: number; roundId: string; fetchedAt: string; officialUrl?: string; notes?: string }
export interface Project { schemaVersion: 1; id: string; title: string; stage: Stage; venue: string; deadline: string; deadlineAt?: string; deadlineTimezone?: string; deadlineSource?: DeadlineSource; targets: CompileTarget[]; createdAt: string; updatedAt: string; autoCompile: boolean; archived?:boolean; trashed?:boolean; lastEditedAt?:string }
export interface FileEntry { path: string; name: string; type: 'file' | 'directory'; size?: number }
export interface FileDocument { path: string; content: string; hash: string }
export interface Diagnostic { severity: 'error' | 'warning' | 'info'; category: 'compile' | 'reference' | 'placeholder'; message: string; file?: string; line?: number; page?: number }
export type BuildStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface Build { id: string; projectId: string; targetId: string; status: BuildStatus; createdAt: string; startedAt?: string; finishedAt?: string; sourceHash?: string; log: string; diagnostics: Diagnostic[]; pdf?: string; exitCode?: number | null; reason?: string; stale?: boolean; runId?:string; idempotencyKey?:string; expectedSourceHash?:string; expectedTargetMain?:string }
export interface HistoryEntry { hash: string; message: string; date: string }
export interface ReviewItem { id: string; reviewer: string; comment: string; response: string; location: string; status: 'open' | 'addressed' }
export interface ReviewRound { id: string; label: string; createdAt: string; targetId: string; items: ReviewItem[] }
export interface Submission { id: string; projectId: string; targetId: string; createdAt: string; buildId: string; sourceHash: string; verified: boolean; diagnostics: Diagnostic[]; archive: string }
export type PdfAnnotationKind = 'highlight' | 'comment' | 'bold' | 'italic';
export interface PdfAnnotationRect { x: number; y: number; width: number; height: number }
export type PdfAnnotationStatus = 'open' | 'changed' | 'verified';
export interface PdfAnnotationSource { path: string; line: number }
export interface PdfAnnotation { id: string; targetId: string; buildId: string; sourceHash?: string; page: number; kind: PdfAnnotationKind; status?: PdfAnnotationStatus; source?: PdfAnnotationSource; migratedFrom?: string; migratedTo?: string[]; quote: string; rects: PdfAnnotationRect[]; startOffset?: number; endOffset?: number; comment: string; createdAt: string; updatedAt: string; revision: number }
export interface WorkspaceEvent { type: 'ai.config.changed' | 'file.changed' | 'project.changed' | 'build.updated' | 'submission.created' | 'history.changed' | 'review.changed' | 'annotation.changed' | 'agent.updated' | 'editor.barrier' | 'editor.release'; projectId: string; path?: string; build?: Build; purpose?:'assistant'|'translation'|'connections'; runId?:string; barrier?:import('./agent-types').EditorBarrier }
export type EmitEvent = (event: WorkspaceEvent) => void;
export type {EditorBarrier} from './agent-types';
export interface BuildRequestOptions {runId?:string;idempotencyKey?:string;expectedSourceHash?:string;expectedTargetMain?:string}
export interface BuildService { request(projectId: string, targetId: string, options?:BuildRequestOptions): Promise<Build>; cancel(id: string): Promise<Build>; list(projectId: string): Promise<Build[]>; get(id: string): Promise<Build>; artifact(id: string, name: string): Promise<string>; createSubmission(projectId: string, targetId: string): Promise<Submission>; listSubmissions(projectId: string): Promise<Submission[]>; submissionArtifact(projectId: string, submissionId: string): Promise<string>; close(): Promise<void> }
