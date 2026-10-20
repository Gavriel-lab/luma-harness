/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * 桌面日记馆 API 客户端
 * 优先调用 window.xiaowu.diary，若在纯 Web 预览下回退到模拟数据
 */
import type { DiaryBook, DiaryCatalogItem, DiaryEntryDetail, DiarySettings } from '../types/diary';

function getBridge() {
  if (typeof window !== 'undefined') {
    const xw = (window as any).xiaowu || (window as any).xiaowuDesktop;
    if (xw && xw.diary) return xw.diary;
  }
  return null;
}

export interface OwnerJournalState {
  entry: { title: string; body: string; version: number; diaryDate: string } | null;
  catalog: { diaryDate: string; title: string }[];
}
export interface OwnerJournalDraft { date: string; title: string; body: string; baseVersion: number }

async function ownerRequest(method: string, payload: string | OwnerJournalDraft): Promise<OwnerJournalState> {
  const bridge = getBridge();
  if (typeof bridge?.[method] !== 'function') throw new Error('自己的手记写入入口尚未就绪，请更新并打开桌面小屋');
  const result = await bridge[method](payload);
  if (!result?.ok) throw new Error(result?.error || '手记尚未保存，请稍后重试');
  return result;
}
export const fetchOwnerJournal = (date: string) => ownerRequest('getOwnerJournal', date);
export const saveOwnerJournal = (entry: OwnerJournalDraft) => ownerRequest('saveOwnerJournal', entry);

export async function fetchDiaryBooks(): Promise<{
  books: DiaryBook[];
  latestGlobal?: any;
}> {
  const bridge = getBridge();
  if (bridge) {
    const res = await bridge.getBooks();
    return {
      books: (res?.books || []).map((b: any) => ({
        ...b,
        agentName: b.agentName || b.name,
        signatureColor: b.signatureColor || b.accent,
        latestDate: b.latestDate || null,
        totalEntries: b.totalEntries ?? b.entryCount ?? 0,
      })),
      latestGlobal: res?.latestGlobal || res?.latestGlobalEntry || null,
    };
  }
  return { books: [], latestGlobal: null };
}

export async function fetchDiaryCatalog(agentId: string, limit = 60): Promise<{
  entries: DiaryCatalogItem[];
  nextCursor?: string | null;
}> {
  const bridge = getBridge();
  if (bridge) {
    const res = await bridge.getCatalog(agentId, { limit });
    const list = (res?.entries || []).map((e: any) => ({
      entryId: e.entryId,
      date: e.diaryDate || e.date,
      diaryDate: e.diaryDate || e.date,
      title: e.title,
      snippet: e.snippet,
      version: e.version || 1,
      totalVersions: e.totalVersions || 1,
      createdAt: e.createdAt,
    }));
    return {
      entries: list,
      nextCursor: res?.nextCursor || null,
    };
  }
  return { entries: [], nextCursor: null };
}

export async function fetchDiaryEntry(agentId: string, dateStr: string, version?: number): Promise<DiaryEntryDetail | null> {
  const bridge = getBridge();
  if (bridge) {
    const res = await bridge.getEntry(agentId, dateStr, version);
    if (!res) return null;
    const entry = res.entry || res;
    return {
      entryId: entry.entryId,
      agentId: entry.agentId || agentId,
      agentName: entry.agentName,
      date: entry.diaryDate || entry.date || dateStr,
      diaryDate: entry.diaryDate || entry.date || dateStr,
      title: entry.title,
      body: entry.body || entry.content || '',
      content: entry.body || entry.content || '',
      version: entry.version || 1,
      versionCount: entry.versionCount || entry.totalVersions || 1,
      totalVersions: entry.totalVersions || entry.versionCount || 1,
      versions: entry.versions || entry.availableVersions || [],
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      sources: entry.sources || [],
      sourceCutoff: entry.sourceCutoff,
      modelTag: entry.modelTag,
    };
  }
  return null;
}

export async function fetchDiarySettings(): Promise<DiarySettings> {
  const bridge = getBridge();
  if (bridge) {
    const res = await bridge.getSettings();
    if (res) {
      return {
        enabled: typeof res.enabled === 'boolean' ? res.enabled : true,
        autoGenerate: typeof res.enabled === 'boolean' ? res.enabled : true,
        scheduleTime: res.scheduleTime || '23:00',
        timezone: res.timezone || 'Asia/Shanghai',
        targetAgentIds: Array.isArray(res.targetAgentIds) ? res.targetAgentIds : [],
        updatedAt: res.updatedAt,
      };
    }
  }
  return {
    enabled: true,
    autoGenerate: true,
    scheduleTime: '23:00',
    timezone: 'Asia/Shanghai',
    targetAgentIds: [],
  };
}

export async function saveDiarySettings(settings: Partial<DiarySettings>): Promise<DiarySettings> {
  const bridge = getBridge();
  if (bridge) {
    const res = await bridge.setSettings(settings);
    return {
      enabled: typeof res.enabled === 'boolean' ? res.enabled : true,
      autoGenerate: typeof res.enabled === 'boolean' ? res.enabled : true,
      scheduleTime: res.scheduleTime || '23:00',
      timezone: res.timezone || 'Asia/Shanghai',
      targetAgentIds: Array.isArray(res.targetAgentIds) ? res.targetAgentIds : [],
      updatedAt: res.updatedAt,
    };
  }
  return {
    enabled: true,
    autoGenerate: true,
    scheduleTime: settings.scheduleTime || '23:00',
    timezone: settings.timezone || 'Asia/Shanghai',
    targetAgentIds: settings.targetAgentIds || [],
  };
}
