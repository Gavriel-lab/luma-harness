/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 手机端 - 第一人称日记馆 (DiaryLibrary)
 * 午后池边的草地：使用者那本摊开在中间，家人的手记随手散落在四周。
 * 封面上不露内容，只有头像和名字，翻开才看得到写了什么。
 */

import React, { useState, useEffect } from 'react';
import { ArrowLeft, Settings, X } from 'lucide-react';
import { DiaryBook, DiarySettings } from '../../types/diary';
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

/** 六种封面和它们的主色，用来给家人的专属色找最接近的一本 */
const COVERS: { name: string; rgb: [number, number, number] }[] = [
  { name: 'blue', rgb: [143, 166, 200] },
  { name: 'sage', rgb: [150, 176, 140] },
  { name: 'lilac', rgb: [170, 160, 204] },
  { name: 'rose', rgb: [214, 140, 136] },
  { name: 'apricot', rgb: [228, 168, 128] },
  { name: 'ivory', rgb: [233, 223, 198] },
];

/** 每本封面上椭圆框的中心（占图宽/高的百分比），头像放在这里 */
const OVAL: Record<string, [number, number]> = {
  blue: [51, 27.5],
  apricot: [54, 29],
  sage: [57.5, 28],
  lilac: [54.5, 28.5],
  rose: [44, 26.5],
  ivory: [53, 28],
};

/** 散落的位置：left / top / 宽度都按舞台百分比，rot 是随手一放的角度 */
const SLOTS = [
  { left: 1, top: 22, rot: -12, tag: 'right', tagBottom: -7 },
  { left: 70, top: 20.5, rot: 10, tag: 'left', tagBottom: -7 },
  { left: 6, top: 44.5, rot: 6, tag: 'right', tagBottom: 16 },
  { left: 64, top: 43.5, rot: -9, tag: 'left', tagBottom: 16 },
  { left: 12, top: 65.5, rot: -6, tag: 'left', tagBottom: -6 },
  { left: 59, top: 67, rot: 9, tag: 'right', tagBottom: -6 },
] as const;

const SCRAPS = ['scrap-1', 'scrap-3', 'scrap-4', 'scrap-2'];

