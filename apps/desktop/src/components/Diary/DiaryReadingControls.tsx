/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * 桌面日记馆阅读偏好控制面板
 */
import React, { useState } from 'react';
import {
  DIARY_FONTS,
  DIARY_SIZES,
  setDiaryReadingPrefs,
  useDiaryReading,
} from '../../utils/diaryReading';
import { compileFontCss } from '../../utils/customFont';

export const DiaryReadingControls: React.FC = () => {
  const { prefs } = useDiaryReading();
  const [customOpen, setCustomOpen] = useState(false);
  const [cssInput, setCssInput] = useState(prefs.customFontCss || '');
  const [status, setStatus] = useState<string | null>(null);

  const handleApplyCss = async () => {
    if (!cssInput.trim()) {
      setDiaryReadingPrefs({ customFontCss: '', customFontStyle: '', font: 'song' });
      setStatus('已清除自定义字体');
      return;
    }
    try {
      setStatus('正在编译字体 CSS…');
      const compiled = await compileFontCss(cssInput);
      setDiaryReadingPrefs({
        customFontCss: cssInput,
        customFontStyle: compiled,
        font: 'custom',
      });
      setStatus('已应用自定义字体');
      setTimeout(() => setStatus(null), 2500);
    } catch (err: any) {
      setStatus(`应用失败: ${err.message}`);
    }
  };

  return (
    <div className="diary-reading-controls space-y-4">
      <div>
        <label className="block text-xs font-semibold text-stone-700 mb-2">正文字体</label>
        <div className="grid grid-cols-2 gap-2">
          {DIARY_FONTS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setDiaryReadingPrefs({ font: f.id })}
              className={`diary-font-btn ${prefs.font === f.id ? 'is-active' : ''}`}
            >
              <span className="diary-font-sample" style={{ fontFamily: f.stack }}>今日微凉</span>
              <span className="diary-font-name">{f.label}</span>
              <span className="diary-font-desc">{f.note}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-stone-200/60">
        <label className="text-xs font-semibold text-stone-700">字号大小</label>
        <div className="flex gap-2">
          {DIARY_SIZES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setDiaryReadingPrefs({ size: s.id })}
              className={`diary-size-btn ${prefs.size === s.id ? 'is-active' : ''}`}
              style={{ fontSize: `${s.px - 3}px` }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="pt-2 border-t border-stone-200/60">
        <button
          type="button"
          onClick={() => setCustomOpen(!customOpen)}
          className="text-xs text-amber-800 hover:text-amber-900 underline underline-offset-2"
        >
          {customOpen ? '收起自定义字体设置' : '自定义网络字体 CSS'}
        </button>

        {customOpen && (
          <div className="mt-2 space-y-2">
            <textarea
              value={cssInput}
              onChange={(e) => setCssInput(e.target.value)}
              placeholder="可粘贴 Google Fonts 或其他 HTTPS @import / @font-face CSS 代码"
              rows={3}
              className="w-full text-xs p-2 rounded border border-stone-300 bg-white/80 font-mono text-stone-800 focus:outline-none focus:ring-1 focus:ring-amber-700"
            />
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-stone-500">{status}</span>
              <button
                type="button"
                onClick={handleApplyCss}
                className="px-3 py-1 bg-amber-800 text-white rounded text-xs hover:bg-amber-900"
              >
                应用自定义字体
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
