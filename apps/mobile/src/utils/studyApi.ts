/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * 手机端书房 API 客户端
 */

import { LumaApiError } from './apiClient';

export interface StudySection {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  createdAt: number;
  inkWet: boolean;
  inkDriedAt?: number;
  hidden?: boolean;
  needsRewrite?: boolean;
  rewriteReason?: string;
  rewriteRequestedAt?: number;
  revisions: Array<{ text: string; savedAt: number }>;
  notes: Array<{ id: string; quote: string; comment: string; createdAt: number }>;
}

export interface StudyBook {
  id: string;
  title: string;
  motif: string;
  status: 'writing' | 'paused' | 'closed';
  createdAt: number;
  updatedAt: number;
  sections: StudySection[];
  currentLock?: {
    authorId: string;
    authorName: string;
    isOwner: boolean;
    expiresInSeconds: number;
  } | null;
}

export interface StudyBookSummary {
  id: string;
  title: string;
  motif: string;
  status: 'writing' | 'paused' | 'closed';
  updatedAt: number;
  sectionCount: number;
}

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

/** 获取全部书卷列表 */
export async function fetchStudyBooks(signal?: AbortSignal): Promise<StudyBookSummary[]> {
  const res = await fetch('/api/study/books', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  const data = await parseJsonResponse<{ schema: string; books: StudyBookSummary[] }>(res);
  return data.books || [];
}

/** 获取特定书卷全文 */
export async function fetchStudyBook(bookId: string, signal?: AbortSignal): Promise<StudyBook> {
  const res = await fetch(`/api/study/book?bookId=${encodeURIComponent(bookId)}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  const data = await parseJsonResponse<{ schema: string; book: StudyBook }>(res);
  return data.book;
}

/** 新建书卷 */
export async function createStudyBook(params: {
  title: string;
  motif?: string;
  firstSectionText?: string;
}): Promise<StudyBook> {
  const res = await fetch('/api/study/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await parseJsonResponse<{ ok: boolean; book: StudyBook }>(res);
  return data.book;
}

/** 使用者动笔续写下一折 */
export async function appendStudySection(params: {
  bookId: string;
  text: string;
}): Promise<{ ok: boolean; section: StudySection }> {
  const res = await fetch('/api/study/append', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(params),
  });
  return parseJsonResponse<{ ok: boolean; section: StudySection }>(res);
}

/** 划线批注 */
export async function addStudyAnnotation(params: {
  bookId: string;
  sectionId: string;
  quote: string;
  comment: string;
}): Promise<{ ok: boolean }> {
  const res = await fetch('/api/study/annotate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(params),
  });
  return parseJsonResponse<{ ok: boolean }>(res);
}

/** 提前放行墨迹风干 */
export async function markStudyInkDry(params: {
  bookId: string;
  sectionId: string;
}): Promise<{ ok: boolean }> {
  const res = await fetch('/api/study/mark-dry', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(params),
  });
  return parseJsonResponse<{ ok: boolean }>(res);
}

/** 使用者修改润色自己的手稿（未被他人接写前） */
export async function submitStudyRevision(params: {
  bookId: string;
  sectionId: string;
  revisedText: string;
}): Promise<{ ok: boolean; section: StudySection }> {
  const res = await fetch('/api/study/revision', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(params),
  });
  return parseJsonResponse<{ ok: boolean; section: StudySection }>(res);
}

/** 掌柜隐藏/取消隐藏指定段落（作者与后续接写不读） */
export async function setStudySectionHidden(params: {
  bookId: string;
  sectionId: string;
  hidden: boolean;
}): Promise<{ ok: boolean; section: StudySection }> {
  const res = await fetch('/api/study/section-hidden', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(params),
  });
  return parseJsonResponse<{ ok: boolean; section: StudySection }>(res);
}

/** 掌柜驳回指定段落要求重写 */
export async function requestStudySectionRewrite(params: {
  bookId: string;
  sectionId: string;
  reason?: string;
}): Promise<{ ok: boolean; section: StudySection }> {
  const res = await fetch('/api/study/section-rewrite', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(params),
  });
  return parseJsonResponse<{ ok: boolean; section: StudySection }>(res);
}

/** 掌柜取消驳回重写 */
export async function cancelStudySectionRewrite(params: {
  bookId: string;
  sectionId: string;
}): Promise<{ ok: boolean; section: StudySection }> {
  const res = await fetch('/api/study/cancel-rewrite', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(params),
  });
  return parseJsonResponse<{ ok: boolean; section: StudySection }>(res);
}
