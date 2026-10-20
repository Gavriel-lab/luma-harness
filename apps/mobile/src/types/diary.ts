/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Luma 第一人称日记馆类型定义
 */

export interface DiaryBook {
  agentId: string;
  agentName: string;
  frenchRole?: string;
  avatarUrl?: string;
  signatureColor?: string;
  latestDate?: string | null;
  latestTitle?: string | null;
  latestSnippet?: string | null;
  totalEntries: number;
  updatedAt?: string | null;
}

export interface DiaryBooksResponse {
  schema: 'diary-books/1';
  books: DiaryBook[];
  latestGlobal?: {
    agentId: string;
    agentName: string;
    date: string;
    title: string;
    snippet: string;
  } | null;
}

export interface DiaryCatalogItem {
  date: string;
  title: string;
  snippet: string;
  versionCount: number;
  updatedAt: string;
}

export interface DiaryCatalogResponse {
  schema: 'diary-catalog/1';
  agentId: string;
  entries: DiaryCatalogItem[];
  nextCursor?: string | null;
}

export interface DiarySourceQuote {
  timestamp: string;
  sender: string;
  channel: 'direct' | 'living_room' | 'xiaodu';
  content: string;
}

export interface DiaryVersionSummary {
  version: number;
  title: string;
  createdAt: string;
}

export interface DiaryEntryDetail {
  agentId: string;
  agentName: string;
  date: string;
  title: string;
  content: string;
  version: number;
  versionCount: number;
  versions?: DiaryVersionSummary[];
  createdAt: string;
  updatedAt: string;
  sources: DiarySourceQuote[];
}

export interface DiaryEntryResponse {
  schema: 'diary-entry/1';
  entry: DiaryEntryDetail;
}

export interface DiaryJobStatus {
  jobId: string;
  agentId: string;
  date: string;
  state: 'queued' | 'running' | 'completed' | 'failed';
  progress?: number;
  error?: string;
  result?: {
    title: string;
    date: string;
    agentId: string;
  };
}

export interface DiaryJobResponse {
  schema: 'diary-job/1';
  job: DiaryJobStatus;
}

export interface DiarySettings {
  autoGenerate: boolean;
  scheduleTime: string;
  timezone: string;
  targetAgentIds: string[];
  notifyMobile: boolean;
}

export interface DiarySettingsResponse {
  schema: 'diary-settings/1';
  settings: DiarySettings;
}
