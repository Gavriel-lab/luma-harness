import React, { useEffect, useRef, useState } from 'react';
import { RotateCcw, Type } from 'lucide-react';
import type { Store } from '../ui/useAppStore';
import {
  DEFAULT_READING_PREFERENCES,
  type FontFamilyOption,
  type ReadingPreferences,
} from '../types';
import { compileFontCss } from '../utils/customFont';
import { Avatar } from './Avatar';

export const FONT_STACK_MAP: Record<FontFamilyOption, { label: string; stack: string; note: string }> = {
  system: {
    label: '系统默认',
    stack: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    note: '跟随操作系统与界面的自然排版',
  },
  'sans-serif': {
    label: '无衬线 (现代清晰)',
    stack: '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    note: '柔和清晰的黑体字栈，适合日常快速阅读',
  },
  serif: {
    label: '衬线 (书卷质感)',
    stack: '"Songti SC", "Noto Serif SC", "Source Han Serif SC", "SimSun", "STSong", Georgia, serif',
    note: '优雅舒缓的宋体字栈，适合长文与对话沉浸',
  },
  monospace: {
    label: '等宽 (代码技术)',
    stack: '"Cascadia Code", "Consolas", "Courier New", monospace',
    note: '固定宽度字符，字符画与结构化排版不撑破错位',
  },
};

