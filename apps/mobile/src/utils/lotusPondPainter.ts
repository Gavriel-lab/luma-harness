/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// 高分辨率莫奈睡莲池塘原画离屏生成器，作为初始 WebGL 纹理备用，防止首屏闪白

let cachedDataUrl: string | null = null;

export function getMonetLotusPondDataUrl(): string {
  if (cachedDataUrl) return cachedDataUrl;

  const canvas = document.createElement('canvas');
  // iPhone 14 Pro Max 2x DPR 物理像素 (860 × 1864)
  canvas.width = 860;
  canvas.height = 1864;
  const ctx = canvas.getContext('2d');

  if (!ctx) return '';

  const w = 860;
  const h = 1864;

  // 1. 水天相映底色 (晨曦雾蓝渐变到粉黛湖光)
  const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
  bgGrad.addColorStop(0, '#c5d5da');     // 顶部浅雾蓝
  bgGrad.addColorStop(0.18, '#edd9ca');  // 晨光旧粉
  bgGrad.addColorStop(0.42, '#b6cdd6');  // 开阔水面淡蓝
  bgGrad.addColorStop(0.72, '#a5babe');  // 湖水中段青灰
  bgGrad.addColorStop(1, '#8ca3a8');     // 下游暗青
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, w, h);

  // 2. 远方迷蒙树影与晨曦反光 (Distant Woods & Sky Reflection)
  const treeGrad = ctx.createLinearGradient(0, 100, 0, 560);
  treeGrad.addColorStop(0, 'rgba(150, 172, 155, 0.75)');
  treeGrad.addColorStop(0.45, 'rgba(215, 182, 172, 0.6)');
  treeGrad.addColorStop(1, 'rgba(168, 188, 178, 0.2)');

  ctx.fillStyle = treeGrad;
  ctx.beginPath();
  ctx.moveTo(0, 240);
  ctx.bezierCurveTo(160, 160, 280, 280, 440, 200);
  ctx.bezierCurveTo(600, 140, 720, 260, w, 220);
  ctx.lineTo(w, 480);
  ctx.lineTo(0, 480);
  ctx.closePath();
  ctx.fill();

  // 3. 水面中央开阔反光光带 (Impressionist Light Swatches)
  for (let i = 0; i < 28; i++) {
    const y = 360 + i * 46;
    const xMid = w * 0.44 + Math.sin(i * 0.5) * 45;
    const strokeW = 180 + Math.sin(i * 1.3) * 90;
    const strokeH = 14 + (i % 3) * 6;

    const strokeGrad = ctx.createLinearGradient(xMid - strokeW / 2, y, xMid + strokeW / 2, y);
    strokeGrad.addColorStop(0, 'transparent');
    strokeGrad.addColorStop(0.25, 'rgba(245, 218, 195, 0.45)');
    strokeGrad.addColorStop(0.5, 'rgba(255, 238, 210, 0.6)');
    strokeGrad.addColorStop(0.75, 'rgba(240, 205, 190, 0.45)');
    strokeGrad.addColorStop(1, 'transparent');

    ctx.fillStyle = strokeGrad;
    ctx.fillRect(xMid - strokeW / 2, y, strokeW, strokeH);
  }

  // 4. 画面顶部垂柳淡影 (Weeping Willow Silhouette - 与原画构图一致)
  ctx.fillStyle = 'rgba(115, 135, 118, 0.65)';
  for (let b = 0; b < 6; b++) {
    const bx = (b / 5) * w;
    ctx.beginPath();
    ctx.moveTo(bx - 30, 0);
    ctx.quadraticCurveTo(bx + 40, 220, bx - 10, 420);
    ctx.quadraticCurveTo(bx - 40, 220, bx - 30, 0);
    ctx.fill();
  }

  // 5. 画面右下角盛开粉白睡莲与大荷叶 (Lotus & Leaves)
  ctx.save();
  ctx.translate(w * 0.78, h * 0.85);

  // 荷叶底斑
  ctx.fillStyle = 'rgba(105, 130, 115, 0.85)';
  ctx.beginPath();
  ctx.ellipse(0, 0, 190, 120, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(-160, 60, 160, 100, 0, 0, Math.PI * 2);
  ctx.fill();

  // 盛开粉白花瓣
  for (let p = 0; p < 12; p++) {
    const angle = (p / 12) * Math.PI * 2;
    ctx.save();
    ctx.rotate(angle);
    ctx.translate(0, -55);
    const pGrad = ctx.createLinearGradient(0, 0, 0, -50);
    pGrad.addColorStop(0, '#fef9f0');
    pGrad.addColorStop(0.6, '#f3cfca');
    pGrad.addColorStop(1, '#c98e8b');
    ctx.fillStyle = pGrad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(-18, -25, 0, -52);
    ctx.quadraticCurveTo(18, -25, 0, 0);
    ctx.fill();
    ctx.restore();
  }
  // 金黄花蕊
  ctx.beginPath();
  ctx.arc(0, 0, 18, 0, Math.PI * 2);
  ctx.fillStyle = '#f2be58';
  ctx.fill();

  ctx.restore();

  // 6. 左下角水生野草
  ctx.fillStyle = 'rgba(118, 142, 124, 0.75)';
  for (let r = 0; r < 14; r++) {
    const rx = 40 + r * 16;
    ctx.beginPath();
    ctx.moveTo(rx, h);
    ctx.quadraticCurveTo(rx + 25, h - 180, rx + (r % 2 === 0 ? 35 : -15), h - 280);
    ctx.lineTo(rx + 8, h);
    ctx.fill();
  }

  // 细微亚麻布纹理叠加
  ctx.fillStyle = 'rgba(120, 100, 80, 0.035)';
  for (let y = 0; y < h; y += 4) {
    ctx.fillRect(0, y, w, 1);
  }

  cachedDataUrl = canvas.toDataURL('image/jpeg', 0.92);
  return cachedDataUrl;
}
