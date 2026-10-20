/**
 * 工单 10-R1「画布与墨滴」的画布逻辑层（纯计算，可在 node 环境单测）。
 *
 * 单位约定（修复 10-A/D 的单位混用）：
 * - 跟随、笔宽、速度：全部用 CSS 像素与「像素/毫秒」，阈值也写在像素上；
 * - 归一化坐标只用于把像素位置换算到覆盖层画布与热区，换算函数都标明单位。
 *
 * 这里不创建任何 DOM，也不读 canvas 上下文；组件只负责把结果画上去。
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/* ---------------- 画笔跟随（像素单位） ---------------- */

export const FOLLOWER = {
  /** 常规收敛比例：每帧把剩余像素距离收掉一部分 */
  pull: 0.16,
  /** 已经贴得很近时收得更轻，避免最后一帧「啪」地贴上去 */
  pullClose: 0.1,
  /** 判定「站住了」的像素阈值：单位就是 CSS 像素 */
  epsilonPx: 0.5,
  /** 判定「近距离」的像素距离 */
  closeDistancePx: 24,
} as const;

/**
 * 像素坐标上的收敛。与旧版 0-1 归一化坐标的 `easeTowards` 不同：
 * 这里的 epsilon 真的是像素，短距离（例如 200px → 200.4px）也会留下中间值，
 * 不会一步到位。
 */
export function easeTowardsPx(
  current: number,
  target: number,
  pull: number = FOLLOWER.pull,
  epsilonPx: number = FOLLOWER.epsilonPx,
): number {
  if (!Number.isFinite(current) || !Number.isFinite(target)) return target;
  const next = current + (target - current) * pull;
  return Math.abs(target - next) < epsilonPx ? target : next;
}

