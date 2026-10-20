/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Character } from '../types';
import { X, Volume2, Sparkles, Image as ImageIcon, Sliders, Check, RefreshCw, Key, Globe, DownloadCloud } from 'lucide-react';

export interface SingleChatConfig {
  replyMedium: 'auto' | 'text' | 'voice';
  ttsEnabled: boolean;
  ttsEngine: 'fish-audio' | 'edge-tts' | 'native';
  fishAudioVoiceId: string;
  fishAudioApiKey: string;
  ttsSpeed: number;
  imageGenEnabled: boolean;
  imageGenEngine: 'ai' | 'gpt';
  imageGenApiBase: string;
  imageGenApiKey: string;
  imageGenModel: string;
  imageGenStyle: string;
  promptSuffix: string;
  customChatBg: string | null;
}

const DEFAULT_CONFIG: SingleChatConfig = {
  replyMedium: 'auto',
  ttsEnabled: false,
  ttsEngine: 'fish-audio',
  fishAudioVoiceId: '',
  fishAudioApiKey: '',
  ttsSpeed: 1.0,
  imageGenEnabled: true,
  imageGenEngine: 'gpt',
  imageGenApiBase: 'https://api.openai.com/v1',
  imageGenApiKey: '',
  imageGenModel: 'image-2.5',
  imageGenStyle: '莫奈印象派睡莲油画',
  promptSuffix: '莫奈光影，柔和亚麻质感，晨光微熹，低饱和度法式油画',
  customChatBg: null,
};

interface ChatRoomSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  character: Character;
  onConfigUpdated?: (config: SingleChatConfig) => void;
}

export function getSingleChatConfig(characterId: string): SingleChatConfig {
  const defaults = { ...DEFAULT_CONFIG, fishAudioVoiceId: characterId === 'agent_coordinator' ? '566c14e69fac4d3eb71f70cf1776b13d' : '' };
  try {
    const raw = localStorage.getItem(`luma_chat_config_${characterId}`);
    if (raw) {
      const saved = JSON.parse(raw);
      // Correct the supplied Coordinator ID even in a previously saved room config.
      // Other members and deliberately chosen custom voices remain unchanged.
      if (characterId === 'agent_coordinator' && saved.fishAudioVoiceId === '8b3a109361a1498692d202228bc2f280') saved.fishAudioVoiceId = defaults.fishAudioVoiceId;
      return { ...defaults, ...saved, fishAudioVoiceId: saved.fishAudioVoiceId || defaults.fishAudioVoiceId };
    }
  } catch (e) {
    console.warn('Error reading chat config:', e);
  }
  return defaults;
}

export function saveSingleChatConfig(characterId: string, config: SingleChatConfig): void {
  try {
    localStorage.setItem(`luma_chat_config_${characterId}`, JSON.stringify(config));
  } catch (e) {
    console.warn('Error saving chat config:', e);
  }
}

