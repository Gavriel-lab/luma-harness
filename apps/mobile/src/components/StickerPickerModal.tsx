/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Trash2, Link, Image as ImageIcon, Check } from 'lucide-react';

export interface StickerItem {
  id: string;
  name: string;
  url: string;
  isPreset?: boolean;
}

const PRESET_STICKERS: StickerItem[] = [
  {
    id: 'preset_water_lily',
    name: '莫奈睡莲',
    url: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=300&q=80',
    isPreset: true,
  },
  {
    id: 'preset_cozy_cat',
    name: '惬意使用者',
    url: 'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=300&q=80',
    isPreset: true,
  },
  {
    id: 'preset_patrol_worker',
    name: '巡园小兔',
    url: 'https://images.unsplash.com/photo-1585110396000-c9ffd4e4b308?w=300&q=80',
    isPreset: true,
  },
  {
    id: 'preset_lake_tea',
    name: '湖畔淡茶',
    url: 'https://images.unsplash.com/photo-1544787219-7f47ccb76574?w=300&q=80',
    isPreset: true,
  },
  {
    id: 'preset_garden_breeze',
    name: '庭院微风',
    url: 'https://images.unsplash.com/photo-1463936575829-25148e1db1b8?w=300&q=80',
    isPreset: true,
  },
  {
    id: 'preset_morning_brush',
    name: '晨光画笔',
    url: 'https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=300&q=80',
    isPreset: true,
  },
];

const STICKERS_STORAGE_KEY = 'luma_custom_stickers_v2';

