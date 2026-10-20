import { loadData, saveData, backupRecovery, validateData, type LoadResult, type StorageLike } from './storage';
import type { AppData } from '../types';

/**
 * 存储后端抽象：
 * - 浏览器：继续用 localStorage（同步）；
 * - 桌面壳：走 preload 桥，由主进程写 userData 下的版本化 JSON（异步）。
 *
 * 两种后端都必须满足：
 * 1. 异步加载完成前不得写入任何初始空数据；
 * 2. 写入顺序稳定，旧状态不能盖掉新状态；
 * 3. 损坏时暂停写入并把原文交回界面。
 */

export interface DesktopBridge {
  isDesktop: true;
  autonomy?: { presence: () => Promise<{running:string|null}> };
  onAuthoritativeMutation?: (handler: (command: import('./authorityMutations').AuthorityMutation) => Promise<{ok:boolean;applied:boolean;reason?:string}>) => () => void;
  bridge?:{
    snapshot:()=>Promise<import('../components/BridgeControls').BridgeSnapshot>;
    register:(payload:{agentId:string;executorId:string})=>Promise<{ok:boolean;reason?:string;manifestPath?:string}>;
    dispatch:(payload:{ticketId:string;taskId:string;requestId:string})=>Promise<{ok:boolean;reason?:string}>;
    cancel:(jobId:string)=>Promise<{ok:boolean;reason?:string}>;
    accept:(jobId:string)=>Promise<{ok:boolean;reason?:string}>;
    launch:(agentId:string)=>Promise<{ok:boolean;reason?:string}>;
    resume:(jobId:string)=>Promise<{ok:boolean;reason?:string}>;
    chatRoute:(agentId:string,enabled:boolean)=>Promise<{ok:boolean;reason?:string}>;
    onChanged:(handler:(snapshot:import('../components/BridgeControls').BridgeSnapshot)=>void)=>()=>void;
  };
  beginSession(sessionId: string): Promise<{ ok: boolean; seq?: number; reason?: string }>;
  load(): Promise<{ ok: boolean; state: 'missing' | 'ok' | 'corrupt' | 'unreadable'; raw: string | null; reason?: string }>;
  save(payload: string, revision: number, sessionId: string): Promise<{ ok: boolean; applied: boolean; skipped?: boolean; reason?: string }>;
  backupRaw(raw: string): Promise<{ ok: boolean; applied: boolean; path?: string; reason?: string }>;
  readBackup(): Promise<{ ok: boolean; usable: boolean; raw?: string | null; reason?: string }>;
  restoreBackup(sessionId: string, revision: number): Promise<{ ok: boolean; applied: boolean; reason?: string }>;
  paths(): Promise<{ dir: string; dataFile: string; backupFile: string } | null>;
  exportData(payload: { suggestedName: string; content: string }): Promise<{
    ok: boolean;
    applied?: boolean;
    canceled?: boolean;
    filePath?: string;
    reason?: string;
  }>;
  onCloseRequest(handler: (requestId: string) => Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string }): () => void;
  onCloseFailed(handler: (reason: string) => void): () => void;
  discardAndClose(): Promise<{ ok: boolean; reason?: string }>;
  credentials?: {
    set: (ref: string, key: string) => Promise<{ ok: boolean; ref?: string; hasKey?: boolean; reason?: string }>;
    delete: (ref: string) => Promise<{ ok: boolean; deleted?: boolean; reason?: string }>;
    has: (ref: string) => Promise<boolean>;
    isAvailable: () => Promise<boolean>;
  };
  attachments?: {
    importFile: (input: { name: string; dataBase64: string }) => Promise<{ ok: boolean; attachment?: import('../types').MessageAttachment; reason?: string }>;
    preview: (id: string, full?: boolean) => Promise<{ ok: boolean; kind?: 'image' | 'text'; dataUrl?: string; text?: string; truncated?: boolean; reason?: string }>;
    exportFile: (id: string) => Promise<{ ok: boolean; canceled?: boolean; reason?: string }>;
  };
  chat?: {
    startStream: (params: {
      requestId: string;
      conversationId: string;
      targetAgentId: string | null;
      profile: any;
      /** 工单 08-R2：渲染端不再提交上下文消息，恒为空数组；上下文由主进程权威组装 */
      messages: any[];
      mode?: 'direct' | 'living-room';
      targetAgentName?: string;
      participants?: string[];
      publicRecentMessages?: any[];
      /** 工单 08-R2：本轮文本与过去请求重试边界 */
      currentText?: string;
      cutoffTime?: number;
      extraMemoryGatewayMemories?: string[];
      /** 工单 08-R3：本轮自身消息不重复进入历史/召回 */
      excludeMessageIds?: string[];
    }) => Promise<{ ok: boolean; reason?: string }>;
    stopStream: (requestId: string) => Promise<{ ok: boolean; reason?: string; error?: string; unconfirmed?: boolean }>;
    testConnection: (profile: any) => Promise<{ success: boolean; latencyMs?: number; error?: string; timestamp: string }>;
    onStreamChunk: (handler: (data: { requestId: string; conversationId: string; delta: string }) => void) => () => void;
    onStreamDone: (handler: (data: { requestId: string; conversationId: string }) => void) => () => void;
    onStreamError: (handler: (data: { requestId: string; conversationId: string; error: string }) => void) => () => void;
    onStreamStopped: (handler: (data: { requestId: string; conversationId: string; reason?: string; error?: string; unconfirmed?: boolean }) => void) => () => void;
    onCodexThreadBound?: (handler: (data: { conversationId: string; threadId: string; instructionSources?: string[]; profileId?: string; verifiedAt?: string; agentId?: string; canonicalThreadId?: string }) => void) => () => void;
    onMemoryReceipt?: (handler: (data: { requestId: string; conversationId: string; targetAgentId: string; receipt: any; updatedCheckpoints?: any[] }) => void) => () => void;
  };
  codex?: {
    listModels: () => Promise<any[]>;
  };
  models?: {
    fetch: (params: { agentId?: string; profileId?: string }) => Promise<{
      ok: boolean;
      provider?: string;
      models?: Array<{
        id: string;
        name: string;
        context_length?: number;
        pricing?: { prompt?: string; completion?: string } | null;
        description?: string;
      }>;
      truncated?: boolean;
      error?: string;
    }>;
  };
  memoryGateway?: {
    checkHealth: (baseUrl?: string, credentialRef?: string) => Promise<{ ok: boolean; status?: number; data?: any; error?: string }>;
    recall: (params: { conversationId?: string; namespace: string; query: string; k?: number; top_k?: number }) => Promise<{ success: boolean; memories?: any[]; error?: string }>;
    ingest: (params: { conversationId: string; namespace: string; messages: any[] }) => Promise<{ success: boolean; ingested?: number; messageIds?: string[]; error?: string }>;
    search: (params: { namespace?: string; namespaces?: string[]; query: string; limit?: number; top_k?: number }) => Promise<{ success: boolean; results?: any[]; error?: string }>;
  };
  cloudSync?: {
    getStatus: () => Promise<any>;
    login: (credentials: any) => Promise<any>;
    logout: () => Promise<any>;
    syncNow: () => Promise<any>;
    onSyncState: (handler: (state: any) => void) => () => void;
  };
  memory?: {
    ownerReadById?: (params: { memoryId: string }) => Promise<any>;
    readById: (params: { memberId?: string; memoryId: string; conversationId?: string }) => Promise<any>;
    resolveConflict: (params: {
      memoryId: string;
      choice: 'keep_local' | 'keep_remote' | 'merge';
      seenRemoteRevision: number;
      seenHomeCommitSeq?: number;
      resolvedContent?: string;
      memberId?: string;
    }) => Promise<any>;
  };
}

