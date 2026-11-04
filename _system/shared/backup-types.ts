export interface BackupFile { path: string; sha256: string; size: number; mode: number }
export interface BackupManifest { schemaVersion: 1; id: string; createdAt: string; label: string; files: BackupFile[]; directories: string[]; sourceFingerprint: string; scope: string[] }
export interface BackupSummary { id: string; createdAt: string; label: string; size: number; fileCount: number; totalBytes: number; sourceFingerprint: string }
export interface RestorePreview { backup: BackupSummary; expectedFingerprint: string; added: string[]; changed: string[]; removed: string[]; unchanged: number; truncation: boolean; counts: {added: number; changed: number; removed: number}; warning: string }
export interface RestoreResult { restored: string; safetyBackupId: string; previousDirectory: string; restartRequired: true }