export function getStoredStickers(): StickerItem[] {
  try {
    const raw = localStorage.getItem(STICKERS_STORAGE_KEY);
    if (raw) {
      const parsed: StickerItem[] = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch (e) {
    console.warn('Error reading stickers:', e);
  }
  return PRESET_STICKERS;
}

export function saveStoredStickers(stickers: StickerItem[]): void {
  try {
    localStorage.setItem(STICKERS_STORAGE_KEY, JSON.stringify(stickers));
  } catch (e) {
    console.warn('Error saving stickers:', e);
  }
}

interface StickerPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectSticker: (imageUrl: string, name?: string) => void;
}

export const StickerPickerModal: React.FC<StickerPickerModalProps> = ({
  isOpen,
  onClose,
  onSelectSticker,
}) => {
  const [stickers, setStickers] = useState<StickerItem[]>(getStoredStickers);
  const [isEditing, setIsEditing] = useState(false);
  const [isBatchImportOpen, setIsBatchImportOpen] = useState(false);
  const [batchUrlsInput, setBatchUrlsInput] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setStickers(getStoredStickers());
      setIsEditing(false);
      setIsBatchImportOpen(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleAddLocalSticker = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          const newSticker: StickerItem = {
            id: `sticker_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: file.name.replace(/\.[^/.]+$/, ''),
            url: event.target.result as string,
          };
          const updated = [...stickers, newSticker];
          setStickers(updated);
          saveStoredStickers(updated);
        }
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
  };

  const handleBatchImport = () => {
    if (!batchUrlsInput.trim()) return;
    const lines = batchUrlsInput
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter((s) => s.startsWith('http://') || s.startsWith('https://') || s.startsWith('data:image/'));

    if (lines.length === 0) {
      alert('未检测到有效的图片链接（需以 http://, https:// 开头）');
      return;
    }

    const newItems: StickerItem[] = lines.map((url, idx) => ({
      id: `sticker_url_${Date.now()}_${idx}`,
      name: `图床表情 ${stickers.length + idx + 1}`,
      url,
    }));

    const updated = [...stickers, ...newItems];
    setStickers(updated);
    saveStoredStickers(updated);
    setBatchUrlsInput('');
    setIsBatchImportOpen(false);
  };

  const handleDeleteSticker = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = stickers.filter((s) => s.id !== id);
    setStickers(updated);
    saveStoredStickers(updated);
  };

  const handleResetPresets = () => {
    if (confirm('确认恢复默认预设表情包吗？自定义表情将被替换。')) {
      setStickers(PRESET_STICKERS);
      saveStoredStickers(PRESET_STICKERS);
    }
  };

  const modalContent = (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[9999] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/60 backdrop-blur-md animate-[fadeIn_0.15s_ease-out]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md bg-stone-100/95 backdrop-blur-2xl rounded-t-3xl sm:rounded-3xl p-4 sm:p-5 border-t sm:border border-stone-300 shadow-2xl space-y-3.5 max-h-[75vh] flex flex-col font-serif text-stone-800"
      >
        {/* 顶部标题与管理工具栏 */}
        <div className="flex items-center justify-between border-b border-stone-300/80 pb-2 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-stone-900">表情包工坊</span>
            <span className="text-[10px] text-stone-500 font-mono">({stickers.length}枚)</span>
          </div>

          <div className="flex items-center gap-1.5">
            {/* 批量导入图床按钮 */}
            <button
              onClick={() => setIsBatchImportOpen(!isBatchImportOpen)}
              className="px-2 py-1 rounded-xl bg-stone-200/80 hover:bg-stone-300 text-stone-700 text-xs flex items-center gap-1 transition-colors cursor-pointer"
              title="批量导入图床链接"
            >
              <Link className="w-3.5 h-3.5" />
              <span className="text-[11px]">图床导入</span>
            </button>

            {/* 本地添加单张 */}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-2 py-1 rounded-xl bg-amber-600/90 hover:bg-amber-600 text-amber-50 text-xs flex items-center gap-1 shadow-xs transition-colors cursor-pointer"
              title="添加新表情"
            >
              <Plus className="w-3.5 h-3.5" />
              <span className="text-[11px]">添加</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleAddLocalSticker}
              className="hidden"
            />

            {/* 编辑/删除模式切换 */}
            <button
              onClick={() => setIsEditing(!isEditing)}
              className={`p-1.5 rounded-xl transition-colors cursor-pointer ${
                isEditing ? 'bg-rose-200 text-rose-800' : 'hover:bg-stone-200 text-stone-600'
              }`}
              title={isEditing ? '完成管理' : '管理/删除表情'}
            >
              {isEditing ? <Check className="w-4 h-4" /> : <Trash2 className="w-4 h-4" />}
            </button>

            <button
              onClick={onClose}
              className="p-1 rounded-full hover:bg-stone-200 text-stone-600 cursor-pointer ml-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 批量图床导入输入框（展开时展示） */}
        {isBatchImportOpen && (
          <div className="p-3 rounded-2xl bg-amber-50/90 border border-amber-300/80 space-y-2 shrink-0 animate-[fadeIn_0.15s_ease-out]">
            <p className="text-xs text-amber-950 font-bold flex items-center gap-1">
              <Link className="w-3.5 h-3.5 text-amber-800" />
              <span>批量导入图床图片链接</span>
            </p>
            <textarea
              value={batchUrlsInput}
              onChange={(e) => setBatchUrlsInput(e.target.value)}
              rows={3}
              placeholder="每行一个图片网址，或用逗号隔开：&#10;https://example.com/pic1.jpg&#10;https://example.com/pic2.png"
              className="w-full p-2 rounded-xl bg-white border border-amber-200 text-xs font-mono text-stone-800 placeholder-stone-400 focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setIsBatchImportOpen(false)}
                className="px-2.5 py-1 rounded-lg bg-stone-200 text-stone-700 text-xs cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={handleBatchImport}
                className="px-3 py-1 rounded-lg bg-amber-700 hover:bg-amber-800 text-white text-xs font-semibold cursor-pointer"
              >
                确认导入
              </button>
            </div>
          </div>
        )}

        {/* 表情包网格陈列 */}
        <div className="flex-1 overflow-y-auto no-scrollbar py-1">
          {stickers.length === 0 ? (
            <div className="text-center py-8 text-stone-400 text-xs space-y-2">
              <ImageIcon className="w-8 h-8 mx-auto stroke-1" />
              <p>暂无表情包，可点击右上角添加或导入</p>
              <button
                onClick={handleResetPresets}
                className="text-amber-700 underline text-[11px] cursor-pointer"
              >
                恢复默认沙龙表情包
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-4 sm:grid-cols-5 gap-2.5">
              {stickers.map((s) => (
                <div
                  key={s.id}
                  onClick={() => {
                    if (!isEditing) {
                      onSelectSticker(s.url, s.name);
                      onClose();
                    }
                  }}
                  className={`relative group aspect-square rounded-2xl overflow-hidden border border-stone-300/80 bg-white shadow-2xs hover:shadow-sm transition-all flex items-center justify-center cursor-pointer ${
                    isEditing ? 'ring-2 ring-rose-400 animate-pulse' : 'hover:scale-105 active:scale-95'
                  }`}
                >
                  <img
                    src={s.url}
                    alt={s.name}
                    loading="lazy"
                    className="w-full h-full object-cover"
                  />

                  {/* 悬浮或编辑状态下的名称或删除按钮 */}
                  {isEditing ? (
                    <button
                      onClick={(e) => handleDeleteSticker(s.id, e)}
                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-rose-600 text-white flex items-center justify-center shadow-sm cursor-pointer"
                      title="删除此表情"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  ) : (
                    <span className="absolute bottom-0 inset-x-0 bg-black/40 backdrop-blur-2xs text-[9px] text-white text-center truncate px-1 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      {s.name}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined'
    ? createPortal(modalContent, document.body)
    : modalContent;
};
