/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from 'react';

interface WaterRippleTransitionProps {
  origin: { x: number; y: number };
  onComplete: () => void;
  children: React.ReactNode;
}

export const WaterRippleTransition: React.FC<WaterRippleTransitionProps> = ({
  origin,
  onComplete,
  children
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const maxRadius = Math.hypot(
      Math.max(origin.x, width - origin.x),
      Math.max(origin.y, height - origin.y)
    ) * 1.15;

    const startTime = performance.now();
    const duration = 1100;
    const seed = Math.random() * 20;

    let animId: number;

    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      const ease = 1 - Math.pow(1 - progress, 2.5);
      const r = 10 + (maxRadius - 10) * ease;

      ctx.clearRect(0, 0, width, height);

      // 绘制水波晕染轮廓
      ctx.save();
      ctx.beginPath();
      const segments = 60;
      for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        const noise =
          Math.sin(theta * 6 + seed) * 0.14 +
          Math.cos(theta * 8 - seed) * 0.09;
        const currentR = r * (1 + noise);
        const px = origin.x + Math.cos(theta) * currentR;
        const py = origin.y + Math.sin(theta) * currentR;

        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();

      // 水波边缘反光与颜料光泽感
      ctx.strokeStyle = 'rgba(235, 240, 245, 0.45)';
      ctx.lineWidth = 4;
      ctx.stroke();

      // 水光微光环
      ctx.beginPath();
      ctx.arc(origin.x, origin.y, r * 0.95, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.restore();

      if (progress < 1) {
        animId = requestAnimationFrame(animate);
      } else {
        onComplete();
      }
    };

    animId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [origin, onComplete]);

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden">
      {/* 渐入的目标页面 */}
      <div className="w-full h-full animate-[fadeIn_0.9s_ease-out_forwards]">
        {children}
      </div>

      {/* 表面水波扰动层 */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none z-50"
      />
    </div>
  );
};
