/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * 手机端首页 - 法式第一人称日记馆入口卡片
 * 微展开法式羊皮手记本造型，展示全屋最新日记动态或真实空状态
 */

import React, { useEffect, useState } from 'react';
import { BookOpen, Sparkles, ChevronRight, Bookmark } from 'lucide-react';
import { fetchDiaryBooks } from '../../utils/diaryApi';
import { DiaryBook } from '../../types/diary';

interface DiaryCardProps {
  onOpenDiary: (agentId?: string) => void;
}

export const DiaryCard: React.FC<DiaryCardProps> = ({ onOpenDiary }) => {
  const [loading, setLoading] = useState(true);
  const [latest, setLatest] = useState<{
    agentId: string;
    agentName: string;
    date: string;
    title: string;
    snippet: string;
  } | null>(null);
  const [bookCount, setBookCount] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    fetchDiaryBooks(controller.signal)
      .then((res) => {
        if (!active) return;
        setLatest(res.latestGlobal || null);
        setBookCount(res.books.length);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        console.warn('[DiaryCard] 无法拉取日记动态:', err.message);
        setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  return (
    <div
      onClick={() => onOpenDiary(latest?.agentId)}
      className="group relative w-full overflow-hidden rounded-2xl bg-white/25 hover:bg-white/35 active:scale-[0.985] backdrop-blur-md border border-white/40 shadow-sm p-3.5 transition-all duration-300 cursor-pointer"
    >
      {/* 装饰性羊皮纸细纹与书脊金线 */}
      <div className="absolute top-0 bottom-0 left-0 w-1.5 bg-gradient-to-b from-amber-700/60 via-amber-600/40 to-amber-800/60 rounded-l-2xl" />
      <div className="absolute -right-6 -bottom-6 w-24 h-24 bg-amber-400/10 rounded-full blur-xl pointer-events-none" />

      {/* 顶部标题区 */}
      <div className="flex items-center justify-between pl-1 pb-1.5 border-b border-stone-800/10">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-lg bg-amber-900/10 flex items-center justify-center text-amber-900">
            <BookOpen className="w-3.5 h-3.5" />
          </div>
          <span className="text-[12px] font-serif font-semibold text-stone-800 tracking-wide">
            日记馆 · Carnets
          </span>
          <span className="text-[10px] font-serif text-stone-500 italic">
            Confidences
          </span>
        </div>

        <div className="flex items-center gap-1 text-[11px] font-serif text-amber-900/80 group-hover:text-amber-950 transition-colors">
          <span>翻阅手记</span>
          <ChevronRight className="w-3.5 h-3.5 transform group-hover:translate-x-0.5 transition-transform" />
        </div>
      </div>

      {/* 内容主体区 */}
      <div className="mt-2.5 pl-1.5">
        {loading ? (
          <div className="flex items-center gap-2 py-1 text-stone-500 text-xs font-serif animate-pulse">
            <Bookmark className="w-3.5 h-3.5 text-amber-800/50" />
            <span>正在拂开书页微尘...</span>
          </div>
        ) : latest ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-[11px] font-serif">
              <span className="inline-flex items-center gap-1.5 font-medium text-amber-950">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-600 animate-pulse" />
                {latest.agentName}
              </span>
              <span className="text-[10px] text-stone-500 font-mono">
                {latest.date}
              </span>
            </div>

            <div className="text-xs font-serif font-medium text-stone-900 line-clamp-1">
              {latest.title || '无题手记'}
            </div>

            <p className="text-[11px] font-serif text-stone-600 line-clamp-1 italic leading-tight">
              {latest.snippet ? `“${latest.snippet}”` : '记录着小屋今日的低语与温度...'}
            </p>
          </div>
        ) : (
          <div className="flex items-center justify-between py-1 text-stone-600 text-xs font-serif">
            <div className="flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-amber-700/60" />
              <span>今日暂无新手记 · 静候今夜扉页开启</span>
            </div>
            <span className="text-[10px] text-stone-400">
              {bookCount} 位家人在馆
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
