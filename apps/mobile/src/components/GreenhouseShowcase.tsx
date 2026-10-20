/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { GREENHOUSE_ARTWORKS } from '../data/mockData';
import { Artwork } from '../types';
import { X, ZoomIn, Palette, Eye, ArrowLeft } from 'lucide-react';

interface GreenhouseShowcaseProps {
  onBackToHome: () => void;
}

export const GreenhouseShowcase: React.FC<GreenhouseShowcaseProps> = ({ onBackToHome }) => {
  const [selectedArtwork, setSelectedArtwork] = useState<Artwork | null>(null);

  return (
    <div className="relative w-full h-full flex flex-col overflow-hidden bg-stone-100 select-none">
      {/* 背景：木屋花房内部油画质感 */}
      <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
        {/* 温室玻璃光影与木构架 */}
        <div className="w-full h-full bg-gradient-to-b from-[#e8dccb] via-[#dfd3c0] to-[#c9bca9]" />
        {/* 斜向木质玻璃顶天光光影 */}
        <div
          className="absolute inset-0 opacity-20"
          style={{
            backgroundImage:
              'linear-gradient(45deg, rgba(255,255,255,0.4) 25%, transparent 25%, transparent 50%, rgba(255,255,255,0.4) 50%, rgba(255,255,255,0.4) 75%, transparent 75%, transparent)',
            backgroundSize: '120px 120px'
          }}
        />
        {/* 亚麻细织纹底 */}
        <div className="absolute inset-0 linen-texture opacity-50 mix-blend-multiply" />
      </div>

      {/* 顶部标题栏 */}
      <header
        className="relative z-20 flex items-center justify-between px-4 border-b border-stone-300/60 bg-stone-100/80 backdrop-blur-md pt-safe-nav-bar"
        style={{
          paddingTop: 'calc(max(env(safe-area-inset-top, 0px), 14px) + 0.65rem)',
          paddingBottom: '0.65rem'
        }}
      >
        <button
          onClick={onBackToHome}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl hover:bg-stone-200/60 text-stone-800 transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4 text-stone-700" />
          <span className="text-xs font-serif text-stone-700">庭院</span>
        </button>

        <div className="text-center">
          <h1 className="text-sm font-serif font-bold text-stone-900 tracking-wider">
            玻璃花房 · 画作陈列
          </h1>
          <p className="text-[10px] font-serif text-stone-500">使用者的工作室与写生画录</p>
        </div>

        <div className="w-10 flex justify-end">
          <Palette className="w-4 h-4 text-stone-600" />
        </div>
      </header>

      {/* 作品两列瀑布流陈列 */}
      <main className="relative z-10 flex-1 overflow-y-auto px-4 py-4 no-scrollbar">
        <div className="grid grid-cols-2 gap-3.5 pb-28">
          {GREENHOUSE_ARTWORKS.map((art) => (
            <div
              key={art.id}
              onClick={() => setSelectedArtwork(art)}
              className="group cursor-pointer flex flex-col bg-stone-50/90 rounded-2xl p-2.5 border-2 border-stone-300/80 hover:border-amber-400/80 shadow-md hover:shadow-lg transition-all transform hover:-translate-y-0.5"
            >
              {/* 复古油画画框内外框 */}
              <div className="relative aspect-[3/4] w-full rounded-xl overflow-hidden border border-stone-400/40 shadow-inner bg-stone-200">
                {/* 印象派画作渐变与肌理示意 */}
                <div
                  className={`w-full h-full bg-gradient-to-tr ${art.gradient} flex items-center justify-center relative p-3`}
                >
                  <div className="absolute inset-0 linen-texture opacity-40 mix-blend-multiply" />
                  <div className="relative z-10 text-center space-y-1">
                    <span className="text-xs font-serif text-stone-800/80 font-bold block">
                      {art.chineseTitle}
                    </span>
                    <span className="text-[9px] font-serif text-stone-600 block">
                      {art.year}
                    </span>
                  </div>

                  {/* 放大镜微标 */}
                  <div className="absolute bottom-2 right-2 p-1 rounded-full bg-stone-900/30 text-white backdrop-blur-xs opacity-0 group-hover:opacity-100 transition-opacity">
                    <ZoomIn className="w-3 h-3" />
                  </div>
                </div>
              </div>

              {/* 标签卡片信息 */}
              <div className="pt-2 px-1 space-y-0.5">
                <h3 className="text-xs font-serif font-semibold text-stone-900 truncate">
                  {art.chineseTitle}
                </h3>
                <p className="text-[10px] text-stone-500 font-serif truncate">
                  {art.medium}
                </p>
                {/* 提取的调色色块 */}
                <div className="flex items-center gap-1 pt-1">
                  {art.palette.map((color, cIdx) => (
                    <span
                      key={cIdx}
                      className="w-2.5 h-2.5 rounded-full border border-black/10 shadow-2xs"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>

      {/* 沉浸式大图弹窗 Modal */}
      {selectedArtwork && (
        <div
          onClick={() => setSelectedArtwork(null)}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-950/80 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out]"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm bg-stone-100 rounded-3xl p-5 border-2 border-stone-400 shadow-2xl oil-shadow space-y-4 max-h-[85vh] overflow-y-auto no-scrollbar"
          >
            {/* 顶栏关闭 */}
            <div className="flex items-center justify-between border-b border-stone-300 pb-2">
              <span className="text-xs font-serif text-stone-600">画作档案</span>
              <button
                onClick={() => setSelectedArtwork(null)}
                className="p-1 rounded-full hover:bg-stone-200 text-stone-600 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 大画框展示 */}
            <div className="relative aspect-[3/4] w-full rounded-2xl overflow-hidden border-4 border-amber-900/20 shadow-2xl bg-stone-200">
              <div
                className={`w-full h-full bg-gradient-to-tr ${selectedArtwork.gradient} flex flex-col items-center justify-center p-6 text-center`}
              >
                <div className="absolute inset-0 linen-texture opacity-45 mix-blend-multiply" />
                <div className="relative z-10 space-y-2">
                  <h2 className="text-lg font-serif font-bold text-stone-900">
                    {selectedArtwork.chineseTitle}
                  </h2>
                  <p className="text-xs font-serif text-stone-700 italic">
                    {selectedArtwork.year} · {selectedArtwork.medium}
                  </p>
                </div>
              </div>
            </div>

            {/* 画作陈述与细节 */}
            <div className="space-y-3 font-serif">
              <div>
                <span className="text-[11px] text-stone-500 uppercase tracking-wider block">
                  画者创作笔记
                </span>
                <p className="text-xs text-stone-800 leading-relaxed mt-1 bg-stone-200/50 p-3 rounded-xl border border-stone-300/40">
                  {selectedArtwork.description}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px] text-stone-600 pt-1">
                <div>
                  <span className="text-stone-400">画幅尺寸：</span>
                  <span>{selectedArtwork.dimension}</span>
                </div>
                <div>
                  <span className="text-stone-400">承载材质：</span>
                  <span>亚麻油画布</span>
                </div>
              </div>

              {/* 核心色板 */}
              <div className="pt-2">
                <span className="text-[11px] text-stone-500 block mb-1.5">画作提取色板</span>
                <div className="flex items-center gap-2">
                  {selectedArtwork.palette.map((color, idx) => (
                    <div key={idx} className="flex flex-col items-center gap-1">
                      <span
                        className="w-7 h-7 rounded-xl border border-stone-400/50 shadow-inner"
                        style={{ backgroundColor: color }}
                      />
                      <span className="text-[9px] text-stone-500 font-mono">{color}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <button
              onClick={() => setSelectedArtwork(null)}
              className="w-full py-2.5 rounded-2xl bg-stone-200 hover:bg-stone-300 text-stone-800 text-xs font-serif font-medium transition-colors cursor-pointer"
            >
              返回展厅
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
