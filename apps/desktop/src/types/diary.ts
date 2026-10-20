/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * 桌面日记馆类型定义
 */

export interface DiaryBook {
  agentId: string;
  agentName: string;
  name?: string;
  avatarUrl?: string;
  avatarDataUrl?: string;
  signatureColor?: string;
  accent?: string;
  latestDate?: string | null;
  latestTitle?: string | null;
  latestSnippet?: string | null;
  latestCreatedAt?: number;
  entryCount: number;
  totalEntries: number;
  isConfigured?: boolean;
}

export interface DiaryBooksResponse {
  schema: 'diary-books/1';
  books: DiaryBook[];
  latestGlobal?: {
    agentId: string;
    agentName: string;
    diaryDate: string;
    title: string;
    snippet: string;
  } | null;
}

export interface DiaryCatalogItem {
  entryId?: string;
  date: string;
  diaryDate?: string;
  title: string;
  snippet: string;
  version: number;
  totalVersions?: number;
  createdAt: number | string;
}

export interface DiaryCatalogResponse {
  schema: 'diary-catalog/1';
  agentId: string;
  entries: DiaryCatalogItem[];
  nextCursor?: string | null;
}

export interface DiarySourceQuote {
  messageId?: string;
  time?: string;
  timestamp?: string;
  channel?: string;
  role?: string;
  sender?: string;
  text?: string;
  content?: string;
  snippet?: string;
}

export interface DiaryVersionSummary {
  version: number;
  title: string;
  createdAt: number | string;
}

export interface DiaryEntryDetail {
  entryId: string;
  agentId: string;
  agentName?: string;
  date: string;
  diaryDate?: string;
  title: string;
  body: string;
  content: string;
  version: number;
  versionCount: number;
  totalVersions?: number;
  versions?: DiaryVersionSummary[];
  createdAt: number | string;
  updatedAt?: number | string;
  sources: DiarySourceQuote[];
  sourceCutoff?: number;
  modelTag?: string;
}

export interface DiarySettings {
  enabled: boolean;
  autoGenerate?: boolean;
  scheduleTime: string;
  timezone: string;
  targetAgentIds: string[];
  updatedAt?: number;
}
