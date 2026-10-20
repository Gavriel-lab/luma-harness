/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from 'react';

interface Live2DLotusPondProps {
  customImageUrl?: string | null;
  interactive?: boolean;
  onTapWater?: (x: number, y: number) => void;
  className?: string;
}

interface Particle {
  x: number;
  y: number;
  size: number;
  speedX: number;
  speedY: number;
  opacity: number;
  phase: number;
}

interface Ripple {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  opacity: number;
  speed: number;
  distortion: number;
}

export const Live2DLotusPond: React.FC<Live2DLotusPondProps> = ({
  customImageUrl,
  interactive = true,
  onTapWater,
  className = ''
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const customImgRef = useRef<HTMLImageElement | null>(null);

  // 视差跟踪
  const parallaxRef = useRef({ targetX: 0, targetY: 0, currentX: 0, currentY: 0 });
  const ripplesRef = useRef<Ripple[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const animFrameRef = useRef<number | null>(null);

  // 预载用户上传的睡莲原画
  useEffect(() => {
    if (customImageUrl) {
      const img = new Image();
      img.src = customImageUrl;
      img.onload = () => {
        customImgRef.current = img;
      };
    } else {
      customImgRef.current = null;
    }
  }, [customImageUrl]);

  // 初始化晨曦微光与花粉光斑微粒
  useEffect(() => {
    const particles: Particle[] = [];
    for (let i = 0; i < 28; i++) {
      particles.push({
        x: Math.random() * 430,
        y: Math.random() * 932,
        size: Math.random() * 2.2 + 1.2,
        speedX: (Math.random() - 0.5) * 0.35 + 0.12,
        speedY: -Math.random() * 0.45 - 0.18,
        opacity: Math.random() * 0.45 + 0.25,
        phase: Math.random() * Math.PI * 2
      });
    }
    particlesRef.current = particles;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 430;
    let height = 932;

    const resize = () => {
      if (!canvas || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      width = rect.width || 430;
      height = rect.height || 932;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.scale(dpr, dpr);
    };

    resize();
    window.addEventListener('resize', resize);

    const startTime = performance.now();

    const render = (timeNow: number) => {
      const elapsed = (timeNow - startTime) / 1000;

      // 平滑插值计算视差位移
      const p = parallaxRef.current;
      p.currentX += (p.targetX - p.currentX) * 0.05;
      p.currentY += (p.targetY - p.currentY) * 0.05;

      ctx.clearRect(0, 0, width, height);

      // --- 1. 背景底层（纯净莫奈原画底图 + 2.5D 平滑视差） ---
      ctx.save();
      ctx.translate(p.currentX * 8, p.currentY * 5);

      if (customImgRef.current && customImgRef.current.complete) {
        // 绘制原画，微幅外扩以支持视差位移时不露黑边
        const scale = Math.max(width / customImgRef.current.width, height / customImgRef.current.height) * 1.05;
        const dw = customImgRef.current.width * scale;
        const dh = customImgRef.current.height * scale;
        const dx = (width - dw) / 2;
        const dy = (height - dh) / 2;
        ctx.drawImage(customImgRef.current, dx, dy, dw, dh);
      } else {
        // 莫奈水天原画底图
        drawMonetLotusPondBase(ctx, width, height, elapsed);
      }
      ctx.restore();

      // --- 2. Live2D 水面流动波光 (纯净波光粼粼光斑与反射) ---
      ctx.save();
      drawWaterSurfaceShimmer(ctx, width, height, elapsed, p.currentX);
      ctx.restore();

      // --- 3. Live2D 交互水圈波纹 (手指轻触水面时的同心水波) ---
      ctx.save();
      const activeRipples: Ripple[] = [];
      for (const r of ripplesRef.current) {
        r.radius += r.speed;
        r.opacity = Math.max(0, 1 - r.radius / r.maxRadius);

        if (r.opacity > 0) {
          ctx.save();
          ctx.beginPath();
          const segments = 48;
          for (let i = 0; i <= segments; i++) {
            const theta = (i / segments) * Math.PI * 2;
            const noise = Math.sin(theta * 6 + r.distortion) * 0.08 + Math.cos(theta * 8) * 0.05;
            const currentR = r.radius * (1 + noise);
            const px = r.x + Math.cos(theta) * currentR;
            const py = r.y + Math.sin(theta) * currentR * 0.65; // 水面透视压扁
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.strokeStyle = `rgba(255, 250, 240, ${r.opacity * 0.55})`;
          ctx.lineWidth = Math.max(1, 2.5 * r.opacity);
          ctx.stroke();

          // 内圈微光
          ctx.beginPath();
          ctx.ellipse(r.x, r.y, r.radius * 0.82, r.radius * 0.82 * 0.65, 0, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(240, 220, 200, ${r.opacity * 0.3})`;
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.restore();

          activeRipples.push(r);
        }
      }
      ripplesRef.current = activeRipples;
      ctx.restore();

      // --- 4. Live2D 晨曦微光浮尘微粒 (漂浮花粉与水汽光斑) ---
      ctx.save();
      for (const pt of particlesRef.current) {
        pt.x += pt.speedX + Math.sin(elapsed + pt.phase) * 0.25;
        pt.y += pt.speedY;
        if (pt.y < -10) pt.y = height + 10;
        if (pt.x < -10) pt.x = width + 10;
        if (pt.x > width + 10) pt.x = -10;

        const pulse = 0.7 + Math.sin(elapsed * 2 + pt.phase) * 0.3;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.size * pulse, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 242, 215, ${pt.opacity * pulse})`;
        ctx.shadowColor = 'rgba(255, 230, 180, 0.5)';
        ctx.shadowBlur = 5;
        ctx.fill();
      }
      ctx.restore();

      // 亚麻微细织纹滤镜叠加
      ctx.fillStyle = 'rgba(240, 230, 215, 0.04)';
      ctx.fillRect(0, 0, width, height);

      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);

    return () => {
      window.removeEventListener('resize', resize);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  // 鼠标与手指交互：更新视差与触发落水涟漪
  const handlePointerMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!interactive || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const clientX = 'touches' in e && e.touches.length > 0 ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const clientY = 'touches' in e && e.touches.length > 0 ? e.touches[0].clientY : (e as React.MouseEvent).clientY;

    const normX = (clientX - rect.left) / rect.width - 0.5;
    const normY = (clientY - rect.top) / rect.height - 0.5;

    parallaxRef.current.targetX = normX;
    parallaxRef.current.targetY = normY;
  };

  const handlePointerDown = (e: React.MouseEvent | React.TouchEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const clientX = 'touches' in e && e.touches.length > 0 ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const clientY = 'touches' in e && e.touches.length > 0 ? e.touches[0].clientY : (e as React.MouseEvent).clientY;

    const x = clientX - rect.left;
    const y = clientY - rect.top;

    // 添加 Live2D 水波涟漪
    ripplesRef.current.push({
      x,
      y,
      radius: 4,
      maxRadius: 160 + Math.random() * 40,
      opacity: 1,
      speed: 2.2,
      distortion: Math.random() * 10
    });

    if (onTapWater) {
      onTapWater(x, y);
    }
  };

  return (
    <div
      ref={containerRef}
      onMouseMove={handlePointerMove}
      onTouchMove={handlePointerMove}
      onMouseDown={handlePointerDown}
      onTouchStart={handlePointerDown}
      className={`relative w-full h-full overflow-hidden select-none ${className}`}
    >
      <canvas ref={canvasRef} className="w-full h-full block cursor-pointer" />
    </div>
  );
};

// ==========================================
// 莫奈睡莲池塘高保真水天底色
// ==========================================
function drawMonetLotusPondBase(ctx: CanvasRenderingContext2D, width: number, height: number, time: number) {
  // 1. 天光水色渐变背景 (天空与水面相映成趣)
  const skyWaterGrad = ctx.createLinearGradient(0, 0, 0, height);
  skyWaterGrad.addColorStop(0, '#c7d7dc');    // 顶部雾蓝天色
  skyWaterGrad.addColorStop(0.2, '#f2dfcf');  // 晨曦旧粉暖光
  skyWaterGrad.addColorStop(0.45, '#b9ced7'); // 水面中段波光天色
  skyWaterGrad.addColorStop(0.75, '#a4babe'); // 湖水灰蓝灰绿
  skyWaterGrad.addColorStop(1, '#8ea3a8');    // 湖底清浅墨绿
  ctx.fillStyle = skyWaterGrad;
  ctx.fillRect(0, 0, width, height);

  // 2. 远方晨雾与树影草木 (Misty Forest Reflection)
  const treeGrad = ctx.createLinearGradient(0, 50, 0, 280);
  treeGrad.addColorStop(0, 'rgba(155, 175, 160, 0.7)');
  treeGrad.addColorStop(0.5, 'rgba(215, 185, 175, 0.55)');
  treeGrad.addColorStop(1, 'rgba(170, 190, 180, 0.2)');

  ctx.fillStyle = treeGrad;
  ctx.beginPath();
  ctx.moveTo(0, 120);
  ctx.bezierCurveTo(80, 80, 140, 140, 220, 100);
  ctx.bezierCurveTo(300, 70, 360, 130, width, 110);
  ctx.lineTo(width, 240);
  ctx.lineTo(0, 240);
  ctx.closePath();
  ctx.fill();

  // 3. 水中倒映的金色晨光粉霞色块 (Impressionist Oil Brush Swatches)
  for (let i = 0; i < 18; i++) {
    const y = 180 + i * 28;
    const xMid = width * 0.45 + Math.sin(time * 0.6 + i * 0.3) * 15;
    const w = 90 + Math.sin(i * 1.5) * 45;
    const h = 10 + (i % 3) * 4;

    const strokeGrad = ctx.createLinearGradient(xMid - w / 2, y, xMid + w / 2, y);
    strokeGrad.addColorStop(0, 'transparent');
    strokeGrad.addColorStop(0.3, 'rgba(245, 218, 195, 0.5)');
    strokeGrad.addColorStop(0.5, 'rgba(255, 235, 205, 0.65)');
    strokeGrad.addColorStop(0.7, 'rgba(240, 205, 190, 0.5)');
    strokeGrad.addColorStop(1, 'transparent');

    ctx.fillStyle = strokeGrad;
    ctx.fillRect(xMid - w / 2, y, w, h);
  }
}

// ==========================================
// Live2D 动态水面流动光斑与波光函数
// ==========================================
function drawWaterSurfaceShimmer(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  time: number,
  driftX: number
) {
  // 水面微波流动高光带
  for (let i = 0; i < 22; i++) {
    const baseY = 220 + i * 26;
    const waveOffset = Math.sin(time * 1.8 + i * 0.45) * 8 + driftX * 10;
    const startX = width * 0.2 + waveOffset + Math.sin(i * 2) * 20;
    const strokeWidth = 80 + Math.cos(time + i) * 30;
    const strokeHeight = 2.5 + (i % 3) * 1.2;

    const grad = ctx.createLinearGradient(startX, baseY, startX + strokeWidth, baseY);
    grad.addColorStop(0, 'rgba(255, 245, 230, 0)');
    grad.addColorStop(0.5, `rgba(255, 248, 235, ${0.35 + Math.sin(time * 2 + i) * 0.15})`);
    grad.addColorStop(1, 'rgba(255, 245, 230, 0)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(startX + strokeWidth / 2, baseY, strokeWidth / 2, strokeHeight, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}
