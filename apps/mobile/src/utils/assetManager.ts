/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// 统一的画作与材质、成员头像资源管理器
// 本地上传作为可重置的覆盖项；默认轻量高效 WebP 原画随工程打包。

export interface CustomAssets {
  dayMainPainting: string | null;
  nightMainPainting: string | null;
  chatBackground: string | null;
  blankCanvasTexture: string | null;
  brushStroke: string | null;
  splashLive2dImage: string | null;
  memberAvatars?: Record<string, string | null>;
}

const STORAGE_KEY = 'monet_custom_assets_v1';
const AVATAR_STORAGE_KEY = 'luma_member_avatars_v1';

// 采用深度优化、秒开的 WebP 高清素材
export const BUNDLED_ASSETS = {
  dayMainPainting: `${import.meta.env.BASE_URL}assets/luma-day.webp`,
  nightMainPainting: `${import.meta.env.BASE_URL}assets/luma-night.webp`,
  splashLive2dImage: `${import.meta.env.BASE_URL}assets/luma-splash.webp`,
};

export function getStoredAssets(): CustomAssets {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn('LocalStorage assets access error:', e);
  }
  return {
    dayMainPainting: null,
    nightMainPainting: null,
    chatBackground: null,
    blankCanvasTexture: null,
    brushStroke: null,
    splashLive2dImage: null,
    memberAvatars: {},
  };
}

export function saveStoredAssets(assets: CustomAssets): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(assets));
  } catch (e) {
    console.warn('LocalStorage assets save error:', e);
  }
}

// ==========================================
// 成员头像独立全局存储管理器
// ==========================================

/**
 * 针对移动端（如 iPhone 14 Pro Max 拍摄的原图）进行轻量化压缩
 * 限制最大宽高 256px，JPEG 质量 0.85，体积由数 MB 降至 15~25KB，
 * 根除 iOS WebKit / Safari localStorage 5MB 配额超标 (QuotaExceededError) 导致头像无法保存的问题。
 */
export function compressAvatarImage(file: File, maxSize = 256, quality = 0.85): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取图片文件'));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error('无法解析图片数据'));
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        if (width > height) {
          if (width > maxSize) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          }
        } else {
          if (height > maxSize) {
            width = Math.round((width * maxSize) / height);
            height = maxSize;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, width);
        canvas.height = Math.max(1, height);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(img.src);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
}

export function getAllMemberAvatars(): Record<string, string> {
  try {
    const raw = localStorage.getItem(AVATAR_STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn('Get avatars error:', e);
  }
  return {};
}

export function getMemberAvatar(agentId: string): string | null {
  const avatars = getAllMemberAvatars();
  if (agentId === 'user') {
    return avatars['user'] || avatars['agent_owner'] || null;
  }
  if (agentId === 'agent_owner') {
    return avatars['agent_owner'] || avatars['user'] || null;
  }
  return avatars[agentId] || null;
}

export function setMemberAvatar(agentId: string, dataUrl: string | null): void {
  try {
    const avatars = getAllMemberAvatars();
    if (dataUrl) {
      avatars[agentId] = dataUrl;
      if (agentId === 'agent_owner') {
        avatars['user'] = dataUrl;
      } else if (agentId === 'user') {
        avatars['agent_owner'] = dataUrl;
      }
    } else {
      delete avatars[agentId];
      if (agentId === 'agent_owner') {
        delete avatars['user'];
      } else if (agentId === 'user') {
        delete avatars['agent_owner'];
      }
    }
    localStorage.setItem(AVATAR_STORAGE_KEY, JSON.stringify(avatars));
    // 派发自定义全局事件通知全站实时更新头像
    window.dispatchEvent(new CustomEvent('luma_avatar_updated', { detail: { agentId, dataUrl } }));
  } catch (e) {
    console.warn('Save avatar error:', e);
    // 即使 localStorage 配额受阻，依然派发内存级事件供当前会话响应
    window.dispatchEvent(new CustomEvent('luma_avatar_updated', { detail: { agentId, dataUrl } }));
  }
}
