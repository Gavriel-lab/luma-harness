export interface StorePaths {
  dir: string;
  dataFile: string;
  backupFile: string;
}

/** 读取四态：missing=首次使用，ok=有效，corrupt=存在但坏，unreadable=读不了 */
export type ReadState = 'missing' | 'ok' | 'corrupt' | 'unreadable';

export interface WriteResult {
  ok: boolean;
  /** 是否真的落盘了。skipped 绝不能被当成“当前状态已保存” */
  applied: boolean;
  skipped?: boolean;
  backupWritten?: boolean;
  backupFailed?: boolean;
  reason?: string;
}

export declare class DataStore {
  constructor(userDataRoot: string);
  dir: string;
  file: string;
  backupFile: string;
  primaryValid: boolean;
  paths(): StorePaths;
  read(): { ok: boolean; state: ReadState; raw: string | null; reason?: string };
  beginSession(sessionId: string): { ok: boolean; sessionId: string };
  save(payload: string, revision?: number, sessionId?: string): Promise<WriteResult>;
  flush(): Promise<void>;
  backupRaw(raw: string, stamp?: number): Promise<{ ok: boolean; applied: boolean; path?: string; reason?: string }>;
  readBackup(): { ok: boolean; usable: boolean; raw?: string | null; reason?: string };
  restoreBackupToPrimary(sessionId?: string, revision?: number): Promise<{ ok: boolean; applied: boolean; reason?: string }>;
}

export declare function looksLikeValidAppData(raw: string): boolean;
export declare function replaceFile(dir: string, payload: string): Promise<{ ok: boolean; reason?: string }>;
export declare const DATA_DIR_NAME: string;
export declare const DATA_FILE: string;
export declare const BACKUP_FILE: string;
export declare const TEMP_FILE: string;