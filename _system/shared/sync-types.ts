/** Coordinates use the displayed PDF page, origin at its upper-left corner. */
export interface PdfSyncLocation { page: number; x: number; y: number; width: number; height: number; sourceLine: number }
export interface PdfSyncCapability { available: boolean; method?: 'synctex-v1'; reason?: string; stale: boolean; warning?: string; files?: string[] }
export interface PdfSyncForward { locations: PdfSyncLocation[]; stale: boolean; sourceLine: number; lineDistance: number; warning?: string }
export interface PdfSyncInverse { path: string; line: number; column?: number; stale: boolean; warning?: string; location: PdfSyncLocation;alternatives?:{path:string;line:number;column?:number}[] }
