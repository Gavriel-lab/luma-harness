/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * 日记馆 API 客户端
 */

import {
  DiaryBooksResponse,
  DiaryCatalogResponse,
  DiaryEntryResponse,
  DiaryJobResponse,
  DiarySettingsResponse,
  DiaryBook,
  DiaryCatalogItem,
  DiaryEntryDetail,
  DiaryJobStatus,
  DiarySettings,
} from '../types/diary';
import { LumaApiError } from './apiClient';

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    throw new LumaApiError(
      '检测到 Cloudflare Access 登录认证页面，请重新登录认证后再试。',
      'authentication_required',
      false,
      response.status
    );
  }

  let text = '';
  try {
    text = await response.text();
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new LumaApiError(`无法读取网络响应数据: ${errorMsg}`, 'network_error', true);
  }

  if (text.trim().toLowerCase().startsWith('<!doctype') || text.trim().toLowerCase().startsWith('<html')) {
    throw new LumaApiError(
      'Cloudflare Access 会话已过期，需要登录。',
      'authentication_required',
      false,
      response.status
    );
  }

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new LumaApiError(
      `服务端返回了非 JSON 格式内容 (${response.status})`,
      'invalid_response',
      response.status >= 500
    );
  }

  if (!response.ok) {
    const errInfo = data?.error || {
      code: 'request_failed',
      message: data?.message || `请求失败 (${response.status})`,
      retryable: response.status === 429 || response.status >= 500,
    };
    throw new LumaApiError(errInfo.message, errInfo.code, errInfo.retryable, response.status);
  }

  return data as T;
}

export interface OwnerJournalState {
  entry: { title: string; body: string; version: number; diaryDate: string } | null;
  catalog: { diaryDate: string; title: string }[];
}
export interface OwnerJournalDraft { date: string; title: string; body: string; baseVersion: number }

export async function fetchOwnerJournal(date: string): Promise<OwnerJournalState> {
  return parseJsonResponse<OwnerJournalState>(await fetch('/api/diary/owner?date=' + encodeURIComponent(date), { headers: { Accept: 'application/json' } }));
}
export async function saveOwnerJournal(entry: OwnerJournalDraft): Promise<OwnerJournalState> {
  return parseJsonResponse<OwnerJournalState>(await fetch('/api/diary/owner', {
    method: 'POST', headers: { 'content-type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(entry),
  }));
}

/**
 * 获取全屋日记本列表及全屋最新日记动态
 */
export async function fetchDiaryBooks(signal?: AbortSignal): Promise<{
  books: DiaryBook[];
  latestGlobal?: {
    agentId: string;
    agentName: string;
    date: string;
    title: string;
    snippet: string;
  } | null;
}> {
  const res = await fetch('/api/diary/books', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  const data = await parseJsonResponse<DiaryBooksResponse>(res);
  return {
    books: data.books || [],
    latestGlobal: data.latestGlobal || null,
  };
}

/**
 * 获取指定成员的日记日期目录
 */
export async function fetchDiaryCatalog(
  agentId: string,
  limit = 30,
  cursor?: string,
  signal?: AbortSignal
): Promise<{ entries: DiaryCatalogItem[]; nextCursor?: string | null }> {
  const params = new URLSearchParams({ agentId, limit: String(limit) });
  if (cursor) params.set('cursor', cursor);

  const res = await fetch(`/api/diary/catalog?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  const data = await parseJsonResponse<DiaryCatalogResponse>(res);
  return {
    entries: (data.entries || []).map(normalizeCatalogItem).filter((item) => item.date),
    nextCursor: data.nextCursor || null,
  };
}

/**
 * 桌面 diaryService 目录项的字段是 diaryDate / totalVersions / createdAt，
 * 手机原先只认 date / versionCount / updatedAt，两边都认，桌面不用改。
 */
function normalizeCatalogItem(raw: any): DiaryCatalogItem {
  const date = typeof raw?.date === 'string' ? raw.date : typeof raw?.diaryDate === 'string' ? raw.diaryDate : '';
  return {
    date,
    title: raw?.title || `${date} 的随笔`,
    snippet: raw?.snippet || '',
    versionCount: Number(raw?.versionCount ?? raw?.totalVersions ?? 1) || 1,
    updatedAt: raw?.updatedAt || raw?.createdAt || '',
  };
}

/**
 * 获取指定成员某一天的日记详情
 */
export async function fetchDiaryEntry(
  agentId: string,
  date: string,
  version?: number,
  signal?: AbortSignal
): Promise<DiaryEntryDetail> {
  const params = new URLSearchParams({ agentId, date });
  if (typeof version === 'number') params.set('version', String(version));

  const res = await fetch(`/api/diary/entry?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  const data = await parseJsonResponse<DiaryEntryResponse>(res);
  return data.entry;
}

/**
 * 触发异步写日记 / 补记 / 重新写
 */
export async function requestGenerateDiary(params: {
  agentId: string;
  date: string;
  promptHint?: string;
  recreate?: boolean;
}): Promise<{ jobId: string }> {
  const res = await fetch('/api/diary/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(params),
  });
  const data = await parseJsonResponse<{ schema: string; jobId: string; state: string }>(res);
  return { jobId: data.jobId };
}

/**
 * 轮询生成任务状态
 */
export async function fetchDiaryJob(jobId: string, signal?: AbortSignal): Promise<DiaryJobStatus> {
  const res = await fetch(`/api/diary/jobs/${encodeURIComponent(jobId)}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  const data = await parseJsonResponse<DiaryJobResponse>(res);
  return data.job;
}

/**
 * 获取日记馆定时调度设置
 */
export async function fetchDiarySettings(signal?: AbortSignal): Promise<DiarySettings> {
  const res = await fetch('/api/diary/settings', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  const data = await parseJsonResponse<DiarySettingsResponse>(res);
  return data.settings;
}

/**
 * 更新日记馆定时调度设置
 */
export async function saveDiarySettings(
  settings: Partial<DiarySettings>
): Promise<DiarySettings> {
  const res = await fetch('/api/diary/settings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(settings),
  });
  const data = await parseJsonResponse<DiarySettingsResponse>(res);
  return data.settings;
}
