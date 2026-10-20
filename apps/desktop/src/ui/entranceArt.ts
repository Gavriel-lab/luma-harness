/**
 * 工单 10-R1「画布与墨滴」的入口画几何层。
 *
 * 这里只放能在 node 环境里单测的确定性数据与坐标换算，不碰 DOM：
 * - 主画面的 viewBox 与三个区域的路径/锚点（全部来自 entranceGeometry.json，单一事实来源）；
 * - 按北京时间选白日/夜里两张整画；
 * - object-fit: cover 与 SVG preserveAspectRatio="slice" 的等效裁切换算，
 *   用来验证「展示层、Canvas、热区共用同一套尺寸与裁切变换」，
 *   以及「不同裁切下命中正确」。
 *
 * 热区坐标必须与主画面同源：SVG 热区层与 <img> 用同一个 viewBox 与同一套裁切参数，
 * 因此缩放、竖屏、宽屏下都落在同一像素上。
 */
import geometry from './entranceGeometry.json';

export type RegionId = 'cabin' | 'garden' | 'table' | 'diary' | 'study';
/** 区域落到哪个真实功能：私聊 / 客厅群聊 / 工作台 / 日记馆 / 书房 */
export type RegionTarget = 'direct' | 'living-room' | 'workbench' | 'diary' | 'study';
export type ArtVariant = 'day' | 'night';

export interface EntranceRegion {
  id: RegionId;
  label: string;
  hint: string;
  target: RegionTarget;
  /** 区域内的稳定点位（viewBox 坐标）：键盘触发墨滴、标签定位都用它 */
  anchor: { x: number; y: number };
  /** 不规则区域轮廓，viewBox 坐标 */
  path: string;
}

export interface EntranceViewBox {
  width: number;
  height: number;
}

export const ENTRANCE_VIEWBOX: EntranceViewBox = geometry.viewBox;
export const ENTRANCE_REGIONS: EntranceRegion[] = geometry.regions as EntranceRegion[];
export const ENTRANCE_ART = geometry.art;
/** 主画面与热区共用的居中裁切（cover 或 contain，由盒子比例决定） */
export const ENTRANCE_FOCUS = '50% 50%';
/**
 * 宽高比低于这个值就改用 contain：竖屏下 16:10 的整画若继续 cover 裁切，
 * 左边的小木屋和右边的木桌会被裁掉，三个入口就少两个。
 */
export const CONTAIN_BELOW_ASPECT = 1.25;

export type SceneFit = 'cover' | 'contain';

/** 三个区域必须一一对应三个真实功能，且路径非空 */
export function regionById(id: RegionId): EntranceRegion {
  const found = ENTRANCE_REGIONS.find((region) => region.id === id);
  if (!found) throw new Error('未知的入口画区域: ' + id);
  return found;
}

export function regionTargets(): RegionTarget[] {
  return ENTRANCE_REGIONS.map((region) => region.target);
}

/** 北京时间选画：白天用白日画布，其余用夜里画布（两版构图一致，热区共用） */
export function selectArtVariant(beijingHour: number): ArtVariant {
  const hour = Number.isFinite(beijingHour) ? Math.floor(beijingHour) : 0;
  const from = ENTRANCE_ART.dayFromHour;
  const to = ENTRANCE_ART.dayToHour;
  return hour >= from && hour <= to ? 'day' : 'night';
}

export function artSource(baseUrl: string, variant: ArtVariant): string {
  return baseUrl + ENTRANCE_ART.variants[variant].src;
}

/** 主画面的宽高比，供测试与素材门禁使用 */
export function entranceAspect(): number {
  return ENTRANCE_VIEWBOX.width / ENTRANCE_VIEWBOX.height;
}

/* ---------------- 裁切换算（与 CSS / SVG 严格同源） ---------------- */

