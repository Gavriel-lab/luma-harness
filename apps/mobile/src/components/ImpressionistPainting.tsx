/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from 'react';

interface ImpressionistPaintingProps {
  isNight?: boolean;
  customImageUrl?: string | null;
  className?: string;
  onColorMaskReady?: (canvas: HTMLCanvasElement) => void;
}

export const ImpressionistPainting: React.FC<ImpressionistPaintingProps> = ({
  isNight = false,
  customImageUrl = null,
  className = '',
  onColorMaskReady
}) => {
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // 初始化并生成与主画 1:1 对应的隐藏色块图（红=木屋、绿=花园、蓝=木桌）
  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 430;
    canvas.height = 932;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    if (ctx) {
      // 默认清空透明
      ctx.clearRect(0, 0, 430, 932);

      // 1. 红 = 木屋 & 玻璃花房 (Top Right: x: 190 ~ 420, y: 70 ~ 330)
      ctx.fillStyle = 'rgb(255, 0, 0)';
      ctx.beginPath();
      // 精确描摹木屋与玻璃温室的轮廓
      ctx.moveTo(190, 180);
      ctx.lineTo(240, 150);
      ctx.lineTo(340, 60);
      ctx.lineTo(410, 80);
      ctx.lineTo(430, 240);
      ctx.lineTo(430, 340);
      ctx.lineTo(230, 340);
      ctx.lineTo(190, 260);
      ctx.closePath();
      ctx.fill();

      // 2. 绿 = 花园 & 猫咪 & 蔷薇拱门 (Middle: y: 320 ~ 680)
      ctx.fillStyle = 'rgb(0, 255, 0)';
      ctx.beginPath();
      ctx.rect(0, 320, 430, 360);
      ctx.fill();

      // 3. 蓝 = 木桌 & 笔灯 (Bottom: y: 680 ~ 932)
      ctx.fillStyle = 'rgb(0, 0, 255)';
      ctx.beginPath();
      ctx.rect(0, 680, 430, 252);
      ctx.fill();

      maskCanvasRef.current = canvas;
      if (onColorMaskReady) {
        onColorMaskReady(canvas);
      }
    }
  }, [onColorMaskReady]);

  // 如果用户提供了自定义上传的日夜版主画，则直接展示该画作
  if (customImageUrl) {
    return (
      <div className={`relative w-full h-full overflow-hidden ${className}`}>
        <img
          src={customImageUrl}
          alt={isNight ? '莫奈油画主画（夜间版）' : '莫奈油画主画（日间版）'}
          referrerPolicy="no-referrer"
          className="w-full h-full object-cover select-none pointer-events-none"
        />
        {/* 画布微织纹滤镜叠加 */}
        <div className="absolute inset-0 bg-stone-900/5 mix-blend-multiply pointer-events-none" />
      </div>
    );
  }

  // 默认使用高品质矢绘/油画渲染示意图（严格还原用户上传画作中的构图与细节）
  return (
    <div className={`relative w-full h-full overflow-hidden select-none pointer-events-none ${className}`}>
      <svg
        viewBox="0 0 430 932"
        className="w-full h-full object-cover"
        preserveAspectRatio="xMidYMid slice"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* 日间与夜间天空渐变 */}
          <linearGradient id="skyGrad" x1="0" y1="0" x2="0" y2="1">
            {isNight ? (
              <>
                <stop offset="0%" stopColor="#1e2a3a" />
                <stop offset="40%" stopColor="#2c3a4e" />
                <stop offset="75%" stopColor="#41485c" />
                <stop offset="100%" stopColor="#5d5a6d" />
              </>
            ) : (
              <>
                <stop offset="0%" stopColor="#b7c9d3" />
                <stop offset="25%" stopColor="#f3d4be" />
                <stop offset="55%" stopColor="#fde0c5" />
                <stop offset="100%" stopColor="#dce4dc" />
              </>
            )}
          </linearGradient>

          {/* 湖水渐变 */}
          <linearGradient id="lakeGrad" x1="0" y1="0" x2="1" y2="0.5">
            {isNight ? (
              <>
                <stop offset="0%" stopColor="#202c3b" />
                <stop offset="50%" stopColor="#3d4e61" />
                <stop offset="100%" stopColor="#283444" />
              </>
            ) : (
              <>
                <stop offset="0%" stopColor="#a3b8c4" />
                <stop offset="50%" stopColor="#f5dfc3" />
                <stop offset="100%" stopColor="#a8bcc3" />
              </>
            )}
          </linearGradient>

          {/* 远山渐变 */}
          <linearGradient id="mountainGrad" x1="0" y1="0" x2="0" y2="1">
            {isNight ? (
              <>
                <stop offset="0%" stopColor="#252f3f" />
                <stop offset="100%" stopColor="#354456" />
              </>
            ) : (
              <>
                <stop offset="0%" stopColor="#96aab6" />
                <stop offset="100%" stopColor="#b4c2c9" />
              </>
            )}
          </linearGradient>

          {/* 暖灯光晕 */}
          <radialGradient id="lampGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffebad" stopOpacity="0.9" />
            <stop offset="45%" stopColor="#ebb778" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#ebb778" stopOpacity="0" />
          </radialGradient>

          {/* 桌面木纹与阳光 */}
          <radialGradient id="tableGlow" cx="40%" cy="50%" r="60%">
            <stop offset="0%" stopColor={isNight ? "#9c7657" : "#dfbc96"} />
            <stop offset="60%" stopColor={isNight ? "#634734" : "#ad8664"} />
            <stop offset="100%" stopColor={isNight ? "#3d2b20" : "#7d5d44"} />
          </radialGradient>

          {/* 油画肌理滤镜模拟 */}
          <filter id="oilPaintEffect" x="0%" y="0%" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="3" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="3" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>

        {/* 1. 天空背景 */}
        <rect width="430" height="932" fill="url(#skyGrad)" />

        {/* 夜晚月亮或白天朝阳 */}
        {isNight ? (
          <g>
            <circle cx="120" cy="90" r="16" fill="#fdfae8" opacity="0.95" />
            <circle cx="120" cy="90" r="34" fill="#fdfae8" opacity="0.15" />
            {/* 散落繁星 */}
            {[
              [50, 40], [85, 120], [160, 60], [210, 95], [30, 160], [90, 180],
              [140, 140], [190, 40], [250, 70], [320, 45], [380, 80]
            ].map(([sx, sy], idx) => (
              <circle key={idx} cx={sx} cy={sy} r={idx % 2 === 0 ? 1.5 : 1} fill="#ffffff" opacity="0.8" />
            ))}
          </g>
        ) : (
          <g>
            <circle cx="130" cy="110" r="22" fill="#fff5dd" opacity="0.9" />
            <circle cx="130" cy="110" r="50" fill="#fde6bf" opacity="0.3" />
            <circle cx="130" cy="110" r="90" fill="#fcecd2" opacity="0.15" />
          </g>
        )}

        {/* 2. 远山与水汽 */}
        <path
          d="M0,160 Q80,120 160,150 T310,130 T430,170 L430,240 L0,240 Z"
          fill="url(#mountainGrad)"
          opacity="0.8"
        />
        <path
          d="M0,190 Q90,165 200,195 T430,185 L430,260 L0,260 Z"
          fill="url(#mountainGrad)"
          opacity="0.95"
        />

        {/* 湖水与岛屿小教堂 */}
        <rect x="0" y="210" width="220" height="90" fill="url(#lakeGrad)" />
        <ellipse cx="60" cy="225" rx="35" ry="12" fill={isNight ? "#243242" : "#7c938b"} />
        <path d="M58,212 L62,212 L60,202 Z" fill={isNight ? "#ffebad" : "#eee1d2"} />
        {/* 湖面晨光/月光波光粼粼 */}
        <line x1="100" y1="230" x2="140" y2="230" stroke={isNight ? "#fffae8" : "#fff"} strokeWidth="1.5" strokeOpacity="0.4" strokeDasharray="6,4" />
        <line x1="90" y1="245" x2="155" y2="245" stroke={isNight ? "#fffae8" : "#fff"} strokeWidth="1.5" strokeOpacity="0.3" strokeDasharray="8,6" />

        {/* 3. 右上方：石头小木屋与玻璃温室花房 */}
        <g id="cottage_greenhouse">
          {/* 石阶与高台 */}
          <path d="M210,320 L430,290 L430,350 L210,360 Z" fill={isNight ? "#423d46" : "#a89b91"} />
          {/* 石屋墙面 */}
          <polygon points="320,130 410,140 405,280 310,290" fill={isNight ? "#3f3a47" : "#bfb2a8"} />
          {/* 屋顶 */}
          <polygon points="310,135 365,75 425,140" fill={isNight ? "#2c2833" : "#7b695e"} />
          {/* 烟囱 */}
          <rect x="380" y="55" width="16" height="35" fill={isNight ? "#372f33" : "#7c685f"} />
          {/* 玻璃花房 (温室) */}
          <polygon points="220,200 310,180 315,290 225,295" fill={isNight ? "#4b4f59" : "#c4dbdc"} opacity="0.65" />
          {/* 玻璃温室拱顶与框架 */}
          <path d="M225,200 Q265,165 305,182" stroke="#e8dfd3" strokeWidth="2.5" fill="none" />
          <line x1="265" y1="175" x2="268" y2="292" stroke="#e8dfd3" strokeWidth="2" />
          <line x1="245" y1="185" x2="248" y2="292" stroke="#e8dfd3" strokeWidth="1.5" />
          <line x1="285" y1="180" x2="288" y2="292" stroke="#e8dfd3" strokeWidth="1.5" />
          {/* 花房暖光内透 */}
          <rect x="235" y="210" width="70" height="70" fill="url(#lampGlow)" opacity={isNight ? "0.9" : "0.55"} />
          {/* 木屋窗口暖光 */}
          <rect x="345" y="160" width="28" height="35" rx="3" fill="#ffebad" opacity={isNight ? "0.95" : "0.7"} />
          {/* 攀爬在木屋上的粉色蔷薇与藤蔓 */}
          {[
            [230, 275], [260, 290], [285, 280], [315, 270], [340, 230], [330, 190],
            [370, 240], [390, 220], [410, 250], [350, 140], [375, 120]
          ].map(([rx, ry], idx) => (
            <circle key={`rose_${idx}`} cx={rx} cy={ry} r={idx % 3 === 0 ? 5 : 4} fill={idx % 2 === 0 ? "#e09ea0" : "#f1cfc8"} opacity="0.9" />
          ))}
        </g>

        {/* 4. 中部：莫奈花园花境、蔷薇拱门、石径、水池与布偶猫 */}
        <g id="monet_garden">
          {/* 石板小径 */}
          <path
            d="M170,360 L240,360 L260,680 L150,680 Z"
            fill={isNight ? "#47454c" : "#cfc6b8"}
          />
          {/* 石板质感线 */}
          <ellipse cx="205" cy="420" rx="30" ry="10" fill={isNight ? "#39383e" : "#baaf9f"} opacity="0.6" />
          <ellipse cx="210" cy="500" rx="35" ry="12" fill={isNight ? "#39383e" : "#b2a796"} opacity="0.6" />
          <ellipse cx="200" cy="600" rx="42" ry="14" fill={isNight ? "#39383e" : "#a89b88"} opacity="0.6" />

          {/* 右侧睡莲水池 */}
          <path
            d="M260,540 Q340,530 430,550 L430,680 L260,680 Z"
            fill={isNight ? "#243242" : "#97abb6"}
            opacity="0.85"
          />
          {/* 水中倒影与睡莲叶片 */}
          <ellipse cx="320" cy="580" rx="18" ry="7" fill={isNight ? "#264234" : "#6f8b72"} />
          <circle cx="323" cy="578" r="3" fill="#fdf0ea" />
          <ellipse cx="370" cy="610" rx="24" ry="9" fill={isNight ? "#264234" : "#6f8b72"} />
          <circle cx="373" cy="608" r="4" fill="#f4cfcf" />

          {/* 左侧与右侧蔷薇拱门与茂密花丛 */}
          <path
            d="M110,620 Q120,410 205,395 Q290,410 300,620"
            stroke={isNight ? "#38413b" : "#728876"}
            strokeWidth="14"
            fill="none"
          />
          {/* 拱门缠绕花朵点缀 */}
          {[
            [120, 520], [130, 460], [150, 420], [180, 400], [210, 395], [240, 405],
            [270, 430], [285, 470], [295, 530], [115, 580], [290, 600]
          ].map(([fx, fy], idx) => (
            <g key={`arch_flower_${idx}`}>
              <circle cx={fx} cy={fy} r="7" fill={idx % 2 === 0 ? "#e2a09f" : "#f5dfdb"} opacity="0.95" />
              <circle cx={fx + 2} cy={fy - 1} r="2.5" fill="#fef5d6" />
            </g>
          ))}

          {/* 花园草木层次与各色鲁冰花、飞燕草、绣球 */}
          {[
            [40, 450, "#738b77"], [70, 500, "#98a6bd"], [90, 580, "#df9d9c"],
            [330, 480, "#899b88"], [360, 530, "#cf9698"], [390, 490, "#9eaec1"],
            [50, 640, "#ebd8be"], [380, 650, "#e8a4a2"]
          ].map(([cx, cy, color], idx) => (
            <circle key={`bush_${idx}`} cx={Number(cx)} cy={Number(cy)} r={24 + (idx % 3) * 6} fill={String(color)} opacity="0.75" />
          ))}

          {/* ★★★ C位布偶猫咪 (坐在正中央石径上) ★★★ */}
          <g id="center_cat" transform="translate(175, 490)">
            {/* 阴影 */}
            <ellipse cx="38" cy="88" rx="28" ry="9" fill={isNight ? "#242329" : "#867a6d"} opacity="0.4" />
            {/* 蓬松身体 */}
            <path
              d="M18,50 Q10,75 25,86 Q50,90 60,80 Q65,60 52,48 Z"
              fill={isNight ? "#ded3c6" : "#fdf7ee"}
            />
            {/* 背部与尾巴深色毛发 */}
            <path
              d="M15,62 Q5,72 8,82 Q16,86 24,78 Z"
              fill={isNight ? "#6e6057" : "#9e8473"}
            />
            <path
              d="M58,72 Q75,70 78,82 Q74,88 60,84 Z"
              fill={isNight ? "#6e6057" : "#9e8473"}
            />
            {/* 蓬松大围脖 */}
            <ellipse cx="38" cy="46" rx="20" ry="14" fill="#ffffff" />
            {/* 猫头 */}
            <ellipse cx="38" cy="30" rx="16" ry="14" fill={isNight ? "#eae1d5" : "#fef8f0"} />
            {/* 双耳 */}
            <polygon points="25,24 23,8 34,18" fill={isNight ? "#5a4b41" : "#8a7161"} />
            <polygon points="51,24 53,8 42,18" fill={isNight ? "#5a4b41" : "#8a7161"} />
            {/* 布偶猫经典海豹重点色面具斑 */}
            <ellipse cx="38" cy="30" rx="11" ry="8" fill={isNight ? "#69584c" : "#9a806d"} opacity="0.85" />
            {/* 湛蓝眼睛 */}
            <ellipse cx="33" cy="28" rx="2.5" ry="3.5" fill="#4a8ec2" />
            <ellipse cx="43" cy="28" rx="2.5" ry="3.5" fill="#4a8ec2" />
            <circle cx="32" cy="27" r="0.8" fill="#fff" />
            <circle cx="42" cy="27" r="0.8" fill="#fff" />
            {/* 粉嫩小鼻子与胡须 */}
            <polygon points="37,33 39,33 38,35" fill="#f4b2b6" />
          </g>

          {/* 夜间花园萤火虫 */}
          {isNight && (
            <g id="fireflies">
              {[
                [160, 440], [240, 420], [130, 540], [280, 510], [200, 460], [330, 470]
              ].map(([fx, fy], idx) => (
                <g key={`ff_${idx}`}>
                  <circle cx={fx} cy={fy} r="2.5" fill="#ffefa6" opacity="0.95" />
                  <circle cx={fx} cy={fy} r="7" fill="#ffefa6" opacity="0.3" />
                </g>
              ))}
            </g>
          )}
        </g>

        {/* 5. 下方前景：木桌、手记、钢笔、茶杯与暖风灯 */}
        <g id="wooden_table">
          {/* 桌体 */}
          <ellipse cx="215" cy="850" rx="220" ry="110" fill="url(#tableGlow)" />
          {/* 桌缘厚度 */}
          <ellipse cx="215" cy="860" rx="218" ry="105" fill={isNight ? "#3a2b1f" : "#694a31"} opacity="0.4" />
          {/* 桌角花束 */}
          <g transform="translate(30, 720)">
            <ellipse cx="25" cy="40" rx="16" ry="20" fill={isNight ? "#637482" : "#d8e3ea"} opacity="0.75" />
            <circle cx="20" cy="18" r="8" fill="#fdf3eb" />
            <circle cx="34" cy="22" r="7" fill="#e8a8a6" />
            <circle cx="28" cy="8" r="7" fill="#f6efe4" />
          </g>

          {/* 暖黄复古铜风灯 */}
          <g transform="translate(110, 700)">
            {/* 暖灯光罩底座与灯顶 */}
            <ellipse cx="24" cy="70" rx="18" ry="7" fill={isNight ? "#3f3325" : "#6e583c"} />
            <rect x="10" y="30" width="28" height="38" rx="4" fill="none" stroke={isNight ? "#ebb778" : "#8c7250"} strokeWidth="2.5" />
            <polygon points="12,30 24,14 36,30" fill={isNight ? "#4a3c2b" : "#7b6343"} />
            <circle cx="24" cy="10" r="5" fill="none" stroke={isNight ? "#ebb778" : "#8c7250"} strokeWidth="2" />
            {/* 内部暖黄色火焰与漫射光 */}
            <circle cx="24" cy="48" r="14" fill="url(#lampGlow)" />
            <ellipse cx="24" cy="48" rx="4" ry="8" fill="#fff7d9" />
          </g>

          {/* 摊开的手写手记本 */}
          <g transform="translate(170, 755)">
            {/* 书页底厚度 */}
            <polygon points="12,18 95,5 178,16 172,66 95,58 10,66" fill={isNight ? "#584e44" : "#ded1be"} />
            {/* 摊开的书页 (奶油白) */}
            <polygon points="15,15 95,6 95,55 12,62" fill="#faf4eb" />
            <polygon points="95,6 175,14 168,62 95,55" fill="#f6efe4" />
            {/* 手写墨水笔迹线 */}
            <line x1="26" y1="28" x2="84" y2="22" stroke={isNight ? "#786d63" : "#aba094"} strokeWidth="1.2" strokeDasharray="5,2" />
            <line x1="26" y1="36" x2="80" y2="30" stroke={isNight ? "#786d63" : "#aba094"} strokeWidth="1.2" strokeDasharray="4,2" />
            <line x1="26" y1="44" x2="75" y2="38" stroke={isNight ? "#786d63" : "#aba094"} strokeWidth="1.2" strokeDasharray="6,3" />

            <line x1="106" y1="23" x2="160" y2="28" stroke={isNight ? "#786d63" : "#aba094"} strokeWidth="1.2" strokeDasharray="5,2" />
            <line x1="106" y1="31" x2="155" y2="36" stroke={isNight ? "#786d63" : "#aba094"} strokeWidth="1.2" strokeDasharray="4,2" />
            <line x1="106" y1="39" x2="148" y2="44" stroke={isNight ? "#786d63" : "#aba094"} strokeWidth="1.2" strokeDasharray="6,3" />

            {/* 搁置在手记上的复古金黑钢笔 */}
            <line x1="68" y1="48" x2="128" y2="28" stroke="#1d1b1a" strokeWidth="3.5" strokeLinecap="round" />
            <line x1="68" y1="48" x2="76" y2="45" stroke="#ebb778" strokeWidth="2.5" />
            <line x1="120" y1="31" x2="128" y2="28" stroke="#ebb778" strokeWidth="2.5" />
          </g>

          {/* 英式复古描金花茶杯与碟子 */}
          <g transform="translate(90, 810)">
            <ellipse cx="20" cy="18" rx="22" ry="7" fill="#fdfaf3" stroke="#e0cb9d" strokeWidth="1" />
            <ellipse cx="20" cy="12" rx="14" ry="8" fill="#f7f0e1" />
            <ellipse cx="20" cy="11" rx="11" ry="5" fill="#a46d49" opacity="0.8" />
            <path d="M33,10 Q40,12 33,16" stroke="#e0cb9d" strokeWidth="1.8" fill="none" />
          </g>
        </g>
      </svg>
    </div>
  );
};