export function distancePx(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** 确定性随机（mulberry32）：亚麻纹理、笔毛毛刺都用它，保证同一台机器上结果稳定 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/* ---------------- 油画笔：速度决定笔宽 ---------------- */

export const BRUSH = {
  /** 快速移动时的最细笔宽（CSS 像素） */
  minWidth: 15,
  /** 慢速移动时的最厚笔宽（CSS 像素） */
  maxWidth: 74,
  /** 小于这个速度算「停住」，给最厚笔 */
  slowSpeed: 0.22,
  /** 大于这个速度算「甩过去」，给最细笔 */
  fastSpeed: 2.6,
  /** 速度平滑系数：越大越跟手，越小越稳 */
  speedSmoothing: 0.32,
  /** 一排毛的数量 */
  bristles: 5,
  /** 采样步长 = 笔宽 × stepRatio，保证快速移动不断点 */
  stepRatio: 0.16,
  minStep: 2.5,
  maxStep: 12,
} as const;

/** 速度归一化到 0（慢）～1（快） */
export function normalizeSpeed(speed: number, opts: { slowSpeed: number; fastSpeed: number } = BRUSH): number {
  if (!Number.isFinite(speed) || speed <= opts.slowSpeed) return 0;
  if (speed >= opts.fastSpeed) return 1;
  return (speed - opts.slowSpeed) / (opts.fastSpeed - opts.slowSpeed);
}

/** 快速移动较细、慢速移动较厚；结果是 CSS 像素 */
export function brushWidthForSpeed(
  speed: number,
  opts: { minWidth: number; maxWidth: number; slowSpeed: number; fastSpeed: number } = BRUSH,
): number {
  const t = normalizeSpeed(speed, opts);
  return opts.maxWidth + (opts.minWidth - opts.maxWidth) * t;
}

/** 指数平滑：速度读数抖动时笔宽也平滑变化 */
export function smoothValue(previous: number, next: number, alpha: number = BRUSH.speedSmoothing): number {
  if (!Number.isFinite(previous)) return next;
  return previous + (next - previous) * alpha;
}

/** 轨迹采样步长（CSS 像素） */
export function strokeStep(width: number, opts: { stepRatio: number; minStep: number; maxStep: number } = BRUSH): number {
  return clamp(width * opts.stepRatio, opts.minStep, opts.maxStep);
}

/**
 * 在两点之间插点。返回的数组不含起点、必含终点，
 * 因此把每段的结果依次画出来就不会有断点，快速甩笔也一样。
 */
export function interpolateStroke(from: Point, to: Point, step: number): Point[] {
  const total = distancePx(from, to);
  const safeStep = step > 0 ? step : BRUSH.minStep;
  if (total === 0) return [{ x: to.x, y: to.y }];
  const count = Math.max(1, Math.ceil(total / safeStep));
  const points: Point[] = [];
  for (let i = 1; i <= count; i += 1) {
    const t = i / count;
    points.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }
  return points;
}

/** 轨迹切线方向（弧度），笔刷朝向与毛的横向偏移都用它 */
export function strokeDirection(from: Point, to: Point): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/* ---------------- 毛刷印章（R2：带 alpha 的毛刷贴图，替代程序化线条） ---------------- */

export const BRUSH_STAMP = {
  /** 印章池数量：同一笔里轮流取用，避免一连串一模一样的印 */
  variants: 6,
  /** 印章贴图的基础尺寸（贴图像素）：沿 x 轴为运动方向，画布上按笔宽缩放绘制 */
  baseWidth: 320,
  baseHeight: 160,
  /** 一枚印章里的毛丝数量 */
  bristles: 30,
  /** 笔心占笔厚的比例：中间压透、两侧留干刷毛边 */
  coreRatio: 0.5,
  /** 印章沿轨迹的间距 = 笔宽 × spacingRatio，保证快速移动也不出断缝 */
  spacingRatio: 0.24,
} as const;

/** 印章沿轨迹的间距（CSS 像素） */
export function stampSpacing(width: number): number {
  return clamp(width * BRUSH_STAMP.spacingRatio, 2, 26);
}

/** 笔宽 → 印章绘制尺寸（CSS 像素）：长边沿运动方向 */
export function stampDimensions(width: number): { length: number; thickness: number } {
  return { length: width * 1.42, thickness: width * 1.08 };
}

/** 印章池取用序号：确定性，同一笔的同一位置永远取同一枚 */
export function stampIndex(seed: number, position: number, variants: number = BRUSH_STAMP.variants): number {
  return Math.abs(Math.floor(seed) + position) % Math.max(1, variants);
}

/* ---------------- 揭幕暂停与恢复（R2-3） ---------------- */

/**
 * 揭幕暂停后恢复：用暂停瞬间已经走掉的有效动画时长续走，
 * 不按墙钟时间直接跳到终点（提示挂着的 minutes 不能吃掉动画）。
 */
export function resumeStartedAt(pausedElapsedMs: number, now: number): number {
  return now - Math.max(0, Number.isFinite(pausedElapsedMs) ? pausedElapsedMs : 0);
}

/* ---------------- 墨滴：固定噪声轮廓 + rAF 推进 ---------------- */

export interface InkHarmonic {
  k: number;
  amp: number;
  phase: number;
}

export const INK = {
  /** 首次点击揭幕：扩散时长（毫秒） */
  revealMs: 980,
  /** 区域入口的第二次扩散：短一点，别让人等 */
  enterMs: 420,
  /** 刚落下时的静止帧，避免第一帧就是一大块 */
  holdMs: 70,
  /** 固定噪声轮廓：三个谐波叠加，确定性、不逐帧生成 */
  harmonics: [
    { k: 3, amp: 0.062, phase: 0.7 },
    { k: 5, amp: 0.038, phase: 2.1 },
    { k: 8, amp: 0.022, phase: 4.2 },
  ] as InkHarmonic[],
  /** 轮廓采样点数 */
  lobes: 72,
  /** 扩散到画面外，保证四角也揭干净（噪声轮廓最窄处约 0.88 倍，这里留足余量） */
  overshoot: 1.25,
} as const;

/** easeOutCubic */
function easeOutCubic(t: number): number {
  const clamped = clamp(t, 0, 1);
  return 1 - Math.pow(1 - clamped, 3);
}

/** 时间 → 进度（含落下的静止帧与缓出），返回 0～1 */
export function inkProgress(
  elapsedMs: number,
  durationMs: number,
  holdMs: number = INK.holdMs,
): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  if (!(durationMs > 0)) return 1;
  const active = Math.max(0, durationMs - holdMs);
  if (elapsedMs <= holdMs) return 0;
  return easeOutCubic((elapsedMs - holdMs) / active);
}

