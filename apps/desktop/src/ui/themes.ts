import type { ThemeId } from '../types';

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  /** 桌面端 cover 焦点，来自素材亮度质心分析 */
  desktopFocus: string;
  /** 手机端允许不同裁切 */
  mobileFocus: string;
  background: string;
  note: string;
}

export const THEMES: ThemeMeta[] = [
  {
    id: 'fusion',
    label: '融合之家',
    // 亮度质心 52.9% / 48.9%，画面中心最亮
    desktopFocus: '52% 49%',
    mobileFocus: '50% 46%',
    background: 'fusion.webp',
    note: '睡莲、星月、暖灯与窗边书桌 · 默认主题',
  },
  {
    id: 'day',
    label: '日间花园',
    // 最亮 8% 区域质心 54.4% / 32.1%，偏上
    desktopFocus: '54% 38%',
    mobileFocus: '56% 32%',
    background: 'day.webp',
    note: '明亮花园、奶油白、鼠尾草绿与雾蓝',
  },
  {
    id: 'night',
    label: '星夜小屋',
    // 最亮 8% 区域质心 46.1% / 36.3%，略偏左上
    desktopFocus: '48% 42%',
    mobileFocus: '46% 38%',
    background: 'night.webp',
    note: '深蓝、靛蓝、柔和暖金与灯光',
  },
];

export const themeById = (id: ThemeId): ThemeMeta => THEMES.find((t) => t.id === id) ?? THEMES[0]!;