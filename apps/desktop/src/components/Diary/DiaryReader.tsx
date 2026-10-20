/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * 桌面日记馆阅读器 (DiaryReader)
 * 宽屏摊开双页本：左页目录（丝带标记），右页正文（支持键盘左右翻页、撕纸剪报折叠、多版本微标）
 */
import React, { useState, useEffect, useRef } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, MessageCircle, Radio, Users, X } from 'lucide-react';
import type { DiaryBook, DiaryCatalogItem, DiaryEntryDetail } from '../../types/diary';
import { fetchDiaryCatalog, fetchDiaryEntry } from '../../utils/diaryApi';
import { useDiaryReading } from '../../utils/diaryReading';
import { DiaryReadingControls } from './DiaryReadingControls';
import { DiaryBackdrop, CARNET } from './DiaryBackdrop';
import './diary.css';

const CLIP_SCRAPS = ['scrap-1', 'scrap-2', 'scrap-3', 'scrap-4'];

interface DiaryReaderProps {
  book: DiaryBook;
  initialDate?: string;
  onBackToLibrary: () => void;
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function prettyDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const day = new Date(y, m - 1, d);
  return `${m}月${d}日 · ${WEEKDAYS[day.getDay()]}`;
}

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
  const [catalog, setCatalog] = useState<DiaryCatalogItem[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(initialDate || book.latestDate || null);
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(undefined);
  const [entry, setEntry] = useState<DiaryEntryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [turn, setTurn] = useState<'older' | 'newer' | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [isReadingOpen, setIsReadingOpen] = useState(false);
  const { style: readingStyle } = useDiaryReading();
  const pageContainerRef = useRef<HTMLDivElement>(null);

  // 加载目录
  useEffect(() => {
    let active = true;
    fetchDiaryCatalog(book.agentId, 100)
      .then((res) => {
        if (!active) return;
        setCatalog(res.entries);
        setSelectedDate((cur) => {
          if (cur && res.entries.some((e) => e.date === cur)) return cur;
          return res.entries[0]?.date || cur;
        });
      })
      .catch((err) => console.warn('[DiaryReader] 目录加载失败:', err));
    return () => {
      active = false;
    };
  }, [book.agentId]);

  // 加载单篇
  useEffect(() => {
    if (!selectedDate) {
      setEntry(null);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    fetchDiaryEntry(book.agentId, selectedDate, selectedVersion)
      .then((res) => {
        if (!active) return;
        setEntry(res);
      })
      .catch((err) => console.warn('[DiaryReader] 日记单篇加载失败:', err))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [book.agentId, selectedDate, selectedVersion]);

  // 目录倒序排列：0 是最新一天，最后一天是最早一天
  const pageIndex = catalog.findIndex((item) => item.date === selectedDate);
  const hasOlder = pageIndex >= 0 && pageIndex < catalog.length - 1;
  const hasNewer = pageIndex > 0;

  const goTo = (targetDate: string, direction: 'older' | 'newer' | null = null) => {
    if (targetDate === selectedDate) return;
    const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || !direction) {
      setSelectedDate(targetDate);
      setSelectedVersion(undefined);
      return;
    }
    setTurn(direction);
    setSelectedDate(targetDate);
    setSelectedVersion(undefined);
    setTimeout(() => setTurn(null), 460);
  };

  const turnOlder = () => {
    if (!hasOlder || !catalog[pageIndex + 1]) return;
    goTo(catalog[pageIndex + 1]!.date, 'older');
  };

  const turnNewer = () => {
    if (!hasNewer || !catalog[pageIndex - 1]) return;
    goTo(catalog[pageIndex - 1]!.date, 'newer');
  };

  // 键盘左右键支持翻页
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        turnOlder();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        turnNewer();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pageIndex, catalog]);

  return (
    <div className="diary-room relative w-full h-full flex flex-col overflow-hidden select-none text-stone-900">
      <DiaryBackdrop variant="soft" />

      {/* 顶栏浮动控件 */}
      <header className="carnet-head carnet-head--reader">
        <button type="button" onClick={onBackToLibrary} className="carnet-float-btn" aria-label="回到花园">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="carnet-title carnet-title--who">
          {book.avatarUrl || book.avatarDataUrl ? (
            <img
              src={book.avatarUrl || book.avatarDataUrl}
              alt=""
              className="carnet-cameo"
              style={{ width: 34, height: 28, position: 'relative', transform: 'none' }}
            />
          ) : (
            <span
              className="carnet-cameo"
              style={{ width: 34, height: 28, position: 'relative', transform: 'none', backgroundColor: book.signatureColor || '#8a6a4f' }}
            >
              <span style={{ color: '#fff' }}>{book.agentName.slice(0, 1)}</span>
            </span>
          )}
          <span className="carnet-who-name">{book.agentName}的手记</span>
          <span className="carnet-who-sub">Journal Intime</span>
        </div>
        <button
          type="button"
          onClick={() => setIsReadingOpen(true)}
          className="carnet-float-btn carnet-aa"
          aria-label="字体和字号"
          title="字体和字号"
        >
          Aa
        </button>
      </header>

      {/* 宽屏摊开双页书本容器 */}
      <div className="diary-book-wrapper" ref={pageContainerRef}>
        <div
          className="diary-double-page"
          data-turn={turn || undefined}
          style={{ backgroundImage: `url(${CARNET}page.webp)` }}
        >
          {/* 丝带书签 */}
          <div className="diary-ribbon-badge">
            <img src={`${CARNET}ribbon-rose.webp`} alt="" draggable={false} />
          </div>

          {/* 书脊折痕阴影 */}
          <div className="diary-spine" />

          {/* 左页：目录 */}
          <section className="diary-left-page" aria-label="手记目录">
            <div className="diary-catalog-header">
              <span className="diary-catalog-title">Sommaire</span>
              <span className="diary-catalog-sub">共 {catalog.length} 篇随笔</span>
            </div>
            <div className="diary-catalog-list no-scrollbar">
              {catalog.length === 0 ? (
                <div className="text-xs text-stone-500 py-8 text-center font-serif">尚无手记目录</div>
              ) : (
                catalog.map((item, idx) => (
                  <button
                    key={item.date}
                    type="button"
                    onClick={() => goTo(item.date, pageIndex < 0 ? null : idx > pageIndex ? 'older' : 'newer')}
                    className={`diary-catalog-item ${item.date === selectedDate ? 'is-active' : ''}`}
                  >
                    <span className="diary-catalog-item-title">{item.title}</span>
                    <span className="diary-catalog-item-date">{item.date.slice(5).replace('-', '/')}</span>
                  </button>
                ))
              )}
            </div>
          </section>

          {/* 右页：正文 */}
          <section className="diary-right-page no-scrollbar" style={readingStyle} aria-label="手记正文">
            {loading ? (
              <div className="diary-page-empty">
                <p>正在翻开这一页…</p>
              </div>
            ) : !entry ? (
              <div className="diary-page-empty">
                <p className="diary-page-empty-title">
                  {catalog.length === 0 ? '这本手记还空着' : '这一页还空着'}
                </p>
                <p>{catalog.length === 0 ? `${book.agentName}还没写过。想写的时候，会写在这里。` : `${book.agentName}这天没有写。`}</p>
              </div>
            ) : (
              <>
                <div className="diary-article-header">
                  <span className="diary-article-date">{prettyDate(entry.date)}</span>
                  {entry.versionCount > 1 && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-stone-500">版本</span>
                      <select
                        value={entry.version}
                        onChange={(e) => setSelectedVersion(Number(e.target.value))}
                        className="diary-version-badge"
                      >
                        {(entry.versions && entry.versions.length > 0
                          ? entry.versions.map((v) => v.version)
                          : Array.from({ length: entry.versionCount }, (_, i) => i + 1)
                        ).map((v) => (
                          <option key={v} value={v}>
                            第 {v} 稿{v === entry.versionCount ? ' (最新)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                <h2 className="diary-article-title">{entry.title}</h2>

                <div className="diary-article-body select-text">
                  {cleanText(entry.content)
                    .split(/\n{2,}/)
                    .map((para, i) => (
                      <p key={i}>{para.trim()}</p>
                    ))}
                </div>

                <div className="diary-fin" aria-hidden="true">❦</div>

                {/* 真实印记剪报 (撕纸效果) */}
                {entry.sources && entry.sources.length > 0 && (
                  <div className="diary-clippings-area">
                    <button
                      type="button"
                      onClick={() => setShowSources(!showSources)}
                      aria-expanded={showSources}
                      className="diary-clippings-toggle"
                    >
                      <span>{showSources ? '收起真实印记' : `夹着 ${entry.sources.length} 张真实印记剪报`}</span>
                    </button>

                    {showSources && (
                      <div className="space-y-3 pt-3">
                        {entry.sources.map((src: any, idx) => {
                          const rawTime = src.time || src.timestamp;
                          const timeStr = typeof rawTime === 'string' ? rawTime.slice(11, 16) : '';
                          const ch = channelOf(src);
                          const Icon = ch === 'salon' ? Users : ch === 'xiaodu' ? Radio : MessageCircle;
                          const scrapImg = CLIP_SCRAPS[idx % CLIP_SCRAPS.length];

                          return (
                            <div
                              key={idx}
                              className="diary-clipping-card"
                              style={{
                                backgroundImage: `url(${CARNET}${scrapImg}.webp)`,
                                transform: `rotate(${idx % 2 === 0 ? 0.6 : -0.6}deg)`,
                              }}
                            >
                              <div className="diary-clipping-meta">
                                <span className="inline-flex items-center gap-1">
                                  <Icon className="w-3 h-3 text-stone-600" />
                                  <span>{ch === 'salon' ? '客厅' : ch === 'xiaodu' ? '小度' : '私聊'} · {src.role || src.sender || '家人'}</span>
                                </span>
                                <span>{timeStr}</span>
                              </div>
                              <p className="diary-clipping-quote">
                                “{src.text || src.content || src.snippet || ''}”
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        </div>

        {/* 底栏翻页控件 */}
        {catalog.length > 1 && (
          <nav className="diary-pager-nav" aria-label="翻页">
            <button
              type="button"
              onClick={turnOlder}
              disabled={!hasOlder}
              className="diary-pager-btn"
              title="往左翻到更早的一天 (可按 ← 键)"
            >
              <ChevronLeft className="w-4 h-4" />
              <span>前一天</span>
            </button>
            <span className="diary-pager-indicator">
              {pageIndex >= 0 ? `${catalog.length - pageIndex} / ${catalog.length}` : `— / ${catalog.length}`}
            </span>
            <button
              type="button"
              onClick={turnNewer}
              disabled={!hasNewer}
              className="diary-pager-btn"
              title="往右翻到更新的一天 (可按 → 键)"
            >
              <span>后一天</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </nav>
        )}
      </div>

      {/* 阅读设置抽屉 */}
      {isReadingOpen && (
        <div className="diary-modal-backdrop" onClick={() => setIsReadingOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="阅读设置"
            className="diary-modal-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 mb-4 border-b border-stone-200">
              <h3 className="text-sm font-serif font-semibold text-stone-800">阅读偏好</h3>
              <button
                type="button"
                onClick={() => setIsReadingOpen(false)}
                className="carnet-float-btn"
                style={{ width: 28, height: 28 }}
                aria-label="关闭"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <DiaryReadingControls />
          </div>
        </div>
      )}
    </div>
  );
};
