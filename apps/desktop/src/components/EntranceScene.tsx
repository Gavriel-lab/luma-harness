/**
 * 工单 10-R1/R2：入口画的画布层「揭幕」。
 *
 * 一次性做三件事，全部在同一个 requestAnimationFrame 循环里推进，
 * 不逐帧生成 data URL、不逐帧触发 React 渲染：
 * 1. 覆盖层：带亚麻纹理的画布盖住主画面，指针移动时用毛刷印章沿轨迹擦出底画；
 * 2. 墨滴：点击处落下不规则墨滴，rAF 推进扩散；第一次点击只揭幕，不作为导航；
 * 3. 进入：选定区域后在点击处再扩散一次，把主画面「溶开」露出后面已准备好的目标界面。
 *
 * R2 收口：
 * - 进入只有一个启动点（beginEnter），目标与原点一次传完；鼠标用实际落点，
 *   键盘用区域锚点，只有通用「进来吧」用画面中心；
 * - 关键提示出现时：进入就地取消（保留完整入口画、解锁重选），
 *   揭幕就地暂停（保留已擦开的画布），恢复后按有效动画时间续走。
 *
 * 展示层（img）、覆盖层（canvas）、热区（SVG）共用同一块盒子和同一套居中裁切，
 * 因此缩放、竖屏、窗口变化下三者始终对齐。
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  fitCrop,
  fitForBox,
  regionAnchorBoxPoint,
  type RegionTarget,
  type SceneFit,
} from '../ui/entranceArt';
import {
  BRUSH,
  BRUSH_STAMP,
  FOLLOWER,
  INK,
  blobOutline,
  brushWidthForSpeed,
  canvasScale,
  clamp,
  distancePx,
  easeTowardsPx,
  inkMaxRadius,
  inkProgress,
  inkRadius,
  interpolateStroke,
  remapCoverage,
  resumeStartedAt,
  seededRandom,
  smoothValue,
  stampDimensions,
  stampIndex,
  stampSpacing,
  strokeDirection,
  type Point,
  type Size,
} from '../ui/entranceCanvas';
import { EntranceLabels } from './EntranceLabels';
import { EntrancePointer } from './EntrancePointer';
import { WELCOME_TIMING } from '../ui/welcomeDoor';

export interface EntranceSceneHandle {
  /** 从 origin（盒子内 CSS 像素坐标，默认画面中心）扩散一次，结束后回调 onRegionSettled */
  enter(target: RegionTarget | null, origin?: Point): void;
  /** 键盘/按钮触发的「落一滴水」：在中部落一滴墨，只揭幕 */
  reveal(): void;
}

export interface EntranceSceneProps {
  stage: 'cover' | 'entrance';
  /** 是否走动效（应用内动效开关 + prefers-reduced-motion） */
  animate: boolean;
  /** 关键提示存在：门口让位，画布不再接收指针与键盘 */
  suspended: boolean;
  /** 数据是否已经安全就绪：没就绪就不启动进入流程 */
  ready: boolean;
  artSrc: string;
  /** 换张新画布的重播计数：变化即重新盖一张干净画布 */
  resetToken: number;
  onRevealed: () => void;
  onRegionRequest: (target: RegionTarget) => void;
  onRegionSettled: (target: RegionTarget | null) => void;
  /** 图片解码失败或拿不到 2D 上下文：交给门口的静态文字入口兜底 */
  onUnavailable: (reason: 'image' | 'canvas') => void;
}

interface InkRun {
  mode: 'reveal' | 'enter';
  target: RegionTarget | null;
  origin: Point;
  maxRadius: number;
  startedAt: number;
  duration: number;
  /** R2-3：揭幕被关键提示暂停时已经走掉的有效时长（毫秒） */
  pausedElapsed?: number;
}

  /**
   * R3-B：细亚麻。去掉 R2 每 4px 的规则纵横线（原生 EXE 里铺满明显网格的主因），
   * 只留暖白/奶油底上的低对比短纤维与微小起伏；纤维跨 tile 边界补画，避免明显平铺感。
   */
  function makeLinenPattern(ctx: CanvasRenderingContext2D, scale: number): CanvasPattern | null {
    const tile = document.createElement('canvas');
    const size = Math.max(32, Math.round(96 * clamp(scale, 0.6, 1.5)));
    tile.width = size;
    tile.height = size;
    const tctx = tile.getContext('2d');
    if (!tctx) return null;
    const random = seededRandom(20261004);
    tctx.fillStyle = '#f6f1e6';
    tctx.fillRect(0, 0, size, size);
    // 低对比短纤维：两种接近底色的暖调，alpha 压得很低，只给「布」的触感
    const fibers = Math.round(size * 0.55);
    for (let i = 0; i < fibers; i += 1) {
      const x = random() * size;
      const y = random() * size;
      const len = 2 + random() * 7;
      const angle = random() * Math.PI;
      const shade = random() < 0.5 ? 'rgba(214,202,180,' : 'rgba(255,252,244,';
      tctx.strokeStyle = shade + (0.08 + random() * 0.1).toFixed(3) + ')';
      tctx.lineWidth = 0.7 + random() * 0.9;
      // 在四个相位补画同一根纤维，tile 重复时看不出接缝
      for (const [dx, dy] of [[0, 0], [-size, 0], [0, -size], [-size, -size]] as const) {
        tctx.beginPath();
        tctx.moveTo(x + dx, y + dy);
        tctx.lineTo(x + dx + Math.cos(angle) * len, y + dy + Math.sin(angle) * len);
        tctx.stroke();
      }
    }
    // 微小起伏：极淡的 1px 颗粒，代替任何网格结构
    const specks = Math.round(size * 0.7);
    for (let i = 0; i < specks; i += 1) {
      tctx.fillStyle = 'rgba(186,172,148,' + (0.03 + random() * 0.06).toFixed(3) + ')';
      const x = random() * size;
      const y = random() * size;
      tctx.fillRect(x, y, 1, 1);
    }
    return ctx.createPattern(tile, 'repeat');
  }

