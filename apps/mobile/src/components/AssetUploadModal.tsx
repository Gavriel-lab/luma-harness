/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef } from 'react';
import { CustomAssets } from '../utils/assetManager';
import { X, Upload, Check, RefreshCw, Palette } from 'lucide-react';

interface AssetUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  assets: CustomAssets;
  onUpdateAssets: (newAssets: CustomAssets) => void;
}

export const AssetUploadModal: React.FC<AssetUploadModalProps> = ({
  isOpen,
  onClose,
  assets,
  onUpdateAssets
}) => {
  const dayInputRef = useRef<HTMLInputElement | null>(null);
  const nightInputRef = useRef<HTMLInputElement | null>(null);
  const chatBgInputRef = useRef<HTMLInputElement | null>(null);
  const live2dInputRef = useRef<HTMLInputElement | null>(null);

  if (!isOpen) return null;

  const handleFileUpload = (
    key: keyof CustomAssets,
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          const updated = {
            ...assets,
            [key]: event.target.result as string
          };
          onUpdateAssets(updated);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const handleReset = (key: keyof CustomAssets) => {
    const updated = {
      ...assets,
      [key]: null
    };
    onUpdateAssets(updated);
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-950/75 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm bg-stone-100 rounded-3xl p-5 border-2 border-stone-400 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto no-scrollbar font-serif text-stone-800"
      >
        <div className="flex items-center justify-between border-b border-stone-300 pb-2">
          <div className="flex items-center gap-2">
            <Palette className="w-4 h-4 text-amber-700" />
            <span className="text-sm font-bold text-stone-900">自选画作与材质管理</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-full hover:bg-stone-200 text-stone-600 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-stone-600 leading-relaxed">
          你可以在此处上传自己的画作，替换当前浏览器里的对应背景。开屏、日景和夜景已随工程附上原画；重置后会恢复对应默认图。
        </p>

        <div className="space-y-3 pt-1">
          {/* 1. 主画（日间版） */}
          <div className="p-3 bg-stone-50 rounded-2xl border border-stone-300 flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-stone-900">主画（日间版）.png</div>
              <div className="text-[10px] text-stone-500">
                {assets.dayMainPainting ? '已加载自定义画作' : '使用默认日景原画'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {assets.dayMainPainting && (
                <button
                  onClick={() => handleReset('dayMainPainting')}
                  className="p-1.5 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-200"
                  title="恢复默认"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={() => dayInputRef.current?.click()}
                className="px-2.5 py-1 text-xs rounded-xl bg-stone-200 hover:bg-stone-300 text-stone-800 flex items-center gap-1 cursor-pointer"
              >
                <Upload className="w-3 h-3" />
                <span>替换</span>
              </button>
              <input
                ref={dayInputRef}
                type="file"
                accept="image/*"
                onChange={(e) => handleFileUpload('dayMainPainting', e)}
                className="hidden"
              />
            </div>
          </div>

          {/* 2. 主画（夜间版） */}
          <div className="p-3 bg-stone-50 rounded-2xl border border-stone-300 flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-stone-900">主画（夜间版）.png</div>
              <div className="text-[10px] text-stone-500">
                {assets.nightMainPainting ? '已加载自定义画作' : '使用默认夜景原画'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {assets.nightMainPainting && (
                <button
                  onClick={() => handleReset('nightMainPainting')}
                  className="p-1.5 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-200"
                  title="恢复默认"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={() => nightInputRef.current?.click()}
                className="px-2.5 py-1 text-xs rounded-xl bg-stone-200 hover:bg-stone-300 text-stone-800 flex items-center gap-1 cursor-pointer"
              >
                <Upload className="w-3 h-3" />
                <span>替换</span>
              </button>
              <input
                ref={nightInputRef}
                type="file"
                accept="image/*"
                onChange={(e) => handleFileUpload('nightMainPainting', e)}
                className="hidden"
              />
            </div>
          </div>

          {/* 3. 聊天背景 */}
          <div className="p-3 bg-stone-50 rounded-2xl border border-stone-300 flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-stone-900">聊天背景.png</div>
              <div className="text-[10px] text-stone-500">
                {assets.chatBackground ? '已加载自定义背景' : '使用印象派花园虚化'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {assets.chatBackground && (
                <button
                  onClick={() => handleReset('chatBackground')}
                  className="p-1.5 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-200"
                  title="恢复默认"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={() => chatBgInputRef.current?.click()}
                className="px-2.5 py-1 text-xs rounded-xl bg-stone-200 hover:bg-stone-300 text-stone-800 flex items-center gap-1 cursor-pointer"
              >
                <Upload className="w-3 h-3" />
                <span>替换</span>
              </button>
              <input
                ref={chatBgInputRef}
                type="file"
                accept="image/*"
                onChange={(e) => handleFileUpload('chatBackground', e)}
                className="hidden"
              />
            </div>
          </div>

          {/* 4. 开屏 Live2D 动态睡莲图 */}
          <div className="p-3 bg-stone-50 rounded-2xl border border-stone-300 flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-stone-900">开屏原画与水波</div>
              <div className="text-[10px] text-stone-500">
                {assets.splashLive2dImage ? '已加载自定义开屏原画' : '使用默认花湖开屏原画'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {assets.splashLive2dImage && (
                <button
                  onClick={() => handleReset('splashLive2dImage')}
                  className="p-1.5 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-200"
                  title="恢复默认"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={() => live2dInputRef.current?.click()}
                className="px-2.5 py-1 text-xs rounded-xl bg-stone-200 hover:bg-stone-300 text-stone-800 flex items-center gap-1 cursor-pointer"
              >
                <Upload className="w-3 h-3" />
                <span>替换</span>
              </button>
              <input
                ref={live2dInputRef}
                type="file"
                accept="image/*"
                onChange={(e) => handleFileUpload('splashLive2dImage', e)}
                className="hidden"
              />
            </div>
          </div>
        </div>

        <button
          onClick={onClose}
          className="w-full py-2.5 rounded-2xl bg-amber-700 hover:bg-amber-800 text-amber-50 text-xs font-bold transition-colors cursor-pointer"
        >
          保存并应用
        </button>
      </div>
    </div>
  );
};