export interface CoverCrop {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** 盒子用 cover 还是 contain：竖屏/方屏用 contain，保证三个区域都在画面里 */
export function fitForBox(boxWidth: number, boxHeight: number): SceneFit {
  if (!(boxWidth > 0) || !(boxHeight > 0)) return 'cover';
  return boxWidth / boxHeight < CONTAIN_BELOW_ASPECT ? 'contain' : 'cover';
}

/**
 * 复刻浏览器居中 object-fit 的裁切：
 * - cover：按较大的比例缩放铺满盒子，多出来的部分左右或上下均分；
 * - contain：按较小的比例缩放整张放进盒子，空出来的部分上下或左右均分。
 * 与 SVG 的 preserveAspectRatio="xMidYMid slice | meet" 完全等价。
 */
export function fitCrop(
  imageWidth: number,
  imageHeight: number,
  boxWidth: number,
  boxHeight: number,
  fit: SceneFit = 'cover',
): CoverCrop {
  if (!(imageWidth > 0) || !(imageHeight > 0) || !(boxWidth > 0) || !(boxHeight > 0)) {
    return { scale: 1, offsetX: 0, offsetY: 0 };
  }
  const scale =
    fit === 'cover'
      ? Math.max(boxWidth / imageWidth, boxHeight / imageHeight)
      : Math.min(boxWidth / imageWidth, boxHeight / imageHeight);
  return {
    scale,
    offsetX: (boxWidth - imageWidth * scale) / 2,
    offsetY: (boxHeight - imageHeight * scale) / 2,
  };
}

/** 兼容旧名字：默认 cover 的居中裁切 */
export function sliceCrop(
  imageWidth: number,
  imageHeight: number,
  boxWidth: number,
  boxHeight: number,
): CoverCrop {
  return fitCrop(imageWidth, imageHeight, boxWidth, boxHeight, 'cover');
}

/** SVG 的 preserveAspectRatio：必须与 fit 一一对应，热区才不会和画面错开 */
export function preserveAspectRatioFor(fit: SceneFit): string {
  return fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet';
}

/** viewBox 坐标 → 盒子内归一化坐标（0-1）；被裁掉的部分返回 null */
export function viewBoxToNormalized(
  point: { x: number; y: number },
  boxWidth: number,
  boxHeight: number,
  fit: SceneFit = fitForBox(boxWidth, boxHeight),
): { x: number; y: number } | null {
  const crop = fitCrop(ENTRANCE_VIEWBOX.width, ENTRANCE_VIEWBOX.height, boxWidth, boxHeight, fit);
  const x = (crop.offsetX + point.x * crop.scale) / boxWidth;
  const y = (crop.offsetY + point.y * crop.scale) / boxHeight;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/** 盒子内归一化坐标（0-1）→ viewBox 坐标；与 viewBoxToNormalized 互为逆运算 */
export function normalizedToViewBox(
  point: { x: number; y: number },
  boxWidth: number,
  boxHeight: number,
  fit: SceneFit = fitForBox(boxWidth, boxHeight),
): { x: number; y: number } {
  const crop = fitCrop(ENTRANCE_VIEWBOX.width, ENTRANCE_VIEWBOX.height, boxWidth, boxHeight, fit);
  const scale = crop.scale || 1;
  return {
    x: (point.x * boxWidth - crop.offsetX) / scale,
    y: (point.y * boxHeight - crop.offsetY) / scale,
  };
}

/** 区域锚点 → 盒子内 CSS 像素坐标（键盘触发墨滴用）；锚点被裁掉时返回 null，调用方回退画面中心 */
export function regionAnchorBoxPoint(
  target: RegionTarget,
  boxWidth: number,
  boxHeight: number,
  fit: SceneFit = fitForBox(boxWidth, boxHeight),
): { x: number; y: number } | null {
  const region = ENTRANCE_REGIONS.find((entry) => entry.target === target);
  if (!region) return null;
  const normalized = viewBoxToNormalized(region.anchor, boxWidth, boxHeight, fit);
  if (!normalized) return null;
  return { x: normalized.x * boxWidth, y: normalized.y * boxHeight };
}

/** 区域在画面上的可见性：常见视口下三个锚点都不该被裁掉 */
export function visibleRegions(boxWidth: number, boxHeight: number): RegionId[] {
  const fit = fitForBox(boxWidth, boxHeight);
  return ENTRANCE_REGIONS.filter(
    (region) => viewBoxToNormalized(region.anchor, boxWidth, boxHeight, fit) !== null,
  ).map((region) => region.id);
}
