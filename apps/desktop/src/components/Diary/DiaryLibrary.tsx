/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * 桌面日记馆 - 花园主页 (DiaryLibrary)
 * 莫奈水彩草地铺满，使用者本子 Mon Journal 居中摊开，家人的手记散落四周，书角小纸签，不漏正文
 */
import React, { useState, useEffect } from 'react';
import { ArrowLeft, Settings, X } from 'lucide-react';
import type { DiaryBook, DiarySettings } from '../../types/diary';
import { fetchDiaryBooks, fetchDiarySettings, saveDiarySettings } from '../../utils/diaryApi';
import { DiaryReader } from './DiaryReader';
import { DiaryBackdrop, CARNET } from './DiaryBackdrop';
import { MonJournal } from './MonJournal';
import { DiaryReadingControls } from './DiaryReadingControls';
import './diary.css';

interface DiaryLibraryProps {
  onBackToHome: () => void;
  defaultAgentId?: string;
}

const COVERS: { name: string; rgb: [number, number, number] }[] = [
  { name: 'blue', rgb: [143, 166, 200] },
  { name: 'sage', rgb: [150, 176, 140] },
  { name: 'lilac', rgb: [170, 160, 204] },
  { name: 'rose', rgb: [214, 140, 136] },
  { name: 'apricot', rgb: [228, 168, 128] },
  { name: 'ivory', rgb: [233, 223, 198] },
];

const OVAL: Record<string, [number, number]> = {
  blue: [51, 27.5],
  apricot: [54, 29],
  sage: [57.5, 28],
  lilac: [54.5, 28.5],
  rose: [44, 26.5],
  ivory: [53, 28],
};

// 桌面宽屏散落点分布（宽屏视角，书本更舒展，不压纸签）
const DESKTOP_SLOTS = [
  { left: '8%', top: '22%', rot: -10, tagSide: 'right', delay: 40 },
  { left: '72%', top: '20%', rot: 9, tagSide: 'left', delay: 100 },
  { left: '4%', top: '56%', rot: 7, tagSide: 'right', delay: 160 },
  { left: '76%', top: '54%', rot: -8, tagSide: 'left', delay: 220 },
  { left: '26%', top: '64%', rot: -5, tagSide: 'left', delay: 280 },
  { left: '54%', top: '65%', rot: 6, tagSide: 'right', delay: 340 },
  { left: '38%', top: '74%', rot: -2, tagSide: 'right', delay: 400 },
];

const SCRAPS = ['scrap-1', 'scrap-3', 'scrap-4', 'scrap-2'];

