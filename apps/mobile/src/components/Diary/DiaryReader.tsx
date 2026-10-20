/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 手机端 - 第一人称日记馆阅读器 (DiaryReader)
 * 一本摊开的手记：左右滑动翻页，丝带书签打开目录。
 * 日记由家人自己决定写不写，这里只读，不提供代写 / 重写入口。
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  MessageCircle,
  Radio,
  RefreshCw,
  Users,
  X,
} from 'lucide-react';
import { DiaryBook, DiaryCatalogItem, DiaryEntryDetail } from '../../types/diary';
import { fetchDiaryCatalog, fetchDiaryEntry } from '../../utils/diaryApi';
import { useDiaryReading } from '../../utils/diaryReading';
import { DiaryReadingControls } from './DiaryReadingControls';
import { DiaryBackdrop, CARNET } from './DiaryBackdrop';
import './diary.css';

/** 剪报用的撕纸，轮着来 */
const CLIP_SCRAPS = ['scrap-1', 'scrap-3', 'scrap-4'];

interface DiaryReaderProps {
  book: DiaryBook;
  initialDate?: string;
  onBackToLibrary: () => void;
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** "2026-10-15" → "10月15日 · 星期四"（按本地日期算，不受时区偏移影响） */
function prettyDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  const day = new Date(y, m - 1, d);
  return `${m}月${d}日 · ${WEEKDAYS[day.getDay()]}`;
}

/** 日记是纸，不是聊天框：去掉模型顺手带出来的 **加粗**、# 标题这类 Markdown 记号 */
function cleanText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*/g, '');
}

function channelOf(src: any): 'salon' | 'xiaodu' | 'direct' {
  const ch = String(src.channel || '');
  if (ch.includes('小度') || ch === 'xiaodu') return 'xiaodu';
  if (ch.includes('客厅') || ch === 'living_room') return 'salon';
  return 'direct';
}

