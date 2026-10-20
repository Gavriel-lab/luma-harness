/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import './splash.css';

interface SplashScreenProps {
  onComplete: () => void;
  /** 开始淡出的那一刻通知外面，首页的叶片和标题跟着浮上来 */
  onLeaveStart?: () => void;
  customLive2dImgUrl?: string | null;
}

// 时间线：雾停留 → 手指慢慢写 Luma → 写名字 → 停一会儿 → 雾、画、字一起淡出，首页从底下浮上来
const AUTO_ENTER_MS = 7600;
const LEAVE_MS = 1400;
const FONT_WAIT_MS = 1200;

export const SplashScreen: React.FC<SplashScreenProps> = ({
  onComplete,
  onLeaveStart,
  customLive2dImgUrl,
}) => {
  const [leaving, setLeaving] = useState(false);
  // 字体到位再开始写，免得先用系统字写一半再跳字
  const [ready, setReady] = useState(false);
  const doneRef = useRef(false);
  const imageUrl = customLive2dImgUrl || `${import.meta.env.BASE_URL}assets/luma-splash.webp`;

  const leave = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setLeaving(true);
    onLeaveStart?.();
    window.setTimeout(onComplete, reduced ? 300 : LEAVE_MS);
  }, [onComplete, onLeaveStart]);

  useEffect(() => {
    let alive = true;
    const go = () => alive && setReady(true);
    const fallback = window.setTimeout(go, FONT_WAIT_MS);
    document.fonts?.load('64px "Yellowtail"').then(go, go);
    return () => {
      alive = false;
      window.clearTimeout(fallback);
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const t = window.setTimeout(leave, AUTO_ENTER_MS);
    return () => window.clearTimeout(t);
  }, [ready, leave]);

  const paintingBg = { backgroundImage: `url("${imageUrl}")` };
  // 擦开的笔画：同一张画压一层灰蓝，像透过玻璃看到的、比雾暗一截的真景
  const wipedBg = {
    backgroundImage: `linear-gradient(rgba(62, 82, 98, 0.3), rgba(62, 82, 98, 0.3)), url("${imageUrl}")`,
  };

  return (
    <div
      className={`splash-root${ready ? ' is-ready' : ''}${leaving ? ' is-leaving' : ''}`}
      onClick={leave}
      role="button"
      tabIndex={0}
      aria-label="Luma，点一下进入"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') leave();
      }}
    >
      {/* 画、雾、字放在同一层里，结尾一起淡出 */}
      <div className="splash-stage">
        <div className="splash-painting" style={paintingBg} />

        <div className="splash-fog">
          <div className="splash-fog-base" />
          <div className="splash-fog-cloud splash-fog-a" />
          <div className="splash-fog-cloud splash-fog-b" />
        </div>

        {/* 手指擦出来的字：笔画里透出的是玻璃后面的画 */}
        <div className="splash-writing" aria-hidden="true">
          <div className="splash-line splash-line-1">
            <div className="splash-wet"><span>Luma</span></div>
            <div className="splash-wiped" style={wipedBg}><span>Luma</span></div>
          </div>
          <div className="splash-line splash-line-2">
            <div className="splash-wet"><span>Owner &amp; Coordinator</span></div>
            <div className="splash-wiped" style={wipedBg}><span>Owner &amp; Coordinator</span></div>
          </div>
        </div>
      </div>
    </div>
  );
};
