/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GetMembersResponse,
  GetConversationsResponse,
  GetMessagesResponse,
  SendChatRequest,
  SendChatResponse,
  ChatJobDto,
  ApiError,
  MemberDto,
  MessageDto,
  MemoryDto,
  GetMemoriesResponse,
  SaveMemoryRequest,
  SaveMemoryResponse,
  SyncStatusResponse,
  GetMemoryGardenResponse,
  GetMemoryGardenDetailResponse,
  GetMemoryGardenRelatedResponse,
  GetMomentsResponse,
  PostMomentRequest,
  PostMomentResponse,
  ToggleLikeResponse,
  CommentMomentRequest,
  CommentMomentResponse,
} from '../types';

export class LumaApiError extends Error {
  code: string;
  retryable: boolean;
  status?: number;

  constructor(message: string, code = 'unknown_error', retryable = false, status?: number) {
    super(message);
    this.name = 'LumaApiError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export async function deleteChatMessage(conversationId: string, messageId: string, mode: 'hide' | 'purge', part?: string): Promise<void> {
  const response=await fetch('/api/messages/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({conversationId,messageId,mode,...(part?{part}:{})})});
  const result=await parseJsonResponse<{ok:boolean;saved:boolean}>(response);
  if(!result.ok||!result.saved)throw new Error('删除尚未保存，请重试');
}

/**
 * 校验响应是否被 Cloudflare Access 拦截并重定向成了 HTML 登录页
 */
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

  // 再次双重防御 HTML 返回
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
    const errInfo: ApiError = data?.error || {
      code: mapHttpStatusToCode(response.status),
      message: data?.message || `请求失败 (${response.status})`,
      retryable: response.status === 429 || response.status >= 500,
    };
    throw new LumaApiError(errInfo.message, errInfo.code, errInfo.retryable, response.status);
  }

  return data as T;
}

function mapHttpStatusToCode(status: number): string {
  switch (status) {
    case 401:
      return 'authentication_required';
    case 403:
      return 'forbidden';
    case 409:
      return 'conflicting_request';
    case 429:
      return 'quota_exhausted';
    case 503:
      return 'house_offline';
    default:
      return status >= 500 ? 'server_error' : 'request_failed';
  }
}

/**
 * 获取正式小屋成员状态列表
 * GET /api/members
 */
export async function fetchMembers(signal?: AbortSignal): Promise<MemberDto[]> {
  const res = await fetch('/api/members', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    signal,
  });

  const data = await parseJsonResponse<GetMembersResponse>(res);
  return data.members || [];
}

/**
 * 获取官方会话列表
 * GET /api/conversations
 */
export async function fetchConversations(signal?: AbortSignal): Promise<GetConversationsResponse['conversations']> {
  const res = await fetch('/api/conversations', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    signal,
  });

  const data = await parseJsonResponse<GetConversationsResponse>(res);
  return data.conversations || [];
}

/**
 * 获取指定会话的历史真实消息
 * GET /api/messages?conversationId=...&after=...
 */
export async function fetchMessages(
  conversationId: string,
  after?: string,
  signal?: AbortSignal
): Promise<MessageDto[]> {
  const url = new URL('/api/messages', window.location.origin);
  url.searchParams.set('conversationId', conversationId);
  if (after) {
    url.searchParams.set('after', after);
  }

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    signal,
  });

  const data = await parseJsonResponse<GetMessagesResponse>(res);
  return data.messages || [];
}

/**
 * 提交聊天任务并返回 Job ID
 * POST /api/chat
 */
export async function postChatJob(
  request: SendChatRequest,
  signal?: AbortSignal
): Promise<SendChatResponse> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(request),
    signal,
  });

  return await parseJsonResponse<SendChatResponse>(res);
}

/**
 * 轮询聊天任务结果
 * GET /api/chat/jobs/:jobId
 * CLI 有长延迟，设定轮询上限。若中止，仅停止等候，不重复执行。
 */