function hexToRgb(hex?: string): [number, number, number] | null {
  if (!hex) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function assignCovers(books: DiaryBook[]): string[] {
  const pairs: { b: number; c: number; d: number }[] = [];
  books.forEach((book, b) => {
    // 特殊指定：协调者蓝，Researcher 绿
    if (book.agentId === 'agent_coordinator') {
      pairs.push({ b, c: 0, d: -1000 }); // blue
      return;
    }
    if (book.agentId === 'agent_kiro' || book.agentName === 'Researcher') {
      pairs.push({ b, c: 1, d: -900 }); // sage
      return;
    }
    const rgb = hexToRgb(book.signatureColor || book.accent);
    if (!rgb) return;
    COVERS.forEach((cover, c) => {
      const d = cover.rgb.reduce((s, v, i) => s + (v - (rgb[i] ?? 0)) ** 2, 0);
      pairs.push({ b, c, d });
    });
  });
  pairs.sort((x, y) => x.d - y.d);
  const result: (string | null)[] = books.map(() => null);
  const taken = new Set<number>();
  for (const { b, c } of pairs) {
    if (result[b] || taken.has(c)) continue;
    result[b] = COVERS[c]?.name ?? 'ivory';
    taken.add(c);
  }
  let next = 0;
  return result.map((name) => {
    if (name) return name;
    while (taken.has(next % COVERS.length) && taken.size < COVERS.length) next++;
    const pick = COVERS[next % COVERS.length]?.name ?? 'ivory';
    taken.add(next % COVERS.length);
    next++;
    return pick;
  });
}

const PETALS = [
  { left: 10, top: 12, delay: 0, dur: 18 },
  { left: 35, top: 4, delay: 6, dur: 22 },
  { left: 62, top: 8, delay: 3, dur: 20 },
  { left: 88, top: 25, delay: 9, dur: 19 },
  { left: 24, top: 45, delay: 12, dur: 24 },
  { left: 75, top: 60, delay: 15, dur: 21 },
];

const FIREFLIES = [
  { left: 18, top: 38, delay: 0 },
  { left: 45, top: 58, delay: 2.5 },
  { left: 82, top: 48, delay: 1.2 },
  { left: 30, top: 78, delay: 3.8 },
  { left: 68, top: 82, delay: 1.9 },
];

const MINE_ID = '__owner__';

export const DiaryLibrary: React.FC<DiaryLibraryProps> = ({
  onBackToHome,
  defaultAgentId,
}) => {
  const [loading, setLoading] = useState(true);
  const [books, setBooks] = useState<DiaryBook[]>([]);
  const [selectedBook, setSelectedBook] = useState<DiaryBook | null>(null);
  const [mineOpen, setMineOpen] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);

  // 自动写日记设置
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<DiarySettings | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);

  const loadBooks = () => {
    setLoading(true);
    fetchDiaryBooks()
      .then((res) => {
        setBooks(res.books);
        if (defaultAgentId) {
          const match = res.books.find((b) => b.agentId === defaultAgentId);
          if (match) setSelectedBook(match);
        }
      })
      .catch((err) => console.warn('[DiaryLibrary] 获取日记列表失败:', err))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadBooks();
  }, [defaultAgentId]);

  const pickUp = (id: string, open: () => void) => {
    if (openingId) return;
    const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      open();
      return;
    }
    setOpeningId(id);
    setTimeout(() => {
      setOpeningId(null);
      open();
    }, 450);
  };

  const handleOpenSettings = async () => {
    setIsSettingsOpen(true);
    setSettingsNotice(null);
    try {
      const s = await fetchDiarySettings();
      setSettings(s);
    } catch (err: any) {
      console.warn('[DiaryLibrary] 读取设置失败:', err);
      setSettingsNotice('读取设置失败');
    }
  };

  const handleSaveSettings = async () => {
    if (!settings) return;
    setSettingsSaving(true);
    setSettingsNotice(null);
    try {
      const saved = await saveDiarySettings(settings);
      setSettings(saved);
      setSettingsNotice('已保存');
      setTimeout(() => {
        setSettingsNotice(null);
        setIsSettingsOpen(false);
      }, 1000);
    } catch (err: any) {
      setSettingsNotice(`保存失败: ${err.message}`);
    } finally {
      setSettingsSaving(false);
    }
  };

  if (selectedBook) {
    return (
      <DiaryReader
        book={selectedBook}
        onBackToLibrary={() => {
          setSelectedBook(null);
          loadBooks();
        }}
      />
    );
  }

  if (mineOpen) {
    return <MonJournal onBack={() => setMineOpen(false)} />;
  }

  const covers = assignCovers(books);

  return (
    <div className="diary-room carnet-garden relative w-full h-full overflow-hidden select-none text-stone-900">
      <DiaryBackdrop variant="garden" />

      {/* 浮动顶栏：左返回、右设置、中标题 */}
      <header className="carnet-head">
        <button type="button" onClick={onBackToHome} className="carnet-float-btn" aria-label="回到小屋">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="carnet-title">
          <h1>Carnets des Confidences</h1>
          <p>Les journaux intimes de la maison</p>
        </div>
        <button
          type="button"
          onClick={handleOpenSettings}
          className="carnet-float-btn"
          aria-label="日记馆设置"
          title="日记馆设置"
        >
          <Settings className="w-4 h-4" />
        </button>
      </header>

      {/* 草地散落舞台 */}
      <div className="carnet-stage-wrap">
        <div className="carnet-stage">
          {/* 使用者自己的本子：摊开放在中间偏上 */}
          <button
            type="button"
            className="carnet-mine"
            data-opening={openingId === MINE_ID || undefined}
            onClick={() => pickUp(MINE_ID, () => setMineOpen(true))}
            aria-label="翻开使用者自己的手记 Mon Journal"
          >
            <img src={`${CARNET}mine-open.webp`} alt="" draggable={false} />
            <span className="carnet-mine-tag">Mon Journal</span>
          </button>

          {/* 已配置成员的本子松松地散在周围 */}
          {books.map((book, idx) => {
            const slot = DESKTOP_SLOTS[idx % DESKTOP_SLOTS.length] ?? DESKTOP_SLOTS[0]!;
            const coverName = covers[idx] || 'ivory';
            const ovalCenter = OVAL[coverName] || [50, 28];
            const scrapImg = SCRAPS[idx % SCRAPS.length];

            return (
              <button
                key={book.agentId}
                type="button"
                className="carnet-book"
                data-opening={openingId === book.agentId || undefined}
                style={
                  {
                    left: slot.left,
                    top: slot.top,
                    '--rot': `${slot.rot}deg`,
                    '--delay': `${slot.delay}ms`,
                  } as React.CSSProperties
                }
                onClick={() => pickUp(book.agentId, () => setSelectedBook(book))}
                aria-label={`翻开 ${book.agentName} 的手记`}
              >
                <img
                  src={`${CARNET}cover-${coverName}.webp`}
                  alt=""
                  className="carnet-book-cover"
                  draggable={false}
                />

                {/* 椭圆框里的头像 */}
                <div
                  className="carnet-cameo"
                  style={{
                    left: `${ovalCenter[0]}%`,
                    top: `${ovalCenter[1]}%`,
                  }}
                >
                  {book.avatarUrl || book.avatarDataUrl ? (
                    <img src={book.avatarUrl || book.avatarDataUrl} alt="" draggable={false} />
                  ) : (
                    <span style={{ backgroundColor: book.signatureColor || book.accent || '#8a6a4f', color: '#fff' }}>
                      {book.agentName.slice(0, 1)}
                    </span>
                  )}
                </div>

                {/* 系在书角的小纸签 (只写名字，不漏任何正文) */}
                <div
                  className={`carnet-tag carnet-tag--${slot.tagSide}`}
                  style={{
                    backgroundImage: `url(${CARNET}${scrapImg}.webp)`,
                  }}
                >
                  {book.agentName}
                </div>
              </button>
            );
          })}

          {/* 压在书角的压花点缀 */}
          <img
            src={`${CARNET}rose.webp`}
            alt=""
            aria-hidden="true"
            className="carnet-deco carnet-deco--over"
            style={{ left: '20%', top: '35%', width: '90px', transform: 'rotate(15deg)' }}
          />
          <img
            src={`${CARNET}daisy.webp`}
            alt=""
            aria-hidden="true"
            className="carnet-deco carnet-deco--over"
            style={{ left: '68%', top: '48%', width: '75px', transform: 'rotate(-25deg)' }}
          />
          <img
            src={`${CARNET}ginkgo.webp`}
            alt=""
            aria-hidden="true"
            className="carnet-deco carnet-deco--over"
            style={{ left: '80%', top: '75%', width: '90px', transform: 'rotate(-40deg)' }}
          />

          {loading && books.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center font-serif text-sm text-stone-600">
              正在把手记放到草地上…
            </div>
          )}

          {/* 飘落的花瓣和萤火 */}
          <div className="carnet-air" aria-hidden="true">
            {PETALS.map((p, i) => (
              <span
                key={`p${i}`}
                className="carnet-petal"
                style={{
                  left: `${p.left}%`,
                  top: `${p.top}%`,
                  animationDelay: `${p.delay}s`,
                  animationDuration: `${p.dur}s`,
                }}
              />
            ))}
            {FIREFLIES.map((f, i) => (
              <span
                key={`f${i}`}
                className="carnet-firefly"
                style={{
                  left: `${f.left}%`,
                  top: `${f.top}%`,
                  animationDelay: `${f.delay}s`,
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* 设置弹窗 */}
      {isSettingsOpen && (
        <div className="diary-modal-backdrop" onClick={() => setIsSettingsOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="日记设置"
            className="diary-modal-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 mb-4 border-b border-stone-200">
              <h3 className="text-sm font-serif font-semibold text-stone-800">日记馆设置</h3>
              <button
                type="button"
                onClick={() => setIsSettingsOpen(false)}
                className="carnet-float-btn"
                style={{ width: 28, height: 28 }}
                aria-label="关闭"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <section className="mb-6">
              <h4 className="text-xs font-semibold text-stone-600 mb-3">阅读 · 本机偏好</h4>
              <DiaryReadingControls />
            </section>

            <section className="pt-4 border-t border-stone-200">
              <h4 className="text-xs font-semibold text-stone-600 mb-3">自动提笔 · 桌面调度</h4>
              {!settings ? (
                <div className="py-4 text-center text-xs text-stone-500 font-serif">
                  {settingsNotice || '正在读取设置…'}
                </div>
              ) : (
                <div className="space-y-4 text-xs font-serif">
                  <label className="flex items-center justify-between gap-3">
                    <span>
                      <span className="block font-semibold text-stone-800">自主提笔</span>
                      <span className="block text-[11px] text-stone-500 mt-0.5">
                        跟随自由时间，由每位家人决定什么时候想写，也可以不写
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={settings.enabled}
                      onChange={(e) => setSettings({ ...settings, enabled: e.target.checked, autoGenerate: e.target.checked })}
                      className="w-4 h-4 accent-amber-800"
                    />
                  </label>

                  <fieldset className="space-y-2">
                    <legend className="text-stone-600 mb-1 font-semibold">参与的家人</legend>
                    <div className="grid grid-cols-2 gap-2">
                      {books.map((book) => (
                        <label
                          key={book.agentId}
                          className="flex items-center justify-between p-2 rounded bg-stone-50 border border-stone-200"
                        >
                          <span className="text-stone-800 text-xs">{book.agentName}</span>
                          <input
                            type="checkbox"
                            checked={settings.targetAgentIds.includes(book.agentId)}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? [...settings.targetAgentIds, book.agentId]
                                : settings.targetAgentIds.filter((id) => id !== book.agentId);
                              setSettings({ ...settings, targetAgentIds: next });
                            }}
                            className="w-3.5 h-3.5 accent-amber-800"
                          />
                        </label>
                      ))}
                    </div>
                  </fieldset>

                  <div className="flex items-center justify-between pt-3">
                    <span className="text-xs text-amber-800">{settingsNotice}</span>
                    <button
                      type="button"
                      onClick={handleSaveSettings}
                      disabled={settingsSaving}
                      className="px-4 py-1.5 bg-amber-800 text-white rounded text-xs hover:bg-amber-900 transition-colors disabled:opacity-50"
                    >
                      {settingsSaving ? '正在保存…' : '保存设置'}
                    </button>
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
};