export const DiaryReader: React.FC<DiaryReaderProps> = ({
  book,
  initialDate,
  onBackToLibrary,
}) => {
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  // 目录按新到旧排列：index 0 是最近一篇
  const [catalog, setCatalog] = useState<DiaryCatalogItem[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(initialDate || book.latestDate || null);
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(undefined);
  const [entry, setEntry] = useState<DiaryEntryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [turn, setTurn] = useState<'older' | 'newer' | null>(null);
  const [isContentsOpen, setIsContentsOpen] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [isReadingOpen, setIsReadingOpen] = useState(false);
  const { style: readingStyle } = useDiaryReading();
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const pageScrollRef = useRef<HTMLDivElement | null>(null);

  // 加载目录
  useEffect(() => {
    let active = true;
    fetchDiaryCatalog(book.agentId, 60)
      .then((res) => {
        if (!active) return;
        setCatalog(res.entries);
        setSelectedDate((current) => current && res.entries.some((e) => e.date === current) ? current : res.entries[0]?.date || current);
      })
      .catch((err) => console.warn('[DiaryReader] 目录加载失败:', err))
      .finally(() => active && setCatalogLoaded(true));
    return () => { active = false; };
  }, [book.agentId]);

  // 加载当前这一页
  useEffect(() => {
    if (!selectedDate) {
      setEntry(null);
      setLoading(!catalogLoaded);
      return;
    }
    let active = true;
    setLoading(true);
    fetchDiaryEntry(book.agentId, selectedDate, selectedVersion)
      .then((data) => { if (active) setEntry(data); })
      .catch((err) => {
        console.warn('[DiaryReader] 日记详情加载失败:', err);
        if (active) setEntry(null);
      })
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [book.agentId, selectedDate, selectedVersion, catalogLoaded]);

  const pageIndex = selectedDate ? catalog.findIndex((item) => item.date === selectedDate) : -1;
  const hasOlder = pageIndex >= 0 && pageIndex < catalog.length - 1;
  const hasNewer = pageIndex > 0;

  const goTo = (date: string, direction: 'older' | 'newer' | null) => {
    if (date === selectedDate) return;
    setTurn(direction);
    setSelectedVersion(undefined);
    setShowSources(false);
    setSelectedDate(date);
    pageScrollRef.current?.scrollTo({ top: 0 });
  };
  const turnOlder = () => hasOlder && goTo(catalog[pageIndex + 1].date, 'older');
  const turnNewer = () => hasNewer && goTo(catalog[pageIndex - 1].date, 'newer');

  // 跟真本子一样：左滑往后翻（更新的一天），右滑往回翻（更早）
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || e.changedTouches.length === 0) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) < 60 || Math.abs(dy) > 50) return;
    if (dx < 0) turnNewer();
    else turnOlder();
  };

  const accent = book.signatureColor || '#8a6f55';

  const renderPage = () => {
    if (loading) {
      return (
        <div className="diary-page-empty">
          <RefreshCw className="w-5 h-5 animate-spin text-amber-800/50" aria-hidden="true" />
          <p>正在翻开这一页…</p>
        </div>
      );
    }
    if (!entry) {
      return (
        <div className="diary-page-empty">
          <p className="diary-page-empty-title">{catalog.length === 0 ? '这本手记还空着' : '这一页还空着'}</p>
          <p>{catalog.length === 0 ? `${book.agentName}还没写过。想写的时候，会写在这里。` : `${book.agentName}这天没有写。`}</p>
        </div>
      );
    }
    return (
      <>
        <div className="diary-page-meta">
          <span className="diary-page-date">{prettyDate(entry.date)}</span>
          {entry.versionCount > 1 && (
            <label className="diary-page-version">
              <span className="sr-only">选择版本</span>
              <select value={entry.version} onChange={(e) => setSelectedVersion(Number(e.target.value))}>
                {(entry.versions && entry.versions.length > 0
                  ? entry.versions.map((v) => v.version)
                  : Array.from({ length: entry.versionCount }, (_, i) => i + 1)
                ).map((v) => (
                  <option key={v} value={v}>第 {v} 稿{v === entry.versionCount ? '（最新）' : ''}</option>
                ))}
              </select>
            </label>
          )}
        </div>

        <h2 className="diary-page-title">{entry.title}</h2>

        <div className="diary-page-body select-text">
          {cleanText(entry.content).split(/\n{2,}/).map((para, i) => (
            <p key={i}>{para.trim()}</p>
          ))}
        </div>

        {/* 夹在页尾的剪报：这篇是从哪几句聊天里想起来的 */}
        {entry.sources.length > 0 && (
          <div className="diary-clippings">
            <button
              type="button"
              onClick={() => setShowSources(!showSources)}
              aria-expanded={showSources}
              className="diary-clippings-toggle"
            >
              {showSources ? '收起剪报' : `夹着 ${entry.sources.length} 张剪报`}
            </button>
            {showSources && (
              <div className="space-y-2.5 pt-2">
                {entry.sources.map((src: any, idx) => {
                  const raw = src.time || src.timestamp;
                  const time = typeof raw === 'string' ? raw.slice(11, 16) : '';
                  const ch = channelOf(src);
                  const Icon = ch === 'salon' ? Users : ch === 'xiaodu' ? Radio : MessageCircle;
                  return (
                    <div
                      key={idx}
                      className="diary-clipping"
                      style={{
                        rotate: `${idx % 2 ? 0.8 : -0.8}deg`,
                        backgroundImage: `url(${CARNET}${CLIP_SCRAPS[idx % CLIP_SCRAPS.length]}.webp)`,
                      }}
                    >
                      <div className="diary-clipping-head">
                        <span className="inline-flex items-center gap-1">
                          <Icon className="w-3 h-3" aria-hidden="true" />
                          {ch === 'salon' ? '客厅' : ch === 'xiaodu' ? '小度' : '私聊'} · {src.sender || src.role || '家人'}
                        </span>
                        <span>{time}</span>
                      </div>
                      <p className="line-clamp-3">“{src.content || src.snippet || ''}”</p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </>
    );
  };

  return (
    <div className="diary-room relative w-full h-full flex flex-col overflow-hidden select-none text-stone-900">
      <DiaryBackdrop />

      {/* 跟花园页一样不要顶栏：浮着的返回钮 + 居中的名字 */}
      <header className="carnet-head carnet-head--reader">
        <button type="button" onClick={onBackToLibrary} className="carnet-float-btn" aria-label="回到花园">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="carnet-title carnet-title--who">
          {book.avatarUrl ? (
            <img src={book.avatarUrl} alt="" className="diary-cameo diary-cameo--small" />
          ) : (
            <span className="diary-cameo diary-cameo--small diary-cameo--initial" style={{ backgroundColor: accent }}>{book.agentName.slice(0, 1)}</span>
          )}
          <span className="flex flex-col text-left min-w-0">
            <span className="carnet-who-name">{book.agentName}的手记</span>
            <span className="font-calligraphy carnet-who-sub">Journal Intime</span>
          </span>
        </div>
        <button type="button" onClick={() => setIsReadingOpen(true)} className="carnet-float-btn carnet-aa" aria-label="字体和字号" title="字体和字号">
          Aa
        </button>
      </header>

      {/* 摊开的一页 */}
      <div
        ref={pageScrollRef}
        className="diary-scroll relative z-10 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 pb-6 no-scrollbar"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <article
          key={`${selectedDate}-${selectedVersion ?? 'latest'}`}
          className="diary-page"
          data-turn={turn || undefined}
          style={{ '--diary-accent': accent, '--page-img': `url(${CARNET}page.webp)`, ...readingStyle } as React.CSSProperties}
          aria-live="polite"
        >
          {/* 右上角那丛花让出来，字绕着走 */}
          <span className="diary-page-corner" aria-hidden="true" />
          {/* 丝带书签：打开目录 */}
          {catalog.length > 0 && (
            <button
              type="button"
              onClick={() => setIsContentsOpen(true)}
              className="diary-ribbon"
              aria-label="打开目录"
              title="目录"
            >
              <img src={`${CARNET}ribbon-rose.webp`} alt="" draggable={false} />
            </button>
          )}
          {renderPage()}
        </article>

        {/* 页脚翻页：滑不动或不想滑时点这里 */}
        {catalog.length > 1 && (
          <nav className="diary-pager" aria-label="翻页">
            <button type="button" onClick={turnOlder} disabled={!hasOlder} className="diary-quiet-btn" aria-label="前一天">
              <ChevronLeft className="w-4 h-4" />
              <span>前一天</span>
            </button>
            <span className="diary-pager-count">
              {pageIndex >= 0 ? `${catalog.length - pageIndex} / ${catalog.length}` : `— / ${catalog.length}`}
            </span>
            <button type="button" onClick={turnNewer} disabled={!hasNewer} className="diary-quiet-btn" aria-label="后一天">
              <span>后一天</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </nav>
        )}
      </div>

      {/* 字体 / 字号 */}
      {isReadingOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/25" onClick={() => setIsReadingOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="字体和字号" className="diary-contents" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between pb-2 mb-3 diary-contents-head">
              <h3 className="text-sm font-serif font-semibold">阅读</h3>
              <button type="button" onClick={() => setIsReadingOpen(false)} className="diary-quiet-btn" aria-label="关闭">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="text-xs font-serif">
              <DiaryReadingControls />
            </div>
          </div>
        </div>
      )}

      {/* 目录 */}
      {isContentsOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/25" onClick={() => setIsContentsOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`${book.agentName}的手记目录`}
            className="diary-contents"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 mb-1 diary-contents-head">
              <h3 className="font-calligraphy text-2xl text-stone-900">Table des matières</h3>
              <button type="button" onClick={() => setIsContentsOpen(false)} className="diary-quiet-btn" aria-label="关闭目录">
                <X className="w-4 h-4" />
              </button>
            </div>
            <ol className="overflow-y-auto no-scrollbar max-h-[55vh]">
              {catalog.map((item, idx) => (
                <li key={item.date}>
                  <button
                    type="button"
                    data-current={item.date === selectedDate || undefined}
                    onClick={() => {
                      goTo(item.date, pageIndex < 0 ? null : idx > pageIndex ? 'older' : 'newer');
                      setIsContentsOpen(false);
                    }}
                    className="diary-contents-row"
                  >
                    <span className="diary-contents-title">{item.title}</span>
                    <span className="diary-contents-leader" aria-hidden="true" />
                    <span className="diary-contents-date">{item.date.slice(5).replace('-', '/')}</span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </div>
  );
};