export const EntranceScene = forwardRef<EntranceSceneHandle, EntranceSceneProps>(function EntranceScene(
  { stage, animate, suspended, ready, artSrc, resetToken, onRevealed, onRegionRequest, onRegionSettled, onUnavailable },
  ref,
) {
  const staticMode = !animate;
  const sceneRef = useRef<HTMLDivElement>(null);
  const plateRef = useRef<HTMLDivElement>(null);
  const coverRef = useRef<HTMLCanvasElement>(null);
  const coverageRef = useRef<HTMLCanvasElement | null>(null);
  const exitRef = useRef<HTMLCanvasElement>(null);
  const artRef = useRef<HTMLImageElement>(null);
  const brushRef = useRef<HTMLDivElement>(null);

  const [imageFailed, setImageFailed] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [revealedAt, setRevealedAt] = useState<number | null>(stage === 'entrance' ? 1 : null);
  /** 盒子比例决定 cover / contain；主画面、覆盖层、热区共用这一个值 */
  const [fit, setFit] = useState<SceneFit>('cover');
  const fitRef = useRef<SceneFit>('cover');
  /**
   * R3-C：小提示的定位需要真实盒子比例（归一化坐标与纵横比有关，1×1 假盒子会把
   * 左右锚点误判成「被裁掉」）。syncCanvasSize 在尺寸变化时同步进来。
   */
  const [hintBox, setHintBox] = useState<Size>(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth || 1 : 1,
    height: typeof window !== 'undefined' ? window.innerHeight || 1 : 1,
  }));

  const dirtyRef = useRef(true);
  const patternRef = useRef<{ key: string; pattern: CanvasPattern | null }>({ key: '', pattern: null });
  const scaleRef = useRef(1);
  const sizeRef = useRef<Size>({ width: 0, height: 0 });
  const introRef = useRef<{ startedAt: number } | null>(null);
  const pointerActiveRef = useRef(false);
  const targetRef = useRef<Point>({ x: 0, y: 0 });
  const tipRef = useRef<Point>({ x: 0, y: 0 });
  const lastEraseRef = useRef<Point | null>(null);
  const lastMoveAtRef = useRef(0);
  const speedRef = useRef(0);
  const widthRef = useRef<number>(BRUSH.maxWidth);
  const angleRef = useRef(0);
  const strokeSeedRef = useRef(1);
  const rafRef = useRef(0);
  const stepRef = useRef<() => void>(() => {});
  const inkRef = useRef<InkRun | null>(null);
  const settleTimerRef = useRef(0);
  const lockedRef = useRef(false);
  const finishedRef = useRef(false);
  const stampPoolRef = useRef<HTMLCanvasElement[]>([]);
  const stageRef = useRef(stage);
  const suspendedRef = useRef(suspended);
  const readyRef = useRef(ready);
  const staticRef = useRef(staticMode);
  const imageFailedRef = useRef(false);
  const callbacksRef = useRef({ onRevealed, onRegionSettled, onRegionRequest, onUnavailable });
  callbacksRef.current = { onRevealed, onRegionSettled, onRegionRequest, onUnavailable };
  stageRef.current = stage;
  suspendedRef.current = suspended;
  readyRef.current = ready;
  staticRef.current = staticMode;
  imageFailedRef.current = imageFailed;

  const interactive = stage === 'entrance' || staticMode;
  const regionTabbable = interactive && !exiting && !suspended && !imageFailed;
  const coverVisible = !staticMode && !imageFailed && stage === 'cover' && !exiting;

  /* ---------------- 覆盖层：尺寸、纹理、重画 ---------------- */

  const coverage = useCallback((): HTMLCanvasElement => {
    if (!coverageRef.current) {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      coverageRef.current = canvas;
    }
    return coverageRef.current;
  }, []);

  const context2d = useCallback((canvas: HTMLCanvasElement | null): CanvasRenderingContext2D | null => {
    if (!canvas) return null;
    try {
      return canvas.getContext('2d');
    } catch {
      return null;
    }
  }, []);

  /** 让覆盖层与可见画布跟上盒子尺寸；尺寸变化时把已有轨迹按比例搬过去，不会变回白布 */
  const syncCanvasSize = useCallback((): boolean => {
    const scene = sceneRef.current;
    const cover = coverRef.current;
    const exit = exitRef.current;
    if (!scene || !cover) return false;
    const box: Size = { width: scene.clientWidth, height: scene.clientHeight };
    if (!box.width || !box.height) return false;
    // 竖屏/方屏改用 contain：整张画都在画面里，三个区域都不会被裁掉
    const nextFit = fitForBox(box.width, box.height);
    if (nextFit !== fitRef.current) {
      fitRef.current = nextFit;
      setFit(nextFit);
    }
    const scale = canvasScale(box, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(box.width * scale));
    const height = Math.max(1, Math.round(box.height * scale));
    sizeRef.current = box;
    setHintBox((prev) => (prev.width === box.width && prev.height === box.height ? prev : box));
    if (cover.width === width && cover.height === height && coverageRef.current?.width === width) return true;
    scaleRef.current = scale;
    const mask = coverage();
    const maskCtx = context2d(mask);
    if (!maskCtx) {
      callbacksRef.current.onUnavailable('canvas');
      return false;
    }
    if (mask.width > 1 && mask.height > 1) {
      const previous = document.createElement('canvas');
      previous.width = mask.width;
      previous.height = mask.height;
      context2d(previous)?.drawImage(mask, 0, 0);
      mask.width = width;
      mask.height = height;
      const nextCtx = context2d(mask);
      if (nextCtx) {
        const rect = remapCoverage({ width: previous.width, height: previous.height }, { width, height });
        nextCtx.drawImage(previous, rect.sx, rect.sy, rect.sw, rect.sh, rect.dx, rect.dy, rect.dw, rect.dh);
      }
    } else {
      mask.width = width;
      mask.height = height;
    }
    cover.width = width;
    cover.height = height;
    if (exit) {
      exit.width = width;
      exit.height = height;
    }
    dirtyRef.current = true;
    return true;
  }, [context2d, coverage]);

  /** 重新盖上一张干净的画布 */
  const refillCover = useCallback(() => {
    const mask = coverage();
    const ctx = context2d(mask);
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, mask.width, mask.height);
    ctx.fillStyle = '#f6f1e6';
    ctx.fillRect(0, 0, mask.width, mask.height);
    dirtyRef.current = true;
    setRevealedAt(null);
  }, [context2d, coverage]);

  /** 把覆盖层画到可见画布上：亚麻纹理 × 覆盖遮罩 */
  const renderCover = useCallback(() => {
    const cover = coverRef.current;
    const mask = coverageRef.current;
    const ctx = context2d(cover);
    if (!cover || !mask || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, cover.width, cover.height);
    // 亚麻纹理按尺寸缓存：只在尺寸变化时重建，别每帧重画一张纹理图
    const cacheKey = cover.width + 'x' + cover.height + '@' + scaleRef.current.toFixed(3);
    if (patternRef.current.key !== cacheKey) {
      patternRef.current = { key: cacheKey, pattern: makeLinenPattern(ctx, scaleRef.current) };
    }
    ctx.fillStyle = patternRef.current.pattern ?? '#f6f1e6';
    ctx.fillRect(0, 0, cover.width, cover.height);
    const shade = ctx.createRadialGradient(
      cover.width / 2,
      cover.height * 0.44,
      Math.min(cover.width, cover.height) * 0.18,
      cover.width / 2,
      cover.height * 0.5,
      Math.max(cover.width, cover.height) * 0.78,
    );
    shade.addColorStop(0, 'rgba(255,255,255,0)');
    shade.addColorStop(1, 'rgba(120,104,78,0.1)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, cover.width, cover.height);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(mask, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    dirtyRef.current = false;
  }, [context2d]);

  /* ---------------- 毛刷印章：带 alpha 的贴图，沿轨迹旋转盖印 ---------------- */

  /**
   * 印章池：启动时生成几枚确定性的毛刷贴图（白底，靠 alpha 当擦除蒙版）。
   * 每枚是一把疏密不匀的毛丝：中间压透、两侧留干刷毛边和断丝，
   * 盖印时按运动方向旋转、按笔宽缩放——不是几条粗圆头线。
   */
  const ensureStamps = useCallback((): HTMLCanvasElement[] => {
    if (stampPoolRef.current.length > 0) return stampPoolRef.current;
    const stamps: HTMLCanvasElement[] = [];
    for (let variant = 0; variant < BRUSH_STAMP.variants; variant += 1) {
      const tile = document.createElement('canvas');
      tile.width = BRUSH_STAMP.baseWidth;
      tile.height = BRUSH_STAMP.baseHeight;
      const ctx = tile.getContext('2d');
      if (!ctx) continue;
      const random = seededRandom(20261005 + variant * 7919);
      const w = tile.width;
      const h = tile.height;
      const core = h * BRUSH_STAMP.coreRatio;
      // 毛丝：从左缘向右缘铺开的细丝，长短疏密带确定性抖动
      for (let b = 0; b < BRUSH_STAMP.bristles; b += 1) {
        const t = (b + 0.5) / BRUSH_STAMP.bristles;
        const offset = (t - 0.5) * h * 0.86;
        const y0 = h / 2 + offset + (random() - 0.5) * h * 0.05;
        const inCore = Math.abs(offset) < core / 2;
        const length = w * (inCore ? 0.86 + random() * 0.12 : 0.52 + random() * 0.4);
        const drift = (random() - 0.5) * h * 0.22;
        const alpha = inCore ? 0.66 + random() * 0.3 : 0.2 + random() * 0.42;
        const width = 1.4 + random() * 2.6;
        ctx.strokeStyle = 'rgba(255,255,255,' + alpha.toFixed(3) + ')';
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(w * 0.03, y0);
        ctx.quadraticCurveTo(w * 0.45, y0 + drift * 0.6, w * 0.03 + length, y0 + drift);
        ctx.stroke();
      }
      // 笔心：叠一层柔和的实心带，保证一笔的中心真的擦得透
      const band = ctx.createLinearGradient(0, h / 2 - core / 2, 0, h / 2 + core / 2);
      band.addColorStop(0, 'rgba(255,255,255,0)');
      band.addColorStop(0.28, 'rgba(255,255,255,0.78)');
      band.addColorStop(0.5, 'rgba(255,255,255,0.9)');
      band.addColorStop(0.72, 'rgba(255,255,255,0.78)');
      band.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = band;
      ctx.fillRect(w * 0.02, h / 2 - core / 2, w * 0.92, core);
      // 干刷飞点：边缘散落的细小斑点，让笔触有“掉毛”的质感
      const specks = Math.round(BRUSH_STAMP.bristles * 1.6);
      for (let s = 0; s < specks; s += 1) {
        const x = random() * w * 0.96 + w * 0.02;
        const t = random() - 0.5;
        const y = h / 2 + t * h * 0.62;
        const nearCore = Math.abs(t) < 0.3;
        ctx.fillStyle = 'rgba(255,255,255,' + ((nearCore ? 0.3 : 0.14) + random() * 0.24).toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(x, y, 0.6 + random() * 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
      stamps.push(tile);
    }
    stampPoolRef.current = stamps;
    return stamps;
  }, []);

  /** 在一点盖一枚印章：以落点为中心、运动方向为长轴 */
  const stampAt = useCallback(
    (ctx: CanvasRenderingContext2D, point: Point, angle: number, width: number, index: number) => {
      const stamps = ensureStamps();
      if (stamps.length === 0) return;
      const scale = scaleRef.current;
      const stamp = stamps[stampIndex(strokeSeedRef.current, index)]!;
      const length = stampDimensions(width).length * scale;
      const thickness = stampDimensions(width).thickness * scale;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = 1;
      ctx.translate(point.x * scale, point.y * scale);
      ctx.rotate(angle);
      ctx.drawImage(stamp, -length / 2, -thickness / 2, length, thickness);
      ctx.restore();
    },
    [ensureStamps],
  );

  const eraseSegment = useCallback(
    (from: Point, to: Point, width: number) => {
      // 覆盖层（遮罩权威）与可见画布同时盖印：每帧不需要再整张合成一次
      const targets = [coverageRef.current, coverRef.current].filter(
        (canvas): canvas is HTMLCanvasElement => !!canvas && !canvas.hidden,
      );
      if (targets.length === 0) return;
      const step = stampSpacing(width);
      const tail = interpolateStroke(from, to, step);
      const points: Point[] = [from, ...tail];
      let angle = angleRef.current;
      for (let i = 0; i < points.length; i += 1) {
        const current = points[i]!;
        const next = points[i + 1];
        if (next) angle = strokeDirection(current, next);
        else if (i > 0) angle = strokeDirection(points[i - 1]!, current);
        for (const canvas of targets) {
          const ctx = context2d(canvas);
          if (ctx) stampAt(ctx, current, angle, width, i);
        }
      }
      angleRef.current = angle;
      strokeSeedRef.current += points.length;
    },
    [context2d, stampAt],
  );

  /* ---------------- 墨滴：不规则扩散 ---------------- */

  /**
   * R3-A：墨滴擦除自己管理绘图状态——
   * fillStyle 必须是确定的不透明颜色（R2 缺陷：继承 renderCover 留下的半透明
   * CanvasGradient，中心几乎不擦、只剩 stroke 描出的轮廓环）；
   * 湿边用 blur 得到连续 alpha 过渡，一次绘制成型，不叠出多层环。
   */
  const eraseBlob = useCallback(
    (targets: Array<HTMLCanvasElement | null>, origin: Point, radius: number, edge: number) => {
      const scale = scaleRef.current;
      const outline = blobOutline(origin, Math.max(1, radius));
      // 湿边羽化：随半径与 DPR 缩放，限制在「柔软但不成雾」的范围
      const feather = clamp(radius * edge * scale, 2, 26);
      for (const canvas of targets) {
        const ctx = context2d(canvas);
        if (!ctx) continue;
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#000000';
        ctx.filter = 'blur(' + feather.toFixed(1) + 'px)';
        ctx.beginPath();
        outline.forEach((point, index) => {
          const px = point.x * scale;
          const py = point.y * scale;
          if (index === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    },
    [context2d],
  );

  const clearCanvas = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      const ctx = context2d(canvas);
      if (!ctx || !canvas) return;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    },
    [context2d],
  );

  /* ---------------- 进入：主画面快照 + 溶开 ---------------- */

  const snapshotPlate = useCallback((): boolean => {
    const exit = exitRef.current;
    const image = artRef.current;
    if (!exit || !image) return false;
    if (!image.complete || !image.naturalWidth || !image.naturalHeight) return false;
    if (!syncCanvasSize()) return false;
    const box = sizeRef.current;
    const scale = scaleRef.current;
    const width = Math.max(1, Math.round(box.width * scale));
    const height = Math.max(1, Math.round(box.height * scale));
    exit.width = width;
    exit.height = height;
    const ctx = context2d(exit);
    if (!ctx) return false;
    try {
      // 与 object-fit / preserveAspectRatio 完全等价的居中裁切，保证快照与画面像素对齐
      const crop = fitCrop(image.naturalWidth, image.naturalHeight, width, height, fitRef.current);
      const drawWidth = image.naturalWidth * crop.scale;
      const drawHeight = image.naturalHeight * crop.scale;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, width, height);
      // contain 时上下会留边：先铺门口的底色，别让后面界面提前透出来
      ctx.fillStyle = '#141821';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(image, crop.offsetX, crop.offsetY, drawWidth, drawHeight);
    } catch {
      return false;
    }
    return true;
  }, [context2d, syncCanvasSize]);

  /**
   * R2-3：关键提示出现时取消进行中的「进入」。
   * 保留完整入口画（退出层清掉、退出态复位、锁全部解开），
   * 不触发任何完成回调；解决提示后由用户重新选择目标。
   */
  const cancelEnter = useCallback(() => {
    const scene = sceneRef.current;
    inkRef.current = null;
    if (settleTimerRef.current) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = 0;
    }
    clearCanvas(exitRef.current);
    setExiting(false);
    lockedRef.current = false;
    finishedRef.current = false;
    if (scene) {
      scene.style.setProperty('--wd-mask-scale', '2.6');
      scene.style.setProperty('--wd-glaze', stageRef.current === 'entrance' ? '0.3' : '0');
      scene.style.setProperty('--wd-zoom', '1');
      scene.style.setProperty('--wd-ink', '6px');
      delete scene.dataset.wdInk;
    }
  }, [clearCanvas]);

  /** R2-3：关键提示出现时暂停揭幕，记下已走掉的有效时长，已擦开的画布原样保留 */
  const pauseReveal = useCallback(() => {
    const ink = inkRef.current;
    if (!ink || ink.mode !== 'reveal') return;
    if (ink.pausedElapsed === undefined) {
      ink.pausedElapsed = Math.max(0, performance.now() - ink.startedAt);
    }
  }, []);

  const finishEnter = useCallback((target: RegionTarget | null) => {
    // R2-3：提示还没处理完，任何收口/兜底都不能当作完成进入
    if (suspendedRef.current) return;
    if (finishedRef.current) return;
    finishedRef.current = true;
    if (settleTimerRef.current) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = 0;
    }
    callbacksRef.current.onRegionSettled(target);
  }, []);

  const beginEnter = useCallback(
    (target: RegionTarget | null, origin?: Point) => {
      // R2-3：关键提示没处理完，不开始新的进入
      if (suspendedRef.current) return;
      if (lockedRef.current || finishedRef.current || imageFailedRef.current || !readyRef.current) return;
      const scene = sceneRef.current;
      if (!scene) return;
      lockedRef.current = true;
      finishedRef.current = false;
      const box = sizeRef.current.width ? sizeRef.current : { width: scene.clientWidth, height: scene.clientHeight };
      const point = origin ?? { x: box.width / 2, y: box.height / 2 };
      if (staticRef.current) {
        // 关闭动效或素材降级：不做扩散，直接进入
        finishEnter(target);
        return;
      }
      const snapshotted = snapshotPlate();
      const duration = snapshotted ? INK.enterMs : WELCOME_TIMING.transitionMs;
      if (snapshotted) setExiting(true);
      scene.style.setProperty('--wd-mask-scale', '1');
      scene.style.setProperty('--wd-glaze', '0.2');
      inkRef.current = {
        mode: 'enter',
        target,
        origin: point,
        maxRadius: inkMaxRadius(point, box),
        startedAt: performance.now(),
        duration,
      };
      settleTimerRef.current = window.setTimeout(() => finishEnter(target), duration + 320);
      scheduleRef.current();
    },
    // scheduleRef 在下面绑定，保证动画帧回调总是最新的一份
    [finishEnter, snapshotPlate],
  );

  /** 「落一滴水」：键盘或按钮触发，只揭幕，不作为区域导航 */
  const beginReveal = useCallback((origin?: Point) => {
    if (staticRef.current || imageFailedRef.current || suspendedRef.current) return;
    if (lockedRef.current || inkRef.current) return;
    const scene = sceneRef.current;
    if (!scene) return;
    const box = sizeRef.current.width
      ? sizeRef.current
      : { width: scene.clientWidth, height: scene.clientHeight };
    const point = origin ?? { x: box.width / 2, y: box.height / 2 };
    inkRef.current = {
      mode: 'reveal',
      target: null,
      origin: point,
      maxRadius: inkMaxRadius(point, box),
      startedAt: performance.now(),
      duration: INK.revealMs,
    };
    scene.style.setProperty('--wd-ink', '6px');
    scheduleRef.current();
  }, []);

  useImperativeHandle(ref, () => ({ enter: beginEnter, reveal: () => beginReveal() }), [beginEnter, beginReveal]);

  /* ---------------- 动画帧循环 ---------------- */

  const schedule = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      stepRef.current();
    });
  }, []);

  // beginEnter 需要在 schedule 定义之前引用它，这里补一次绑定
  const scheduleRef = useRef(schedule);
  scheduleRef.current = schedule;

  const stepFrame = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // R2-3：关键提示接管期间，动画就地暂停/取消——
    // 已排队的这一帧用来收尾状态，不推进、不完成、不续帧。
    if (suspendedRef.current) {
      const pending = inkRef.current;
      if (pending?.mode === 'enter') cancelEnter();
      else if (pending?.mode === 'reveal') pauseReveal();
      return;
    }

    let busy = false;
    const now = performance.now();

    // 首屏归位：rAF 逐帧推进，保证有真实中间帧
    if (introRef.current) {
      const t = clamp((now - introRef.current.startedAt) / WELCOME_TIMING.introMs, 0, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const zoom = WELCOME_TIMING.introScale + (1 - WELCOME_TIMING.introScale) * eased;
      scene.style.setProperty('--wd-zoom', zoom.toFixed(4));
      if (t >= 1) introRef.current = null;
      else busy = true;
    }

    // 笔刷跟随：像素单位收敛（短距离也有中间轨迹），并沿轨迹擦除
    if (!staticRef.current && !imageFailedRef.current && pointerActiveRef.current && stageRef.current === 'cover') {
      const target = targetRef.current;
      const tip = tipRef.current;
      const remaining = distancePx(tip, target);
      const pull = remaining < FOLLOWER.closeDistancePx ? FOLLOWER.pullClose : FOLLOWER.pull;
      const nextX = easeTowardsPx(tip.x, target.x, pull);
      const nextY = easeTowardsPx(tip.y, target.y, pull);
      const moving = nextX !== tip.x || nextY !== tip.y;
      const width = widthRef.current;
      if (moving) {
        const from = lastEraseRef.current ?? tip;
        const next = { x: nextX, y: nextY };
        eraseSegment(from, next, width);
        lastEraseRef.current = next;
        tipRef.current = next;
        strokeSeedRef.current += 1;
        busy = true;
      }
      const box = sizeRef.current;
      scene.style.setProperty('--wd-x', ((tip.x / Math.max(1, box.width)) * 100).toFixed(3) + '%');
      scene.style.setProperty('--wd-y', ((tip.y / Math.max(1, box.height)) * 100).toFixed(3) + '%');
      scene.style.setProperty('--wd-brush', width.toFixed(2) + 'px');
      scene.style.setProperty('--wd-brush-angle', ((angleRef.current * 180) / Math.PI).toFixed(1) + 'deg');
      if (brushRef.current) {
        brushRef.current.style.transform =
          'translate3d(' +
          tip.x.toFixed(1) +
          'px,' +
          tip.y.toFixed(1) +
          'px,0) rotate(' +
          (((angleRef.current * 180) / Math.PI) + 34).toFixed(1) +
          'deg)';
      }
    }

    // 墨滴扩散
    const ink = inkRef.current;
    if (ink) {
      const elapsed = now - ink.startedAt;
      const progress = inkProgress(elapsed, ink.duration, ink.mode === 'enter' ? 0 : INK.holdMs);
      const radius = inkRadius(progress, ink.maxRadius);
      if (ink.mode === 'reveal') eraseBlob([coverageRef.current, coverRef.current], ink.origin, radius, 0.06);
      else eraseBlob([exitRef.current], ink.origin, radius, 0.07);
      scene.dataset.wdInk = radius.toFixed(2);
      scene.style.setProperty('--wd-ink', radius.toFixed(2) + 'px');
      // 揭开的同时画面「亮起来」：两个可插值的数值由 rAF 逐帧推进
      scene.style.setProperty('--wd-mask-scale', (0.72 + (2.6 - 0.72) * progress).toFixed(4));
      scene.style.setProperty('--wd-glaze', ((ink.mode === 'reveal' ? 0.34 : 0.42) * progress).toFixed(4));
      if (ink.mode === 'enter') scene.style.setProperty('--wd-zoom', (1 + 0.08 * progress).toFixed(4));
      busy = true;
      if (progress >= 1 || elapsed >= ink.duration) {
        const mode = ink.mode;
        const target = ink.target;
        inkRef.current = null;
        if (mode === 'reveal') {
          // 揭幕收口：整张画布清干净，保证四角也露出来
          clearCanvas(coverageRef.current);
          clearCanvas(coverRef.current);
          scene.style.setProperty('--wd-mask-scale', '2.6');
          scene.style.setProperty('--wd-glaze', '0.32');
          setRevealedAt(Date.now());
          callbacksRef.current.onRevealed();
        } else {
          clearCanvas(exitRef.current);
          finishEnter(target);
        }
      }
    }

    if (dirtyRef.current) renderCover();
    if (busy) scheduleRef.current();
  }, [cancelEnter, clearCanvas, eraseBlob, eraseSegment, pauseReveal, renderCover]);

  stepRef.current = stepFrame;

  /* ---------------- 关键提示接管：取消进入 / 暂停与恢复揭幕（R2-3） ---------------- */

  useEffect(() => {
    if (!suspended) return;
    // 提示一出现就处理进行中的动画；stepFrame 的守卫兜住已经排队的帧
    const pending = inkRef.current;
    if (pending?.mode === 'enter' || exiting) cancelEnter();
    else if (pending?.mode === 'reveal') pauseReveal();
  }, [cancelEnter, exiting, pauseReveal, suspended]);

  useEffect(() => {
    if (suspended) return;
    // 提示解决后：揭幕按暂停瞬间已走掉的有效时长续走，不按墙钟跳到终点
    const ink = inkRef.current;
    if (ink && ink.mode === 'reveal' && ink.pausedElapsed !== undefined) {
      ink.startedAt = resumeStartedAt(ink.pausedElapsed, performance.now());
      ink.pausedElapsed = undefined;
    }
    if (ink) schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suspended]);

  /* ---------------- 尺寸、首屏、清理 ---------------- */

  useEffect(() => {
    if (staticMode || imageFailed) return;
    if (!syncCanvasSize()) return;
    // 只有首轮揭幕才盖白画布；从板块回到入口画时直接看完整主画面
    if (stage === 'cover') refillCover();
    renderCover();
  }, [imageFailed, refillCover, renderCover, stage, staticMode, syncCanvasSize]);

  // 换张新画布：重新盖一张干净的画布（只在计数变化时执行）
  useEffect(() => {
    if (staticMode || imageFailed || resetToken === 0) return;
    if (!syncCanvasSize()) return;
    refillCover();
    renderCover();
    if (sceneRef.current) sceneRef.current.style.setProperty('--wd-glaze', '0');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken]);

  useEffect(() => {
    // 首轮揭幕才有首屏归位；从板块回到入口画时直接给出完整画面
    if (staticMode || stage === 'entrance') return;
    introRef.current = { startedAt: performance.now() };
    schedule();
    return () => {
      introRef.current = null;
    };
  }, [schedule, stage, staticMode]);

  useEffect(() => {
    const onResize = () => {
      if (staticMode || imageFailed) return;
      if (!syncCanvasSize()) return;
      renderCover();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [imageFailed, renderCover, staticMode, syncCanvasSize]);

  useEffect(() => {
    const onVisibility = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') return;
      pointerActiveRef.current = false;
      lastEraseRef.current = null;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(
    () => () => {
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current);
    },
    [],
  );

  /* ---------------- 指针：笔刷跟随与首次墨滴 ---------------- */

  /**
   * 指针坐标 → 画布 CSS 像素坐标。
   * R2-1：进入阶段覆盖画布是隐藏的（display:none 拿不到有效矩形），
   * 必须按 cover → exit → scene 顺序取第一个有有效矩形的参照物；
   * cover/exit 在首屏归位时被整体缩放，用 backing 尺寸换算回画布坐标。
   */
  const boxPoint = useCallback((clientX: number, clientY: number): Point | null => {
    const candidates = [coverRef.current, exitRef.current, sceneRef.current];
    for (const el of candidates) {
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const scaleX = el.clientWidth / rect.width;
      const scaleY = el.clientHeight / rect.height;
      return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
    }
    return null;
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (staticMode || suspended || imageFailed || stage !== 'cover') return;
      if (event.pointerType === 'touch') return;
      const point = boxPoint(event.clientX, event.clientY);
      if (!point) return;
      const now = performance.now();
      const previous = targetRef.current;
      const elapsed = Math.max(8, now - (lastMoveAtRef.current || now - 16));
      lastMoveAtRef.current = now;
      // 速度 = 像素/毫秒，笔宽在同一套单位里算
      const instant = distancePx(previous, point) / elapsed;
      speedRef.current = smoothValue(speedRef.current, instant, BRUSH.speedSmoothing);
      widthRef.current = smoothValue(widthRef.current, brushWidthForSpeed(speedRef.current), 0.28);
      targetRef.current = point;
      if (!pointerActiveRef.current) {
        pointerActiveRef.current = true;
        tipRef.current = point;
        lastEraseRef.current = point;
      }
      if (brushRef.current) brushRef.current.dataset.wdVisible = '1';
      schedule();
    },
    [boxPoint, imageFailed, schedule, stage, staticMode, suspended],
  );

  const endPointer = useCallback(() => {
    pointerActiveRef.current = false;
    lastEraseRef.current = null;
    if (brushRef.current) delete brushRef.current.dataset.wdVisible;
  }, []);

  /** 首次点击：从落点落一滴墨，只负责揭幕，不作为区域导航 */
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (stage !== 'cover') return;
      const point = boxPoint(event.clientX, event.clientY);
      if (!point) return;
      beginReveal(point);
    },
    [beginReveal, boxPoint, stage],
  );

  /* ---------------- 热区：三个区域入口 ---------------- */

  /**
   * R2-1：区域进入只有一个启动点。这里先把目标与原点定死，再一次交给 beginEnter；
   * 通知（onRegionRequest）只负责让门口登记与准备目标界面，不再回头调用 enter。
   * 鼠标用实际落点；键盘（point 为 null）用区域锚点；锚点被裁掉才回退画面中心。
   */
  const requestRegion = useCallback(
    (target: RegionTarget, point: Point | null) => {
      if (!interactive || suspended || lockedRef.current || !readyRef.current) return;
      const scene = sceneRef.current;
      const box = sizeRef.current.width
        ? sizeRef.current
        : { width: scene?.clientWidth ?? 0, height: scene?.clientHeight ?? 0 };
      const anchor = regionAnchorBoxPoint(target, box.width, box.height, fitRef.current);
      const origin = point ?? anchor ?? { x: box.width / 2, y: box.height / 2 };
      if (staticMode) {
        // 关闭动效/素材降级：没有动画，让门口先准备目标再立即完成
        callbacksRef.current.onRegionRequest(target);
        finishedRef.current = true;
        callbacksRef.current.onRegionSettled(target);
        return;
      }
      callbacksRef.current.onRegionRequest(target);
      beginEnter(target, origin);
    },
    [beginEnter, interactive, staticMode, suspended],
  );

  const onRegionPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, target: RegionTarget) => {
      event.stopPropagation();
      // 关闭动效时没有揭幕这一步，画布一开始就是完整画面，区域直接可点
      if (stage !== 'entrance' && !staticMode) return;
      requestRegion(target, boxPoint(event.clientX, event.clientY));
    },
    [boxPoint, requestRegion, stage, staticMode],
  );

  const onRegionKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>, target: RegionTarget) => {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      event.preventDefault();
      requestRegion(target, null);
    },
    [requestRegion],
  );

  return (
    <div
      className="wd-scene"
      ref={sceneRef}
      data-wd-stage={stage}
      data-wd-fit={fit}
      data-wd-static={staticMode ? '1' : '0'}
      data-wd-revealed={revealedAt === null ? '0' : '1'}
      onPointerMove={onPointerMove}
      onPointerLeave={endPointer}
      onPointerCancel={endPointer}
      onPointerDown={onPointerDown}
    >
      <div className={'wd-plate' + (exiting ? ' wd-plate--exiting' : '')} ref={plateRef}>
        {!imageFailed && (
          <img
            className="wd-art"
            ref={artRef}
            src={artSrc}
            alt=""
            draggable={false}
            onError={() => {
              setImageFailed(true);
              callbacksRef.current.onUnavailable('image');
            }}
          />
        )}
        {!imageFailed && (
          <div className="wd-warm" aria-hidden="true" style={{ backgroundImage: 'url("' + artSrc + '")' }} />
        )}
        {!staticMode && !imageFailed && <canvas className="wd-cover" ref={coverRef} hidden={!coverVisible} />}
        {!staticMode && !imageFailed && <canvas className="wd-exit" ref={exitRef} hidden={!exiting} />}

        {!imageFailed && interactive && <EntranceLabels box={hintBox} fit={fit} enabled={regionTabbable && ready} onPointerDown={onRegionPointerDown} onKeyDown={onRegionKeyDown}/>}

        {!staticMode && !imageFailed && <EntrancePointer sceneRef={sceneRef} suspended={suspended || exiting}/>}
      </div>
    </div>
  );
});