function hexToRgb(hex?: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 按专属色给每本书挑封面：先挑最像的，撞了就让给更像的那位，剩下的按顺序补 */
function assignCovers(books: DiaryBook[]): string[] {
  const pairs: { b: number; c: number; d: number }[] = [];
  books.forEach((book, b) => {
    const rgb = hexToRgb(book.signatureColor);
    if (!rgb) return;
    COVERS.forEach((cover, c) => {
      const d = cover.rgb.reduce((s, v, i) => s + (v - rgb[i]) ** 2, 0);
      pairs.push({ b, c, d });
    });
  });
  pairs.sort((x, y) => x.d - y.d);
  const result: (string | null)[] = books.map(() => null);
  const taken = new Set<number>();
  for (const { b, c } of pairs) {
    if (result[b] || taken.has(c)) continue;
    result[b] = COVERS[c].name;
    taken.add(c);
  }
  let next = 0;
  return result.map((name) => {
    if (name) return name;
    while (taken.has(next % COVERS.length) && taken.size < COVERS.length) next++;
    const pick = COVERS[next % COVERS.length].name;
    taken.add(next % COVERS.length);
    next++;
    return pick;
  });
}

/** 慢慢飘的花瓣和萤火：位置、延迟固定写好，省得每次渲染乱跳 */
const PETALS = [
  { left: 12, top: 8, delay: 0, dur: 17 },
  { left: 58, top: 2, delay: 5, dur: 21 },
  { left: 84, top: 30, delay: 9, dur: 19 },
  { left: 34, top: 40, delay: 13, dur: 23 },
];
const FIREFLIES = [
  { left: 44, top: 60, delay: 0 },
  { left: 16, top: 41, delay: 2.2 },
  { left: 88, top: 58, delay: 3.6 },
  { left: 50, top: 87, delay: 1.3 },
  { left: 30, top: 20, delay: 4.4 },
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
      .catch((err) => console.warn('[DiaryLibrary] 获取日记失败:', err))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadBooks();
  }, [defaultAgentId]);

  // 先把书从草地上拿起来、亮一下，再翻开；减少动态效果时直接进
  const pickUp = (id: string, open: () => void) => {
    if (openingId) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { open(); return; }
    setOpeningId(id);
    setTimeout(() => { setOpeningId(null); open(); }, 460);
  };

  const handleOpenSettings = async () => {
    setIsSettingsOpen(true);
    setSettingsNotice(null);
    // 桌面没开时请求可能一直挂着，10 秒还没回就当没连上
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      setSettings(await fetchDiarySettings(ctrl.signal));
    } catch (err: any) {
      console.warn('[DiaryLibrary] 读取设置失败:', err);
      setSettingsNotice('桌面小屋好像没开，自动提笔的设置暂时读不到。上面的阅读设置不受影响。');
    } finally {
      clearTimeout(timer);
    }
  };

  const handleSaveSettings = async () => {
    if (!settings) return;
    setSettingsSaving(true);
    setSettingsNotice(null);
    try {
      setSettings(await saveDiarySettings(settings));
      setSettingsNotice('已保存');
      setTimeout(() => { setSettingsNotice(null); setIsSettingsOpen(false); }, 1000);
    } catch (err: any) {
      setSettingsNotice(`保存失败：${err.message}`);
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

      {/* 没有顶栏：返回和设置是两颗浮着的小钮，标题落在中间 */}
      <header className="carnet-head">
        <button type="button" onClick={onBackToHome} className="carnet-float-btn" aria-label="回到首页">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="carnet-title">
          <h1 className="font-calligraphy">Carnets des Confidences</h1>
          <p className="font-calligraphy">Les journaux intimes de la maison</p>
        </div>
        <button type="button" onClick={handleOpenSettings} className="carnet-float-btn" aria-label="日记设置" title="日记设置">
          <Settings className="w-4 h-4" />
        </button>
      </header>

      <div className="carnet-stage-wrap">
        <div className="carnet-stage">
          {/* 使用者自己那本：摊开着，羽毛笔搁在上面 */}
          <button
            type="button"
            className="carnet-mine"
            data-opening={openingId === MINE_ID || undefined}
            onClick={() => pickUp(MINE_ID, () => setMineOpen(true))}
            aria-label="翻开使用者自己的手记 Mon Journal"
          >
            <img src={`${CARNET}mine-open.webp`} alt="" draggable={false} />
            <span className="carnet-mine-tag font-calligraphy">Mon Journal</span>
          </button>

          {/* 草地上的小东西：有的压着书角 */}
          <img src={`${CARNET}seal.webp`} alt="" aria-hidden="true" className="carnet-deco" style={{ left: '42%', top: '52%', width: '14%', rotate: '-8deg' }} />
          <img src={`${CARNET}rose.webp`} alt="" aria-hidden="true" className="carnet-deco" style={{ left: '38%', top: '58%', width: '16%', rotate: '24deg' }} />

          {books.slice(0, SLOTS.length).map((book, i) => {
            const slot = SLOTS[i];
            const cover = covers[i];
            const [ox, oy] = OVAL[cover];
            return (
              <button
                key={book.agentId}
                type="button"
                onClick={() => pickUp(book.agentId, () => setSelectedBook(book))}
                className="carnet-book"
                data-opening={openingId === book.agentId || undefined}
                style={{
                  left: `${slot.left}%`,
                  top: `${slot.top}%`,
                  '--rot': `${slot.rot}deg`,
                  '--delay': `${i * 70}ms`,
                } as React.CSSProperties}
                aria-label={`翻开${book.agentName}的手记`}
              >
                <img src={`${CARNET}cover-${cover}.webp`} alt="" draggable={false} className="carnet-book-cover" />
                <span className="carnet-cameo" style={{ left: `${ox}%`, top: `${oy}%` }} aria-hidden="true">
                  {book.avatarUrl ? (
                    <img src={book.avatarUrl} alt="" draggable={false} />
                  ) : (
                    <span>{book.agentName.slice(0, 1)}</span>
                  )}
                </span>
                {/* 系在书角的小纸签 */}
                <span
                  className="carnet-tag"
                  data-side={slot.tag}
                  style={{ backgroundImage: `url(${CARNET}${SCRAPS[i % SCRAPS.length]}.webp)`, bottom: `${slot.tagBottom}%` }}
                  aria-hidden="true"
                >
                  {book.agentName}
                </span>
              </button>
            );
          })}

          {/* 书多于六本时，剩下的轻轻叠在池边 */}
          {books.slice(SLOTS.length).map((book, j) => (
            <button
              key={book.agentId}
              type="button"
              onClick={() => pickUp(book.agentId, () => setSelectedBook(book))}
              className="carnet-book carnet-book--extra"
              data-opening={openingId === book.agentId || undefined}
              style={{ left: `${4 + (j % 4) * 24}%`, top: '86%', '--rot': `${j % 2 ? 6 : -6}deg` } as React.CSSProperties}
              aria-label={`翻开${book.agentName}的手记`}
            >
              <img src={`${CARNET}cover-${COVERS[j % COVERS.length].name}.webp`} alt="" draggable={false} className="carnet-book-cover" />
              <span className="carnet-tag" data-side="right" style={{ backgroundImage: `url(${CARNET}scrap-1.webp)` }} aria-hidden="true">
                {book.agentName}
              </span>
            </button>
          ))}

          {/* 压在书上的花，不挡点击 */}
          <img src={`${CARNET}daisy.webp`} alt="" aria-hidden="true" className="carnet-deco carnet-deco--over" style={{ left: '-4%', top: '64%', width: '15%', rotate: '-18deg' }} />
          <img src={`${CARNET}forgetmenot.webp`} alt="" aria-hidden="true" className="carnet-deco carnet-deco--over" style={{ left: '86%', top: '33%', width: '16%', rotate: '14deg' }} />
          <img src={`${CARNET}ginkgo.webp`} alt="" aria-hidden="true" className="carnet-deco carnet-deco--over" style={{ left: '78%', top: '84%', width: '15%', rotate: '-30deg' }} />

          {loading && books.length === 0 && <p className="carnet-whisper">正在把手记拿到草地上…</p>}
          {!loading && books.length === 0 && <p className="carnet-whisper">草地上还空着。家人想写的时候，手记会落在这里。</p>}

          {/* 飘落的花瓣和萤火 */}
          <div className="carnet-air" aria-hidden="true">
            {PETALS.map((p, i) => (
              <span key={`p${i}`} className="carnet-petal" style={{ left: `${p.left}%`, top: `${p.top}%`, animationDelay: `${p.delay}s`, animationDuration: `${p.dur}s` }} />
            ))}
            {FIREFLIES.map((f, i) => (
              <span key={`f${i}`} className="carnet-firefly" style={{ left: `${f.left}%`, top: `${f.top}%`, animationDelay: `${f.delay}s` }} />
            ))}
          </div>
        </div>
      </div>

      {/* 日记设置 */}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/25" onClick={() => setIsSettingsOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="日记设置" className="diary-contents" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between pb-2 mb-3 diary-contents-head">
              <h3 className="text-sm font-serif font-semibold">日记设置</h3>
              <button type="button" onClick={() => setIsSettingsOpen(false)} className="diary-quiet-btn" aria-label="关闭">
                <X className="w-4 h-4" />
              </button>
            </div>

            <section className="text-xs font-serif pb-4 mb-4 diary-settings-section">
              <h4 className="diary-settings-heading">阅读 <span>只在这台手机上</span></h4>
              <DiaryReadingControls />
            </section>

            <h4 className="diary-settings-heading text-xs font-serif">自动提笔 <span>跟着桌面小屋走</span></h4>
            {!settings ? (
              <p className="text-xs font-serif text-stone-600 py-3 text-center">{settingsNotice || '正在问桌面…'}</p>
            ) : (
              <div className="space-y-4 text-xs font-serif">
                <label className="flex items-center justify-between gap-3">
                  <span>
                    <span className="block font-semibold text-stone-900">自主提笔</span>
                    <span className="block text-[11px] text-stone-500 mt-0.5">跟随自由时间，由每位家人决定什么时候想写，也可以不写</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.autoGenerate}
                    onChange={(e) => setSettings({ ...settings, autoGenerate: e.target.checked })}
                    className="w-4 h-4 accent-amber-700"
                  />
                </label>

                <fieldset className="space-y-1.5">
                  <legend className="text-stone-600 mb-1">参与的家人</legend>
                  {books.map((book) => (
                    <label key={book.agentId} className="flex items-center justify-between py-1.5 diary-settings-row">
                      <span className="text-stone-800">{book.agentName}</span>
                      <input
                        type="checkbox"
                        checked={settings.targetAgentIds.includes(book.agentId)}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...settings.targetAgentIds, book.agentId]
                            : settings.targetAgentIds.filter((id) => id !== book.agentId);
                          setSettings({ ...settings, targetAgentIds: next });
                        }}
                        className="w-3.5 h-3.5 accent-amber-700"
                      />
                    </label>
                  ))}
                </fieldset>

                {settingsNotice && <p role="status" className="text-center text-[11px] text-stone-600">{settingsNotice}</p>}

                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={() => setIsSettingsOpen(false)} className="diary-quiet-btn">取消</button>
                  <button type="button" disabled={settingsSaving} onClick={handleSaveSettings} className="diary-solid-btn">
                    {settingsSaving ? '保存中…' : '保存'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