/** 进度 → 半径：从很小的一滴长到 maxRadius */
export function inkRadius(progress: number, maxRadius: number, startRadius = 6): number {
  const t = clamp(progress, 0, 1);
  return startRadius + (maxRadius - startRadius) * t;
}

/** 从落点扩散到盖住整个盒子所需要的半径 */
export function inkMaxRadius(origin: Point, box: Size, overshoot: number = INK.overshoot): number {
  const corners: Point[] = [
    { x: 0, y: 0 },
    { x: box.width, y: 0 },
    { x: 0, y: box.height },
    { x: box.width, y: box.height },
  ];
  const farthest = corners.reduce((max, corner) => Math.max(max, distancePx(origin, corner)), 0);
  return farthest * overshoot;
}

/** 固定噪声轮廓：角度 → 半径倍率（≥0.5，保证形状不自我交叉） */
export function blobRadiusScale(angle: number, harmonics: InkHarmonic[] = INK.harmonics): number {
  let scale = 1;
  for (const harmonic of harmonics) scale += harmonic.amp * Math.sin(harmonic.k * angle + harmonic.phase);
  return Math.max(0.5, scale);
}

/** 墨滴轮廓采样点：确定性，同样的角度永远给同样的半径 */
export function blobOutline(center: Point, radius: number, lobes: number = INK.lobes): Point[] {
  const count = Math.max(8, Math.floor(lobes));
  const points: Point[] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    const r = radius * blobRadiusScale(angle);
    points.push({ x: center.x + Math.cos(angle) * r, y: center.y + Math.sin(angle) * r });
  }
  return points;
}

/* ---------------- 覆盖层画布：分辨率与 resize 保真 ---------------- */

export const COVERAGE = {
  /** 覆盖层单张画布的设备像素上限，控制内存（≈ 2.6M 像素 ≈ 10MB） */
  maxDevicePixels: 2_600_000,
  /** 设备像素比上限：再高也看不出笔触差别，只会吃内存 */
  maxDpr: 1.5,
} as const;

/** 覆盖层的实际绘制比例（CSS 像素 × 这个比例 = 画布像素） */
export function canvasScale(
  box: Size,
  dpr: number,
  opts: { maxDevicePixels: number; maxDpr: number } = COVERAGE,
): number {
  const base = clamp(Number.isFinite(dpr) && dpr > 0 ? dpr : 1, 0.5, opts.maxDpr);
  const area = Math.max(1, box.width * box.height) * base * base;
  if (area <= opts.maxDevicePixels) return base;
  return base * Math.sqrt(opts.maxDevicePixels / area);
}

export interface RemapRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/**
 * 窗口尺寸变化时把旧覆盖层整张拉进新画布：
 * 已经揭开的比例与轨迹保持不变（不会因为重设尺寸又变回白布）。
 */
export function remapCoverage(previous: Size, next: Size): RemapRect {
  return {
    sx: 0,
    sy: 0,
    sw: Math.max(1, previous.width),
    sh: Math.max(1, previous.height),
    dx: 0,
    dy: 0,
    dw: Math.max(1, next.width),
    dh: Math.max(1, next.height),
  };
}

/** 归一化坐标（0-1）→ 覆盖层画布像素坐标 */
export function normalizedToCanvas(point: Point, box: Size): Point {
  return { x: clamp(point.x, 0, 1) * box.width, y: clamp(point.y, 0, 1) * box.height };
}

/** 覆盖层画布像素坐标 → 归一化坐标（0-1） */
export function canvasToNormalized(point: Point, box: Size): Point {
  const width = box.width || 1;
  const height = box.height || 1;
  return { x: point.x / width, y: point.y / height };
}