declare global {
  interface Window {
    xiaowuDesktop?: DesktopBridge;
    xiaowu?: DesktopBridge;
  }
}

export interface SaveOutcome {
  ok: boolean;
  /** 是否真的落盘。skipped 绝不能被界面当成“已保存” */
  applied: boolean;
  reason?: string;
}

export interface BackupInfo {
  usable: boolean;
  reason?: string;
}

export interface Backend {
  kind: 'browser' | 'desktop';
  /** 桌面端每次挂载生成新 sessionId：重载后第一次修改必须能落盘 */
  beginSession(): Promise<{ sessionId: string; ok: boolean }>;
  /** 读取；桌面端区分 missing / ok / corrupt / unreadable */
  load(): Promise<LoadResult>;
  save(data: AppData, revision: number): Promise<SaveOutcome>;
  backupRaw(raw: string): Promise<{ ok: boolean; reason?: string }>;
  /** 检查最近有效副本是否可用（界面据此决定能否显示恢复入口） */
  checkBackup(): Promise<BackupInfo>;
  /** 用有效副本恢复；只有原文已安全保留后才允许调用 */
  restoreBackup(revision: number): Promise<SaveOutcome>;
  /** 导出；桌面端走系统另存为对话框，浏览器端走下载 */
  export(data: AppData, raw: string | null): Promise<{ ok: boolean; applied?: boolean; canceled?: boolean; reason?: string }>;
  describe(): Promise<string>;
  /** 关闭握手：桌面端有，浏览器端返回 null */
  onCloseRequest(handler: (requestId: string) => Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string }): (() => void) | null;
  onCloseFailed(handler: (reason: string) => void): (() => void) | null;
  discardAndClose(): Promise<{ ok: boolean; reason?: string }>;
}

export function getBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const b = window.xiaowuDesktop;
  return b && b.isDesktop ? b : null;
}

/** 把一段原始文本走统一校验，得到与浏览器端一致的 LoadResult */
export function parseRaw(raw: string | null): LoadResult {
  if (raw === null || raw === '') return { kind: 'empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'recovered', data: null, reason: '本地数据不是合法 JSON', raw };
  }
  const result = validateData(parsed);
  if (!result.ok) return { kind: 'recovered', data: null, reason: result.reason, raw };
  return { kind: 'ok', data: result.data };
}

