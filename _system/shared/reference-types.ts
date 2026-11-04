export interface ReferenceEntry { key: string; type: string; title: string; author: string; year: string; doi: string; file: string; line: number }
export interface LabelEntry { key: string; file: string; line: number; context: string }
export interface ReferenceIndex { entries: ReferenceEntry[]; labels: LabelEntry[]; warnings: string[] }
