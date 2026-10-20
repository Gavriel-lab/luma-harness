/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Character, MemoryDto, SyncStatusResponse } from '../types';
import { fetchMemories, saveMemoryApi, fetchSyncStatus } from '../utils/apiClient';
import { X, BookOpen, Plus, Cloud, RefreshCw, Check, Pin, Sparkles, AlertCircle } from 'lucide-react';

interface ChatMemoriesModalProps {
  isOpen: boolean;
  onClose: () => void;
  character: Character;
  conversationId?: string | null;
  scopeType?: 'direct' | 'living-room';
}

export const ChatMemoriesModal: React.FC<ChatMemoriesModalProps> = ({
  isOpen,
  onClose,
  character,
  conversationId,
  scopeType = 'direct',
}) => {
  const [memories, setMemories] = useState<MemoryDto[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // 新建表单
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newType, setNewType] = useState('experience');

  const loadData = async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const [mems, sync] = await Promise.all([
        fetchMemories(scopeType, scopeType === 'living-room' ? conversationId || undefined : character.id),
        fetchSyncStatus().catch(() => null),
      ]);
      setMemories(mems);
      if (sync) setSyncStatus(sync);
    } catch (err: any) {
      setErrorMsg(err?.message || '读取记忆列表失败');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadData();
    }
  }, [isOpen, character.id, scopeType, conversationId]);

  if (!isOpen) return null;

  const handleSaveNew = async () => {
    if (!newContent.trim()) {
      setErrorMsg('记忆内容不能为空');
      return;
    }
    setIsSaving(true);
    setErrorMsg(null);
    try {
      const requestId = `req_mob_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await saveMemoryApi({
        requestId,
        scopeType,
        scopeId: scopeType === 'living-room' ? conversationId || undefined : character.id,
        authorMemberId: 'agent_owner',
        title: newTitle.trim() || undefined,
        content: newContent.trim(),
        memoryType: newType,
      });
      setSuccessMsg('记忆已成功保存至小屋');
      setNewTitle('');
      setNewContent('');
      setShowAddForm(false);
      setTimeout(() => setSuccessMsg(null), 3000);
      await loadData();
    } catch (err: any) {
      setErrorMsg(err?.message || '保存记忆失败');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/40 backdrop-blur-xs animate-[fadeIn_0.2s_ease-out]">
      <div className="relative w-full max-w-lg max-h-[88vh] flex flex-col bg-[#fdfbf7] rounded-t-3xl sm:rounded-3xl shadow-2xl border border-stone-200 overflow-hidden text-stone-800">
        {/* 顶部标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-stone-200/80 bg-white/70 backdrop-blur-md">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-amber-100/70 text-amber-800">
              <BookOpen className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-serif font-bold text-base text-stone-900 flex items-center gap-2">
                <span>记忆档案库</span>
                <span className="text-xs font-normal px-2 py-0.5 rounded-full bg-stone-100 text-stone-600 border border-stone-200">
                  {scopeType === 'living-room' ? '小屋客厅 · 公开记忆' : character.name}
                </span>
              </h3>
              <p className="text-[11px] font-serif text-stone-500">
                双端统一权威记忆 · 生产数据库增量同步
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-stone-500 hover:bg-stone-100 active:bg-stone-200 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 同步状态条 */}
        <div className="px-5 py-2 bg-stone-50/80 border-b border-stone-200 flex items-center justify-between text-xs font-serif text-stone-600">
          <div className="flex items-center gap-1.5">
            <Cloud className={`w-3.5 h-3.5 ${syncStatus?.enabled ? 'text-emerald-600' : 'text-stone-400'}`} />
            <span>
              {syncStatus?.enabled
                ? (syncStatus.error
                    ? `同步未完成：${syncStatus.error}`
                    : syncStatus.conflictCount
                    ? `有 ${syncStatus.conflictCount} 项需要核对`
                    : syncStatus.outboxPending > 0
                    ? `待上传 ${syncStatus.outboxPending} 项`
                    : '云端同步正常 (ACK)')
                : '本地就绪'}
            </span>
          </div>
          <button
            onClick={loadData}
            disabled={isLoading}
            className="flex items-center gap-1 px-2 py-0.5 rounded-md hover:bg-stone-200/60 active:bg-stone-200 transition-colors text-stone-500 cursor-pointer text-[11px]"
          >
            <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
        </div>

        {/* 提示信息 */}
        {errorMsg && (
          <div className="mx-5 mt-3 p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-serif flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
            <span>{errorMsg}</span>
          </div>
        )}
        {successMsg && (
          <div className="mx-5 mt-3 p-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-serif flex items-center gap-2">
            <Check className="w-4 h-4 shrink-0 text-emerald-600" />
            <span>{successMsg}</span>
          </div>
        )}

        {/* 主内容区域 */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3.5">
          {/* 新增记忆按钮或展开表单 */}
          {!showAddForm ? (
            <button
              onClick={() => setShowAddForm(true)}
              className="w-full py-2.5 px-3.5 rounded-2xl border-2 border-dashed border-stone-300 hover:border-amber-500/60 bg-white/50 hover:bg-amber-50/40 text-stone-600 hover:text-amber-800 text-xs font-serif flex items-center justify-center gap-1.5 transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>为 {character.name} 添加一条专属记忆</span>
            </button>
          ) : (
            <div className="p-4 rounded-2xl bg-white border border-stone-200/90 shadow-xs space-y-3">
              <div className="flex items-center justify-between text-xs font-serif text-stone-700 font-semibold border-b border-stone-100 pb-2">
                <span>新建记忆</span>
                <button
                  onClick={() => setShowAddForm(false)}
                  className="text-stone-400 hover:text-stone-600 text-[11px]"
                >
                  取消
                </button>
              </div>
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="记忆标题（选填，如：生活习惯、约定）"
                className="w-full px-3 py-1.5 rounded-xl bg-stone-50 border border-stone-200 text-xs font-serif text-stone-800 placeholder-stone-400 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <textarea
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder="记忆正文（必填，例如：使用者喜欢在早晨喝一杯热咖啡）"
                rows={3}
                className="w-full px-3 py-2 rounded-xl bg-stone-50 border border-stone-200 text-xs font-serif text-stone-800 placeholder-stone-400 focus:outline-none focus:ring-1 focus:ring-amber-500 resize-none"
              />
              <div className="flex items-center justify-between pt-1">
                <select
                  value={newType}
                  onChange={(e) => setNewType(e.target.value)}
                  className="px-2 py-1 rounded-lg bg-stone-100 text-stone-700 text-xs font-serif border border-stone-200 focus:outline-none"
                >
                  <option value="experience">经历/经历</option>
                  <option value="fact">事实</option>
                  <option value="preference">喜好</option>
                  <option value="agreement">约定</option>
                </select>
                <button
                  onClick={handleSaveNew}
                  disabled={isSaving}
                  className="px-4 py-1.5 rounded-xl bg-stone-800 hover:bg-stone-900 active:scale-95 text-white text-xs font-serif transition-all shadow-xs disabled:opacity-50 cursor-pointer"
                >
                  {isSaving ? '保存中...' : '确认保存'}
                </button>
              </div>
            </div>
          )}

          {/* 列表显示 */}
          {memories.length === 0 ? (
            <div className="py-12 flex flex-col items-center justify-center text-center text-stone-400 font-serif">
              <Sparkles className="w-8 h-8 mb-2 stroke-1 text-stone-300" />
              <p className="text-xs">暂无关于 {character.name} 的授权记忆</p>
              <p className="text-[11px] text-stone-400 mt-1">
                在上方新建，或在聊天中交谈以自然形成记忆
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {memories.map((mem) => (
                <div
                  key={mem.id}
                  className="p-3.5 rounded-2xl bg-white border border-stone-200/80 shadow-2xs space-y-1.5 hover:shadow-xs transition-shadow"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      {mem.pinned && <Pin className="w-3 h-3 text-amber-600 fill-amber-600" />}
                      <span className="font-serif font-semibold text-xs text-stone-800">
                        {mem.title || '（无题记忆）'}
                      </span>
                    </div>
                    <span className="text-[10px] font-serif px-2 py-0.5 rounded-full bg-stone-100 text-stone-600">
                      {mem.memoryType}
                    </span>
                  </div>
                  <p className="font-serif text-xs text-stone-600 leading-relaxed whitespace-pre-wrap">
                    {mem.content}
                  </p>
                  <div className="flex items-center justify-between text-[10px] font-mono text-stone-400 pt-1 border-t border-stone-100">
                    <span>rev.{mem.version}</span>
                    <span>{new Date(mem.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 底部关闭 */}
        <div className="p-3.5 bg-stone-100/60 border-t border-stone-200/80 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-stone-200 hover:bg-stone-300 active:bg-stone-400 text-stone-800 font-serif text-xs transition-colors cursor-pointer"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};
