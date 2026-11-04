import type { DeadlineSource } from './types.ts';
export interface ConferenceRound { id: string; label: string; rawDeadline: string; rawAbstractDeadline?: string; deadlineAt?: string; abstractDeadlineAt?: string; deadlineTimezone?: string; sourceTimezone: string; comment?: string; notes: string[]; unavailableReason?: string; selection?: ConferenceSelection }
export interface ConferenceEdition { id: string; title: string; description: string; year: number; ccf?: string; officialUrl?: string; date?: string; place?: string; rounds: ConferenceRound[] }
export type ConferenceRank = 'A' | 'B' | 'C' | 'all';
export interface ConferenceFilters { rank?: ConferenceRank; upcoming?: boolean; sort?: 'year' | 'deadline'; offset?: number; limit?: number }
export interface ConferenceResponse { conferences: ConferenceEdition[]; sourceUrl: string; datasetUrl: string; fetchedAt: string; stale: boolean; warning?: string; total: number; pendingCount?: number; evaluatedAt?: string; filters?: {rank: ConferenceRank; upcoming: boolean; sort: 'year' | 'deadline'}; pagination?: {offset: number; limit: number; hasMore: boolean} }
export interface ConferenceSelection { venue: string; deadlineAt: string; deadlineTimezone: string; deadlineSource: DeadlineSource }