function localStorageLike(): StorageLike | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function createBackend(): Backend {
  const bridge = getBridge();

  if (!bridge) {
    const storage = localStorageLike();
    const sid = `browser_${Math.random().toString(36).slice(2, 10)}`;
    return {
      kind: 'browser',
      beginSession: async () => ({ sessionId: sid, ok: true }),
      load: async () => loadData(storage),
      save: async (data) => {
        const r = saveData(storage, data);
        return { ok: r.ok, applied: r.ok, reason: r.reason };
      },
      backupRaw: async (raw) => {
        const r = backupRecovery(storage, raw);
        return { ok: r.ok, reason: r.reason };
      },
      checkBackup: async () => ({ usable: false, reason: '浏览器分支没有文件副本' }),
      restoreBackup: async () => ({ ok: false, applied: false, reason: '浏览器分支不支持副本恢复' }),
      export: async (data, raw) => {
        const content = raw ?? JSON.stringify(buildExportSafe(data), null, 2);
        const blob = new Blob([content], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `小屋-本地数据-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        return { ok: true, applied: true };
      },
      describe: async () => '浏览器 localStorage',
      onCloseRequest: () => null,
      onCloseFailed: () => null,
      discardAndClose: async () => ({ ok: false, reason: '浏览器分支不支持关闭桌面窗口' }),
    };
  }

  // 桌面：每次挂载一个新会话，重载后第一次修改不会被当成旧状态
  const sessionId = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

  return {
    kind: 'desktop',
    beginSession: async () => {
      const r = await bridge.beginSession(sessionId);
      return { sessionId, ok: r.ok };
    },
    load: async () => {
      try {
        const r = await bridge.load();
        if (!r.ok) {
          // 读不了 ≠ 用户同意覆盖，按损坏处理并保留保护
          return { kind: 'recovered', data: null, reason: r.reason ?? '无法读取数据文件', raw: '', unreadable: true };
        }
        if (r.state === 'missing') return { kind: 'empty' };
        if (r.state === 'corrupt') {
          return { kind: 'recovered', data: null, reason: '数据文件存在但内容损坏或为空', raw: r.raw ?? '', unreadable: false };
        }
        return parseRaw(r.raw);
      } catch (e) {
        return { kind: 'recovered', data: null, reason: `读取失败：${e instanceof Error ? e.message : '未知错误'}`, raw: '', unreadable: true };
      }
    },
    save: async (data, revision) => {
      try {
        const r = await bridge.save(JSON.stringify(data), revision, sessionId);
        return { ok: r.ok, applied: !!r.applied, reason: r.reason };
      } catch (e) {
        return { ok: false, applied: false, reason: e instanceof Error ? e.message : '写入失败' };
      }
    },
    backupRaw: async (raw) => {
      try {
        const r = await bridge.backupRaw(raw);
        return { ok: r.ok, reason: r.reason };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : '备份失败' };
      }
    },
    checkBackup: async () => {
      try {
        const r = await bridge.readBackup();
        return { usable: !!r.usable, reason: r.reason };
      } catch {
        return { usable: false, reason: '副本检查失败' };
      }
    },
    restoreBackup: async (revision) => {
      try {
        const r = await bridge.restoreBackup(sessionId, revision);
        return { ok: r.ok, applied: !!r.applied, reason: r.reason };
      } catch (e) {
        return { ok: false, applied: false, reason: e instanceof Error ? e.message : '恢复失败' };
      }
    },
    export: async (data, raw) => {
      try {
        const content = raw ?? JSON.stringify(buildExportSafe(data), null, 2);
        return await bridge.exportData({
          suggestedName: `小屋-本地数据-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`,
          content,
        });
      } catch (e) {
        return { ok: false, applied: false, reason: e instanceof Error ? e.message : '导出失败' };
      }
    },
    describe: async () => {
      try {
        const p = await bridge.paths();
        return p ? `桌面文件：${p.dataFile}` : '桌面文件（路径未知）';
      } catch {
        // 路径提示失败不阻断已读取的数据
        return '桌面文件（路径不可用）';
      }
    },
    onCloseRequest: (handler) => bridge.onCloseRequest(handler),
    onCloseFailed: (handler) => bridge.onCloseFailed(handler),
    discardAndClose: async () => {
      try { return await bridge.discardAndClose(); }
      catch (e) { return { ok: false, reason: e instanceof Error ? e.message : '退出请求失败' }; }
    },
  };
}

// 避免循环依赖：这里内联一份与 storage.buildExport 相同结构的最小实现
function buildExportSafe(data: AppData) {
  return {
    exportedAt: new Date().toISOString(),
    namespace: 'xiaowu.data.v1',
    version: data.version,
    note: '小屋本地数据导出。导出文件仅保存在本机，不经外部中转；发给真实接口的聊天内容受各成员连接设置约束。',
    data,
  };
}