export function ReadingSettingsPanel({ store }: { store: Store }) {
  const { data, dispatch } = store;
  const reading: ReadingPreferences = data.preferences.reading || DEFAULT_READING_PREFERENCES;
  const [fontCss, setFontCss] = useState(reading.customFontCss || '');
  const [fontBusy, setFontBusy] = useState(false);
  const [fontNotice, setFontNotice] = useState('');
  const fontRequest = useRef<AbortController | null>(null);
  useEffect(() => { setFontCss(reading.customFontCss || ''); }, [reading.customFontCss]);
  useEffect(() => () => { fontRequest.current?.abort(); fontRequest.current = null; }, []);

  const update = (patch: Partial<ReadingPreferences>) => {
    dispatch({
      type: 'setReadingPreferences',
      reading: patch,
    });
  };

  const resetDefault = () => {
    fontRequest.current?.abort();
    fontRequest.current = null;
    setFontBusy(false);
    setFontCss('');
    setFontNotice('');
    dispatch({
      type: 'setReadingPreferences',
      reading: { ...DEFAULT_READING_PREFERENCES, customFontCss: '', customFontStyle: '' },
    });
  };

  const applyFont = async () => {
    fontRequest.current?.abort();
    const request = new AbortController();
    fontRequest.current = request;
    const timeout = window.setTimeout(() => request.abort(), 20000);
    setFontBusy(true);
    setFontNotice('');
    try {
      const compiled = await compileFontCss(fontCss, request.signal);
      if (request.signal.aborted) return;
      update({ customFontCss: fontCss, customFontStyle: compiled });
      setFontNotice(compiled ? '全局字体已应用。' : '已恢复内置字体。');
    } catch (error) {
      if (fontRequest.current === request) setFontNotice(request.signal.aborted ? '下载超时，请检查网络后重试。' : (error instanceof Error ? error.message : '字体未能应用，请检查 CSS。'));
    } finally {
      window.clearTimeout(timeout);
      if (fontRequest.current === request) setFontBusy(false);
    }
  };

  const clearFont = () => {
    fontRequest.current?.abort();
    fontRequest.current = null;
    setFontBusy(false);
    setFontCss('');
    setFontNotice('已恢复内置字体。');
    update({ customFontCss: '', customFontStyle: '' });
  };

  const previewStyle = {
    '--chat-font-family': FONT_STACK_MAP[reading.fontFamily]?.stack || FONT_STACK_MAP.system.stack,
    '--chat-font-size': `${reading.fontSize}px`,
    '--chat-line-height': reading.lineHeight,
    '--chat-message-spacing': `${reading.messageSpacing}px`,
  } as React.CSSProperties;

  return (
    <div className="reading-settings" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 字体选择 */}
      <div className="field-group">
        <label className="label" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <Type size={15} aria-hidden /> 字体风格
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
          {(Object.keys(FONT_STACK_MAP) as FontFamilyOption[]).map((key) => {
            const item = FONT_STACK_MAP[key];
            const isSelected = reading.fontFamily === key && !reading.customFontStyle;
            return (
              <button
                key={key}
                type="button"
                className={`btn ${isSelected ? 'btn--primary' : 'btn--ghost'}`}
                style={{
                  padding: '8px 10px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  minHeight: 52,
                  fontFamily: item.stack,
                  textAlign: 'left',
                }}
                onClick={() => { clearFont(); update({ fontFamily: key }); }}
                data-testid={`font-option-${key}`}
              >
                <span style={{ fontWeight: 600, fontSize: 13 }}>{item.label}</span>
                <span style={{ fontSize: 10, opacity: 0.75, marginTop: 2, fontFamily: 'var(--font-body)' }}>
                  {item.note.slice(0, 14)}…
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="field-group">
        <label className="label" htmlFor="reading-custom-font-css">自定义全局字体 CSS</label>
        <p className="help" style={{ margin: '4px 0 8px' }}>粘贴字体网站的常规 CSS，支持 @import 和 @font-face。应用后，小屋界面与聊天一起换字体。</p>
        <textarea id="reading-custom-font-css" className="textarea" rows={5} value={fontCss} disabled={fontBusy}
          onChange={event => setFontCss(event.target.value)} maxLength={20000} spellCheck={false}
          placeholder={'@import url("https://fontsapi.zeoseven.com/309/main/result.css");\nbody { font-family: "KingHwaOldSong"; font-weight: normal; }'}
          style={{ width: '100%', fontFamily: 'Consolas, monospace', fontSize: 12 }}
          data-testid="reading-custom-font-css" />
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <button type="button" className="btn btn--primary" onClick={applyFont} disabled={fontBusy || !fontCss.trim()} data-testid="reading-apply-custom-font">{fontBusy ? '正在读取字体…' : '应用字体'}</button>
          <button type="button" className="btn btn--ghost" onClick={clearFont} data-testid="reading-clear-custom-font">清除自定义字体</button>
          <span role="status" className="help" style={{ margin: 0 }}>{fontNotice}</span>
        </div>
      </div>

      {/* 字号、行距、消息间距 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
        {/* 字号 */}
        <div className="field-group">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <label className="label" htmlFor="reading-font-size">字号大小</label>
            <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>{reading.fontSize} px</span>
          </div>
          <input
            id="reading-font-size"
            type="range"
            min={12}
            max={22}
            step={1}
            value={reading.fontSize}
            onChange={(e) => update({ fontSize: Number(e.target.value) })}
            style={{ width: '100%' }}
            data-testid="reading-font-size-slider"
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-sub)' }}>
            <span>12px 紧凑</span>
            <span>默认 15px</span>
            <span>22px 舒适</span>
          </div>
        </div>

        {/* 行距 */}
        <div className="field-group">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <label className="label" htmlFor="reading-line-height">行距高低</label>
            <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>{reading.lineHeight}</span>
          </div>
          <input
            id="reading-line-height"
            type="range"
            min={1.3}
            max={2.0}
            step={0.05}
            value={reading.lineHeight}
            onChange={(e) => update({ lineHeight: Number(e.target.value) })}
            style={{ width: '100%' }}
            data-testid="reading-line-height-slider"
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-sub)' }}>
            <span>1.3 密集</span>
            <span>默认 1.6</span>
            <span>2.0 舒朗</span>
          </div>
        </div>

        {/* 消息间距 */}
        <div className="field-group">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <label className="label" htmlFor="reading-msg-spacing">消息垂直间距</label>
            <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>{reading.messageSpacing} px</span>
          </div>
          <input
            id="reading-msg-spacing"
            type="range"
            min={4}
            max={24}
            step={1}
            value={reading.messageSpacing}
            onChange={(e) => update({ messageSpacing: Number(e.target.value) })}
            style={{ width: '100%' }}
            data-testid="reading-spacing-slider"
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-sub)' }}>
            <span>4px 紧贴</span>
            <span>默认 12px</span>
            <span>24px 宽阔</span>
          </div>
        </div>
      </div>

      {/* 实时预览卡片 */}
      <div className="field-group">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <label className="label">实时效果预览</label>
          <button
            type="button"
            className="btn btn--ghost"
            style={{ fontSize: 11, padding: '2px 8px', minHeight: 24 }}
            onClick={resetDefault}
            title="恢复默认排版参数"
            data-testid="reading-reset-defaults"
          >
            <RotateCcw size={12} style={{ marginRight: 4 }} />
            恢复默认
          </button>
        </div>
        <div
          className="chat__log"
          style={{
            ...previewStyle,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '12px 14px',
            maxHeight: 180,
            overflowY: 'auto',
          }}
        >
          <div className="msg">
            <Avatar agent={data.agents.find(agent => agent.id === 'agent_owner')} className="msg__avatar" />
            <div className="msg__body">
              <div className="msg__meta">
                <span className="msg__who">使用者</span>
                <time>13:26</time>
              </div>
              <div className="msg__bubble">
                今天风很轻，你在身边吗？
                {'\n\n'}
                这段文字用于预览字号、行距与消息留白。
              </div>
            </div>
          </div>

          <div className="msg msg--self">
            <Avatar agent={data.agents.find(agent => agent.id === 'agent_coordinator')} className="msg__avatar" />
            <div className="msg__body">
              <div className="msg__meta">
                <span className="msg__who">协调者</span>
                <time>13:27</time>
              </div>
              <div className="msg__bubble">
                在。一直在你身后，随时可以靠过来。
                {'\n'}
                无论窗口大小如何调节，排版都保持舒适自然。
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