export const ChatRoomSettingsModal: React.FC<ChatRoomSettingsModalProps> = ({
  isOpen,
  onClose,
  character,
  onConfigUpdated,
}) => {
  const [config, setConfig] = useState<SingleChatConfig>(() => getSingleChatConfig(character.id));
  const [savedNotice, setSavedNotice] = useState(false);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [modelFetchMsg, setModelFetchMsg] = useState<string | null>(null);

  useEffect(() => {
    setConfig(getSingleChatConfig(character.id));
  }, [character.id, isOpen]);

  if (!isOpen) return null;

  const handleSave = () => {
    saveSingleChatConfig(character.id, config);
    if (onConfigUpdated) {
      onConfigUpdated(config);
    }
    setSavedNotice(true);
    setTimeout(() => {
      setSavedNotice(false);
      onClose();
    }, 600);
  };

  const handleUploadBg = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (ev.target?.result) {
          setConfig((prev) => ({ ...prev, customChatBg: ev.target!.result as string }));
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const handleFetchModels = async () => {
    if (!config.imageGenApiBase) {
      setModelFetchMsg('请先填写 API 接口地址');
      setTimeout(() => setModelFetchMsg(null), 3000);
      return;
    }

    setIsFetchingModels(true);
    setModelFetchMsg(null);
    try {
      const baseUrl = config.imageGenApiBase.replace(/\/+$/, '');
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (config.imageGenApiKey) {
        headers['Authorization'] = `Bearer ${config.imageGenApiKey}`;
      }

      const res = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      if (Array.isArray(data?.data)) {
        const modelIds: string[] = data.data.map((m: any) => m.id || m.name).filter(Boolean);
        setFetchedModels(modelIds);
        setModelFetchMsg(`成功拉取 ${modelIds.length} 个模型`);
      } else {
        setModelFetchMsg('接口已返回但未找到模型列表');
      }
    } catch (err: any) {
      setModelFetchMsg(`拉取失败: ${err.message || '网络异常'}`);
    } finally {
      setIsFetchingModels(false);
      setTimeout(() => setModelFetchMsg(null), 4000);
    }
  };

  const quickModels = ['image-2.5', 'gpt-4o-image', 'dall-e-3', 'flux-1.1-pro', 'sd-xl'];

  const modalContent = (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[9999] flex items-center justify-center p-3 bg-black/60 backdrop-blur-md animate-[fadeIn_0.2s_ease-out]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[360px] bg-stone-100/95 backdrop-blur-xl rounded-3xl p-4 sm:p-5 border border-stone-300 shadow-2xl space-y-3.5 max-h-[88vh] overflow-y-auto no-scrollbar font-serif text-stone-800"
      >
        {/* 顶部标题 */}
        <div className="flex items-center justify-between border-b border-stone-300/80 pb-2">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-amber-700" />
            <div>
              <span className="text-sm font-bold text-stone-900">
                专属会话设置 · {character.name}
              </span>
              <p className="text-[10px] text-stone-500 font-sans">
                仅对当前单人聊天框生效
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-full hover:bg-stone-200 text-stone-600 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 模块一：TTS 语音朗读配置 (Fish Audio) */}
        <div className="space-y-2 bg-stone-50/90 p-3 rounded-2xl border border-stone-300/80 shadow-2xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-amber-800" />
              <span className="text-xs font-bold text-stone-900">伙伴回复方式</span>
            </div>
            <select aria-label="伙伴回复方式" value={config.replyMedium} onChange={e => setConfig({ ...config, replyMedium: e.target.value as SingleChatConfig['replyMedium'] })} className="rounded-xl border border-stone-300 bg-white px-2 py-1 text-xs text-stone-800">
              <option value="auto">由伙伴决定</option><option value="text">只发文字</option><option value="voice">优先语音</option>
            </select>
          </div>

          <div className="space-y-2 pt-1 text-xs">
            <div>
              <label className="text-[11px] text-stone-600 block mb-1">语音合成引擎</label>
              <select
                value={config.ttsEngine}
                onChange={(e) =>
                  setConfig({ ...config, ttsEngine: e.target.value as SingleChatConfig['ttsEngine'] })
                }
                className="w-full px-2.5 py-1.5 rounded-xl bg-white border border-stone-300 text-xs text-stone-800 focus:outline-none focus:border-amber-600 shadow-2xs"
              >
                <option value="fish-audio">Fish Audio (深度拟真音色)</option>
                <option value="edge-tts" disabled>Edge TTS（暂未接入）</option>
                <option value="native">系统原生语音 (设备本地)</option>
              </select>
            </div>

            {config.ttsEngine === 'fish-audio' && (
              <>
                <div>
                  <label className="text-[11px] text-stone-600 block mb-1">
                    Fish Audio 声音模型 / Voice ID
                  </label>
                  <input
                    type="text"
                    value={config.fishAudioVoiceId}
                    onChange={(e) => setConfig({ ...config, fishAudioVoiceId: e.target.value })}
                    placeholder={`输入 ${character.name} 的音色 ID，留空使用默认音色`}
                    className="w-full px-2.5 py-1.5 rounded-xl bg-white border border-stone-300 text-xs text-stone-800 placeholder-stone-400 focus:outline-none focus:border-amber-600"
                  />
                </div>
                <p className="text-[11px] text-stone-500">语音服务已由小屋统一接入，无需在每个房间重复填密钥。不同家人可以设置不同音色。</p>
              </>
            )}
          </div>
        </div>

        {/* 模块二：生图联动 (外接 API + Image 2.5 + 模型拉取) */}
        <div className="space-y-2 bg-stone-50/90 p-3 rounded-2xl border border-stone-300/80 shadow-2xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-rose-800" />
              <span className="text-xs font-bold text-stone-900">生图与画面呈现</span>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={config.imageGenEnabled}
                onChange={(e) => setConfig({ ...config, imageGenEnabled: e.target.checked })}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-stone-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-stone-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-700"></div>
            </label>
          </div>

          <div className="space-y-2.5 pt-1 text-xs">
            <div>
              <label className="text-[11px] text-stone-600 block mb-1">绘图通道架构</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setConfig({ ...config, imageGenEngine: 'gpt', imageGenModel: 'image-2.5' })}
                  className={`py-1.5 px-2 rounded-xl text-xs font-serif border transition-all ${
                    config.imageGenEngine === 'gpt'
                      ? 'bg-amber-100 border-amber-600 text-amber-950 font-bold'
                      : 'bg-white border-stone-300 text-stone-700'
                  }`}
                >
                  GPT / OpenAI (Image 2.5)
                </button>
                <button
                  type="button"
                  onClick={() => setConfig({ ...config, imageGenEngine: 'ai' })}
                  className={`py-1.5 px-2 rounded-xl text-xs font-serif border transition-all ${
                    config.imageGenEngine === 'ai'
                      ? 'bg-amber-100 border-amber-600 text-amber-950 font-bold'
                      : 'bg-white border-stone-300 text-stone-700'
                  }`}
                >
                  AI 绘图 (SD / FLUX)
                </button>
              </div>
            </div>

            {/* 外接 API 接口地址与 Key 预留 */}
            <div>
              <label className="text-[11px] text-stone-600 flex items-center gap-1 mb-1">
                <Globe className="w-3 h-3 text-stone-500" />
                <span>API 接口地址 (Base URL)</span>
              </label>
              <input
                type="text"
                value={config.imageGenApiBase}
                onChange={(e) => setConfig({ ...config, imageGenApiBase: e.target.value })}
                placeholder="https://api.openai.com/v1"
                className="w-full px-2.5 py-1.5 rounded-xl bg-white border border-stone-300 text-xs font-mono text-stone-800 placeholder-stone-400 focus:outline-none focus:border-amber-600"
              />
            </div>

            <div>
              <label className="text-[11px] text-stone-600 flex items-center gap-1 mb-1">
                <Key className="w-3 h-3 text-stone-500" />
                <span>API 密钥 (API Key)</span>
              </label>
              <input
                type="password"
                value={config.imageGenApiKey}
                onChange={(e) => setConfig({ ...config, imageGenApiKey: e.target.value })}
                placeholder="sk-..."
                className="w-full px-2.5 py-1.5 rounded-xl bg-white border border-stone-300 text-xs font-mono text-stone-800 placeholder-stone-400 focus:outline-none focus:border-amber-600"
              />
            </div>

            {/* 模型选择与在线拉取 */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] text-stone-600">模型名称 (Model)</label>
                <button
                  type="button"
                  onClick={handleFetchModels}
                  disabled={isFetchingModels}
                  className="text-[10px] text-amber-800 hover:text-amber-950 flex items-center gap-0.5 cursor-pointer disabled:opacity-50"
                  title="向接口请求模型列表"
                >
                  <DownloadCloud className={`w-3 h-3 ${isFetchingModels ? 'animate-bounce' : ''}`} />
                  <span>{isFetchingModels ? '拉取中...' : '拉取模型列表'}</span>
                </button>
              </div>

              {modelFetchMsg && (
                <p className="text-[10px] text-amber-700 italic mb-1">{modelFetchMsg}</p>
              )}

              {fetchedModels.length > 0 ? (
                <select
                  value={config.imageGenModel}
                  onChange={(e) => setConfig({ ...config, imageGenModel: e.target.value })}
                  className="w-full px-2.5 py-1.5 rounded-xl bg-white border border-stone-300 text-xs text-stone-800 focus:outline-none focus:border-amber-600 mb-1"
                >
                  {fetchedModels.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={config.imageGenModel}
                  onChange={(e) => setConfig({ ...config, imageGenModel: e.target.value })}
                  placeholder="image-2.5"
                  className="w-full px-2.5 py-1.5 rounded-xl bg-white border border-stone-300 text-xs font-mono text-stone-800 placeholder-stone-400 focus:outline-none focus:border-amber-600"
                />
              )}

              {/* 常用快捷标签 */}
              <div className="flex flex-wrap gap-1 mt-1.5">
                {quickModels.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setConfig({ ...config, imageGenModel: m })}
                    className={`px-1.5 py-0.5 rounded-md text-[10px] font-mono border transition-all ${
                      config.imageGenModel === m
                        ? 'bg-amber-100 border-amber-500 text-amber-900 font-semibold'
                        : 'bg-white border-stone-200 text-stone-600 hover:bg-stone-50'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-[11px] text-stone-600 block mb-1">专属画风倾向</label>
              <input
                type="text"
                value={config.imageGenStyle}
                onChange={(e) => setConfig({ ...config, imageGenStyle: e.target.value })}
                placeholder="莫奈印象派睡莲油画、法式胶片手绘..."
                className="w-full px-2.5 py-1.5 rounded-xl bg-white border border-stone-300 text-xs text-stone-800 placeholder-stone-400 focus:outline-none focus:border-amber-600"
              />
            </div>

            <div>
              <label className="text-[11px] text-stone-600 block mb-1">提示词特征词加缀</label>
              <textarea
                value={config.promptSuffix}
                onChange={(e) => setConfig({ ...config, promptSuffix: e.target.value })}
                rows={2}
                placeholder="为该伙伴生成的画作添加独特的画面特征..."
                className="w-full px-2.5 py-1.5 rounded-xl bg-white border border-stone-300 text-xs text-stone-800 placeholder-stone-400 focus:outline-none focus:border-amber-600"
              />
            </div>
          </div>
        </div>

        {/* 模块三：单人专属聊天背景 */}
        <div className="space-y-2 bg-stone-50/90 p-3 rounded-2xl border border-stone-300/80 shadow-2xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ImageIcon className="w-4 h-4 text-emerald-800" />
              <span className="text-xs font-bold text-stone-900">单人专属聊天背景</span>
            </div>
            {config.customChatBg && (
              <button
                type="button"
                onClick={() => setConfig({ ...config, customChatBg: null })}
                className="text-[10px] text-stone-500 hover:text-stone-800 flex items-center gap-0.5 cursor-pointer"
              >
                <RefreshCw className="w-2.5 h-2.5" />
                <span>恢复默认</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-3 pt-1">
            {config.customChatBg ? (
              <img
                src={config.customChatBg}
                alt="专属背景"
                className="w-11 h-11 object-cover rounded-xl border border-stone-300 shrink-0"
              />
            ) : (
              <div className="w-11 h-11 rounded-xl bg-stone-200 border border-stone-300 flex items-center justify-center text-[10px] text-stone-500 shrink-0">
                默认
              </div>
            )}
            <div className="flex-1 min-w-0">
              <label className="block w-full py-1.5 px-3 rounded-xl bg-white border border-stone-300 text-center text-xs font-serif text-stone-800 hover:bg-stone-50 cursor-pointer shadow-xs">
                <span>上传专属壁纸</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleUploadBg}
                  className="hidden"
                />
              </label>
              <p className="text-[10px] text-stone-500 mt-1">独立覆盖该聊天窗口背景</p>
            </div>
          </div>
        </div>

        {/* 底部保存按钮 */}
        <div className="pt-1">
          <button
            onClick={handleSave}
            className="w-full py-2.5 rounded-2xl bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-600 hover:to-amber-800 active:scale-98 text-amber-50 text-xs font-serif font-bold shadow-md flex items-center justify-center gap-1.5 transition-all cursor-pointer"
          >
            {savedNotice ? (
              <>
                <Check className="w-4 h-4 text-emerald-300 animate-bounce" />
                <span>配置已生效并保存</span>
              </>
            ) : (
              <span>保存当前单人配置</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined'
    ? createPortal(modalContent, document.body)
    : modalContent;
};
