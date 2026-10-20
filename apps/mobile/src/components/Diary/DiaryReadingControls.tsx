/**
 * 日记阅读偏好面板：字体 + 字号 + 自定义字体，改了立刻生效，只存在这台手机上。
 * 花园页的设置里和阅读页右上角的 Aa 共用这一块。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { DIARY_SIZES, diaryReading, type ReadingStore } from '../../utils/diaryReading';

const CSS_EXAMPLE = '@import url("https://fontsapi.zeoseven.com/256/main/result.css");\n\nbody {\n  font-family: "Huiwen-mincho";\n}';

/** store 不传就是日记；书房传 studyReading，两边字体分开存 */
export const DiaryReadingControls: React.FC<{ store?: ReadingStore }> = ({ store = diaryReading }) => {
  const { fonts: allFonts, fontSlot: diaryFontSlot, setPrefs: setDiaryReadingPrefs, useReading, preload, scope } = store;
  const { prefs } = useReading();
  const custom = diaryFontSlot.useFont();
  const [tab, setTab] = useState<'local' | 'css'>('local');
  const [css, setCss] = useState('');
  const [customOpen, setCustomOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => { preload(); }, [preload]);
  useEffect(() => {
    if (custom.record?.kind === 'css') { setCss(custom.record.css); setTab('css'); }
  }, [custom.record]);

  const fonts = allFonts.filter((f) => f.id !== 'custom' || custom.record);

  // 装好就直接换上
  const afterApply = (ok: boolean) => { if (ok) setDiaryReadingPrefs({ font: 'custom' }); };

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="正文字体" className="diary-font-grid" data-count={fonts.length}>
        {fonts.map((f) => (
          <button
            key={f.id}
            type="button"
            role="radio"
            aria-checked={prefs.font === f.id}
            data-active={prefs.font === f.id || undefined}
            onClick={() => setDiaryReadingPrefs({ font: f.id })}
            className="diary-font-option"
          >
            <span className="diary-font-sample" style={{ fontFamily: f.stack }}>今日微凉</span>
            <span className="diary-font-label">{f.label}</span>
            <span className="diary-font-note">{f.id === 'custom' && custom.family ? custom.family : f.note}</span>
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-stone-600">字号</span>
        <div role="radiogroup" aria-label="正文字号" className="diary-size-group">
          {DIARY_SIZES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={prefs.size === s.id}
              data-active={prefs.size === s.id || undefined}
              onClick={() => setDiaryReadingPrefs({ size: s.id })}
              className="diary-size-option"
              style={{ fontSize: `${s.px - 3}px` }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* 自定义字体：本地文件或字体 CSS，跟聊天页那套一样，但分开存 */}
      <div className="diary-custom-font">
        <button
          type="button"
          onClick={() => setCustomOpen(!customOpen)}
          aria-expanded={customOpen}
          className="diary-custom-toggle"
        >
          <span>自定义字体</span>
          <span className="text-stone-500">{custom.record ? '已装上一款' : '上传或粘贴 CSS'} {customOpen ? '▴' : '▾'}</span>
        </button>

        {customOpen && (
          <div className="space-y-2 pt-2">
            <div className="flex gap-2">
              {(['local', 'css'] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={tab === id}
                  data-active={tab === id || undefined}
                  onClick={() => setTab(id)}
                  className="diary-tab"
                >
                  {id === 'local' ? '本地字体' : 'CSS 字体'}
                </button>
              ))}
            </div>

            {tab === 'local' ? (
              <div className="space-y-1.5">
                <input
                  ref={fileInput}
                  aria-label="上传本地字体文件"
                  type="file"
                  accept=".ttf,.otf,.woff,.woff2"
                  className="sr-only"
                  disabled={custom.busy}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) afterApply(await diaryFontSlot.upload(file));
                  }}
                />
                <button type="button" disabled={custom.busy} onClick={() => fileInput.current?.click()} className="diary-upload-btn">
                  <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                  上传字体文件
                </button>
                <p className="diary-hint">支持 TTF、OTF、WOFF、WOFF2，最大 30 MB，可以在手机「文件」里选。</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <textarea
                  aria-label="字体 CSS 代码"
                  value={css}
                  onChange={(e) => setCss(e.target.value)}
                  placeholder={CSS_EXAMPLE}
                  maxLength={20000}
                  rows={4}
                  spellCheck={false}
                  className="diary-css-input"
                />
                <button
                  type="button"
                  disabled={custom.busy || !css.trim()}
                  onClick={async () => afterApply(await diaryFontSlot.applyCss(css))}
                  className="diary-upload-btn"
                >
                  应用字体
                </button>
                <p className="diary-hint">粘贴字体网站给的 @import / @font-face 代码，或者直接贴字体 CSS 链接。</p>
              </div>
            )}

            <p role="status" className="diary-hint" data-error={custom.error ? true : undefined}>
              {custom.busy ? (
                <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />正在加载字体…</span>
              ) : (
                custom.error || (custom.record ? `已装上：${custom.family}。只用在${scope}里，别处的字体不受影响。` : `只用在${scope}里，别处的字体不受影响。`)
              )}
            </p>

            {custom.record && (
              <button
                type="button"
                disabled={custom.busy}
                onClick={async () => {
                  if (await diaryFontSlot.reset()) setDiaryReadingPrefs({ font: 'song' });
                }}
                className="diary-quiet-btn"
              >
                移除这款字体
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