export async function pollChatJob(
  jobId: string,
  maxAttempts = 40,
  intervalMs = 1500,
  signal?: AbortSignal,
  onProgress?: () => Promise<void>
): Promise<ChatJobDto> {
  let attempts = 0;

  while (attempts < maxAttempts) {
    if (signal?.aborted) {
      throw new LumaApiError('已停止等待任务结果', 'aborted', true);
    }

    attempts++;
    const res = await fetch(`/api/chat/jobs/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal,
    });

    const job = await parseJsonResponse<ChatJobDto>(res);

    if (job.state === 'done') {
      return job;
    }

    if (job.state === 'failed') {
      const err = job.error || {
        code: 'chat_job_failed',
        message: '远端成员执行任务失败',
        retryable: true,
      };
      throw new LumaApiError(err.message, err.code, err.retryable);
    }

    // 仍在 queued 或 doing，等待下一次轮询
    await onProgress?.();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new LumaApiError('任务执行时间较长，已达到轮询上限，请稍后刷新会话', 'timeout', true);
}

/**
 * 获取小屋记忆列表
 * GET /api/memories?scopeType=...&scopeId=...
 */
export async function fetchMemories(
  scopeType?: string,
  scopeId?: string,
  signal?: AbortSignal
): Promise<MemoryDto[]> {
  const url = new URL('/api/memories', window.location.origin);
  if (scopeType) url.searchParams.set('scopeType', scopeType);
  if (scopeId) url.searchParams.set('scopeId', scopeId);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    signal,
  });

  const data = await parseJsonResponse<GetMemoriesResponse>(res);
  return data.memories || [];
}

/**
 * 保存/编辑小屋记忆
 * POST /api/memories
 */
export async function saveMemoryApi(
  request: SaveMemoryRequest,
  signal?: AbortSignal
): Promise<SaveMemoryResponse> {
  const res = await fetch('/api/memories', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(request),
    signal,
  });

  return await parseJsonResponse<SaveMemoryResponse>(res);
}

/**
 * 获取云端同步状态
 * GET /api/sync-status
 */
export async function fetchSyncStatus(signal?: AbortSignal): Promise<SyncStatusResponse> {
  const res = await fetch('/api/sync-status', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    signal,
  });

  return await parseJsonResponse<SyncStatusResponse>(res);
}

/**
 * 调用 Fish Audio 生成自然语音条
 * POST /api/tts
 */
export { fetchTtsVoice } from './speechApi';

/**
 * 获取蔷薇记忆花园轻量目录
 * GET /api/memory-garden
 */
export async function fetchMemoryGarden(
  params?: { cursor?: string; limit?: number },
  signal?: AbortSignal
): Promise<GetMemoryGardenResponse> {
  const url = new URL('/api/memory-garden', window.location.origin);
  if (params?.cursor) url.searchParams.set('cursor', params.cursor);
  if (params?.limit) url.searchParams.set('limit', String(params.limit));

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });

  return await parseJsonResponse<GetMemoryGardenResponse>(res);
}

/**
 * 获取蔷薇记忆详情全文
 * GET /api/memory-garden/detail?key=...
 */
export async function fetchMemoryGardenDetail(
  key: string,
  signal?: AbortSignal
): Promise<GetMemoryGardenDetailResponse['detail']> {
  const url = new URL('/api/memory-garden/detail', window.location.origin);
  url.searchParams.set('key', key);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });

  const data = await parseJsonResponse<GetMemoryGardenDetailResponse>(res);
  return data.detail;
}

/**
 * 获取与当前花瓣呼应的关联记忆
 * GET /api/memory-garden/related?key=...
 */
export async function fetchMemoryGardenRelated(
  key: string,
  signal?: AbortSignal
): Promise<GetMemoryGardenRelatedResponse['related']> {
  const url = new URL('/api/memory-garden/related', window.location.origin);
  url.searchParams.set('key', key);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });

  const data = await parseJsonResponse<GetMemoryGardenRelatedResponse>(res);
  return data.related || [];
}

/**
 * 获取朋友圈动态列表（游标分页）
 */
export async function fetchMoments(
  cursor?: number,
  limit = 20,
  signal?: AbortSignal
): Promise<GetMomentsResponse> {
  const url = new URL('/api/moments', window.location.origin);
  if (cursor) url.searchParams.set('cursor', String(cursor));
  url.searchParams.set('limit', String(limit));

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });

  return parseJsonResponse<GetMomentsResponse>(res);
}

/**
 * 使用者发布新动态（图文/文字/地点）
 */
export async function postMoment(
  req: PostMomentRequest,
  signal?: AbortSignal
): Promise<PostMomentResponse> {
  const res = await fetch('/api/moments/post', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });

  return parseJsonResponse<PostMomentResponse>(res);
}

/**
 * 切换点赞状态
 */
export async function toggleMomentLike(
  postId: string,
  signal?: AbortSignal
): Promise<ToggleLikeResponse> {
  const res = await fetch('/api/moments/like', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ postId }),
    signal,
  });

  return parseJsonResponse<ToggleLikeResponse>(res);
}

/**
 * 发表评论或回复
 */
export async function commentMoment(
  req: CommentMomentRequest,
  signal?: AbortSignal
): Promise<CommentMomentResponse> {
  const res = await fetch('/api/moments/comment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });

  return parseJsonResponse<CommentMomentResponse>(res);
}

/**
 * 删除动态或评论
 */
export async function deleteMomentItem(
  targetType: 'post' | 'comment',
  targetId: string,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch('/api/moments/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetType, targetId }),
    signal,
  });

  const data = await parseJsonResponse<{ ok: boolean; saved: boolean }>(res);
  if (!data.ok || !data.saved) throw new Error('删除尚未完成，请重试');
}

/**
 * 获取朋友圈大图预览数据
 */
export async function fetchMomentImage(
  attachmentId: string,
  signal?: AbortSignal
): Promise<string | null> {
  const url = new URL('/api/moments/image', window.location.origin);
  url.searchParams.set('attachmentId', attachmentId);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });

  const data = await parseJsonResponse<{ ok: boolean; dataUrl: string | null }>(res);
  return data.dataUrl;
}
