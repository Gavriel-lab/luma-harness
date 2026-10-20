/**
 * 工单 10-R1/R2：门口（画布 + 毛刷 + 墨滴揭幕 + 三个区域入口）。
 *
 * 分工：
 * - EntranceScene 负责画布、笔触、墨滴与热区命中（都在 rAF 里推进），并持有进入的唯一启动点；
 * - 本组件负责门口文案与键盘入口、关键提示让位、目标准备的通知，以及进入完成的提交；
 * - 会话选择、客厅群聊、工作台的真实接线在 App.tsx，本组件不做会话归属判断。
 *
 * R2 收口：
 * - 区域点击由场景直接以真实落点启动进入，这里只登记与准备，不回传第二个启动指令；
 * - 关键提示出现时：未完成的进入就地取消（登记状态复位、兜底计时器清掉、通知 App 还原目标），
 *   兜底计时器触发时先读实时提示状态，提示没处理完绝不提交进入。
 *
 * 本次运行只走一次首轮揭幕（见 ui/welcomeDoor.ts 的会话标记）。
 */
import { useCallback, useEffect, useRef, useState, type AnimationEvent } from 'react';
import { KeyRound, Loader2, Paintbrush, Sparkles } from 'lucide-react';
import './welcomeDoor.css';
import './entranceDesign.css';
import { EntranceScene, type EntranceSceneHandle } from './EntranceScene';
import { ENTRANCE_REGIONS, artSource, selectArtVariant, type RegionTarget } from '../ui/entranceArt';
import { getBeijingTime } from '../utils/timeBeijing';
import {
  WELCOME_TIMING,
  canStartEnter,
  shouldAnimate,
  transitionDuration,
  welcomePhase,
  type DoorStage,
} from '../ui/welcomeDoor';

/** 强制重渲染：用于监听系统动效偏好变化 */
function useForceRender(): () => void {
  const [, setTick] = useState(0);
  return useCallback(() => setTick((n) => n + 1), []);
}

/** 直接读实时读数，而不是依赖某个时刻的快照 */
function useReducedMotion(): boolean {
  const forceRender = useForceRender();
  const query =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
  const reduced = query ? query.matches : false;
  useEffect(() => {
    if (!query) return;
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', forceRender);
      return () => query.removeEventListener('change', forceRender);
    }
    query.addListener(forceRender);
    return () => query.removeListener(forceRender);
  }, [query, forceRender]);
  return reduced;
}

export interface WelcomeDoorProps {
  /** 数据是否已安全就绪（沿用原加载/恢复流程，就绪后入口才可用） */
  ready: boolean;
  /** 小屋现有的「动效」开关 */
  motionEnabled: boolean;
  /** 首轮揭幕（cover）还是直接看完整入口画（entrance） */
  stage: DoorStage;
  /** 关键提示（恢复 / 关闭受阻 / 保存失败 / 导出失败）存在时，门口让位 */
  suspended: boolean;
  /** 换张新画布的重播计数 */
  resetToken: number;
  /** 揭幕完成：门口升级为完整入口画 */
  onRevealed: () => void;
  /** 换张新画布 */
  onNewCanvas: () => void;
  /**
   * R2-2：进入开始时先把目标界面准备好（遮罩仍完整盖着，底下切到目标视图）。
   * target 为 null 表示通用「进来吧」，不改会话。
   */
  onPrepare: (target: RegionTarget | null) => void;
  /** R2-3：进入被关键提示取消时，还原目标准备阶段改动的界面状态 */
  onEnterCancelled: () => void;
  /** 快转场完成后，确认最新草稿与目标准备已落盘；失败提示会取消进入。 */
  beforeEntered?: () => Promise<boolean>;
  /** 进入完成（扩散结束或有效兜底后，只提交一次）：卸载门口、解锁交互、交接焦点 */
  onEntered: (target: RegionTarget | null) => void;
}

function PaintedWelcomeDoor({
  ready,
  stage,
  suspended,
  resetToken,
  onRevealed,
  onNewCanvas,
  onPrepare,
  onEnterCancelled,
  beforeEntered,
  onEntered,
}: WelcomeDoorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const enterRef = useRef<HTMLButtonElement>(null);
  const sceneRef = useRef<EntranceSceneHandle>(null);

  const prefersReducedMotion = useReducedMotion();
  const animate = shouldAnimate(true, prefersReducedMotion);
  const [imageFailed, setImageFailed] = useState(false);
  const [canvasFailed, setCanvasFailed] = useState(false);
  const [requested, setRequested] = useState(false);
  const [settled, setSettled] = useState(false);

  const staticMode = !animate || imageFailed || canvasFailed;
  const phase = welcomePhase({ requested, transitionSettled: settled });
  const fallbackRef = useRef(0);
  const enteredRef = useRef(false);
  const finishingRef = useRef<number | null>(null);
  const entryEpochRef = useRef(0);
  /** 实时读数：兜底计时器与取消逻辑都看它，不依赖某个时刻的闭包快照 */
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const requestedRef = useRef(requested);
  requestedRef.current = requested;

  // 按北京时间选整画：两版构图一致，热区共用同一套坐标
  const artSrc = artSource(import.meta.env.BASE_URL, selectArtVariant(getBeijingTime().hour));

  /* 门口期间：顶栏里的聊天控件标记 inert（窗口关闭等系统控件不受影响） */
  useEffect(() => {
    const topbar = document.querySelector('.topbar');
    const inertTargets = Array.from(topbar ? topbar.querySelectorAll(':scope > *') : []);
    for (const node of inertTargets) node.setAttribute('inert', '');
    return () => {
      for (const node of inertTargets) node.removeAttribute('inert');
    };
  }, []);

  /**
   * 键盘焦点约束：只在没有关键提示时生效。
   * 恢复、关闭受阻、保存失败这些提示出现时，门口必须整块让位——
   * 否则 Tab 会被一直拉回门口，提示根本没法用键盘操作。
   */
  useEffect(() => {
    if (suspended) return;
    const root = rootRef.current;
    if (!root) return;
    const focusables = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
      );
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      document.documentElement.setAttribute('data-wd-keyboard', '1');
      const list = focusables();
      if (list.length === 0) {
        event.preventDefault();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) return;
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !root.contains(current))) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && (current === last || !root.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [suspended]);

  /** 关键提示接管的期间，门口整块 inert：鼠标、键盘都到不了门口 */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.toggleAttribute('inert', suspended);
    if (suspended) root.setAttribute('aria-hidden', 'true');
    else root.removeAttribute('aria-hidden');
  }, [suspended]);

  useEffect(
    () => () => {
      if (fallbackRef.current) window.clearTimeout(fallbackRef.current);
    },
    [],
  );

  /**
   * R2-3：关键提示出现在进入途中时，取消这次进入——
   * 清掉兜底计时器、把登记状态复位回「还没选」，并通知 App 还原目标准备。
   * 场景层同步取消自己的动画与锁；之后由用户重新选择，不由旧计时器自动完成。
   */
  useEffect(() => {
    if (!suspended) return;
    if (fallbackRef.current) {
      window.clearTimeout(fallbackRef.current);
      fallbackRef.current = 0;
    }
    if (requestedRef.current && !enteredRef.current) {
      entryEpochRef.current += 1;
      requestedRef.current = false;
      setRequested(false);
      setSettled(false);
      onEnterCancelled();
    }
    // requestedRef 读实时值，这里只跟着 suspended 走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suspended, onEnterCancelled]);

  const handleSettled = useCallback(
    async (target: RegionTarget | null) => {
      // R2-3：提示接管期间，场景的收口与兜底都不算完成
      const epoch = entryEpochRef.current;
      if (suspendedRef.current || enteredRef.current || finishingRef.current === epoch) return;
      finishingRef.current = epoch;
      let saved = false;
      try {
        saved = beforeEntered ? await beforeEntered() : true;
      } catch {
        // 保存实现负责展示失败提示；失败时绝不提交进入。
      } finally {
        if (finishingRef.current === epoch) finishingRef.current = null;
      }
      // 保存回来时可能已经取消、甚至重新选择了另一个入口。
      if (!saved || epoch !== entryEpochRef.current || suspendedRef.current || !requestedRef.current) return;
      enteredRef.current = true;
      setSettled(true);
      if (fallbackRef.current) {
        window.clearTimeout(fallbackRef.current);
        fallbackRef.current = 0;
      }
      onEntered(target);
    },
    [beforeEntered, onEntered],
  );

  /** 兜底也走同一个保存确认，不能绕过提示或提交两次。 */
  const armFallback = useCallback(
    (target: RegionTarget | null) => {
      if (fallbackRef.current) window.clearTimeout(fallbackRef.current);
      fallbackRef.current = window.setTimeout(() => {
        fallbackRef.current = 0;
        void handleSettled(target);
      }, transitionDuration(animate) + WELCOME_TIMING.fallbackMs * 0.4);
    },
    [animate, handleSettled],
  );

  /**
   * 进入请求的两个来源统一走这里：
   * - 区域点击（fromScene）：场景已经以真实落点启动进入，这里只登记、准备目标、加兜底；
   * - 按钮入口（进来吧 / 文字兜底）：通用入口以中心启动，区域文字兜底直接完成。
   */
  const requestEnter = useCallback(
    (target: RegionTarget | null, fromScene = false) => {
      if (!canStartEnter(phase, ready, enteredRef.current)) return;
      entryEpochRef.current += 1;
      requestedRef.current = true;
      setRequested(true);
      // R2-2：遮罩还完整盖着的时候就准备目标界面，第一批揭出的帧就是目标
      onPrepare(target);
      if (staticMode) {
        handleSettled(target);
        return;
      }
      if (!fromScene) {
        // 按钮驱动的进入（进来吧 = null → 画面中心；区域文字兜底只在静态降级出现）
        sceneRef.current?.enter(target);
      }
      armFallback(target);
    },
    [armFallback, handleSettled, onPrepare, phase, ready, staticMode],
  );

  const onAnimationEnd = useCallback((event: AnimationEvent<HTMLDivElement>) => {
    // 只认转场自己的动画；门口其它淡入淡出会冒泡到根节点，不能当作进入完成
    if ((event.animationName || '') !== 'wd-ui-fade') return;
    setSettled(true);
  }, []);

  const rootClass = [
    'wd-door',
    staticMode ? 'wd-door--reduced' : 'wd-door--painted',
    requested ? 'wd-door--entering' : '',
    suspended ? 'wd-door--suspended' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const busy = requested || !ready;

  const hint =
    stage === 'entrance'
      ? '停在字上，听听这里的故事。'
      : staticMode
        ? '轻轻选一个入口，回家吧。'
        : '轻轻画一笔，家就在下面。';

  return (
    <div
      className={rootClass}
      data-phase={phase}
      data-stage={stage}
      data-wd-animate={animate ? '1' : '0'}
      data-wd-static={staticMode ? '1' : '0'}
      ref={rootRef}
      onAnimationEnd={onAnimationEnd}
      role="dialog"
      aria-modal="true"
      aria-label="欢迎回家"
    >
      <EntranceScene
        ref={sceneRef}
        stage={stage}
        animate={!staticMode}
        suspended={suspended}
        ready={ready}
        artSrc={artSrc}
        resetToken={resetToken}
        onRevealed={onRevealed}
        onRegionRequest={(target) => requestEnter(target, true)}
        onRegionSettled={handleSettled}
        onUnavailable={(reason) => {
          if (reason === 'image') setImageFailed(true);
          else setCanvasFailed(true);
        }}
      />

      <div className="wd-signature" aria-label="Owner × Coordinator"><span className="wd-signature-names">Owner × Coordinator</span><svg viewBox="0 0 126 12" aria-hidden="true"><path d="M4 6H46M80 6H122M49 6C56 -2 59 14 63 6C67 -2 70 14 77 6" strokeWidth=".7"/><path d="M61 6L63 3L65 6L63 9Z" fill="#b69a64" stroke="none"/></svg></div>
      <div className="wd-ui">
        <div className="wd-copy">
          <h1 className="wd-title">Welcome home.</h1>
          <p className="wd-hint" data-testid="welcome-hint">
            <span className="wd-hint__desktop">{hint}</span>
            <span className="wd-hint__touch">
              {stage === 'entrance' ? '点小木屋、花园或木桌进去。' : '轻轻点一下画面，落一滴水。'}
            </span>
          </p>

          <div className="wd-actions">
            <button
              ref={enterRef}
              type="button"
              className="wd-enter"
              onClick={() => requestEnter(null)}
              disabled={busy}
              aria-busy={busy}
              data-testid="welcome-enter"
            >
              <span className="wd-enter__glow" aria-hidden="true" />
              <span className="wd-enter__label">{requested ? '进来啦' : ready ? '进来吧' : '正在开门…'}</span>
              {ready ? (
                <KeyRound className="wd-enter__icon" size={17} aria-hidden />
              ) : (
                <Loader2 className="wd-enter__icon wd-enter__icon--spin" size={17} aria-hidden />
              )}
            </button>

            {stage === 'cover' && !staticMode && (
              <button
                type="button"
                className="wd-drop"
                data-testid="welcome-drop"
                onClick={() => sceneRef.current?.reveal()}
              >
                <Paintbrush size={15} aria-hidden /> 揭开画布
              </button>
            )}

            {stage === 'entrance' && (
              <button type="button" className="wd-drop" data-testid="welcome-new-canvas" onClick={onNewCanvas}>
                <Sparkles size={15} aria-hidden /> 重铺画布
              </button>
            )}
          </div>

          {/* 素材或画布不可用时的文字入口：不放任画面空白 */}
          {(imageFailed || canvasFailed) && (
            <div className="wd-entries" role="group" aria-label="入口">
              {ENTRANCE_REGIONS.map((region) => (
                <button
                  key={region.id}
                  type="button"
                  className="wd-entry"
                  data-testid={'welcome-entry-' + region.id}
                  onClick={() => requestEnter(region.target)}
                  disabled={!ready}
                >
                  <span className="wd-entry__label">{region.label}</span>
                  <span className="wd-entry__hint">{region.hint}</span>
                </button>
              ))}
            </div>
          )}

          <p className="wd-fallback-note" hidden={!(imageFailed || canvasFailed)}>
            主画面素材没加载出来，这里先用文字入口顶上。
          </p>
        </div>
      </div>
    </div>
  );
}

export function WelcomeDoor(props:React.ComponentProps<typeof PaintedWelcomeDoor>){
 return <div className="welcome-door" style={{background:'#fff',display:'grid',placeContent:'center',gap:12}}>
 <h1>Luma Harness</h1><p>选择工作入口</p>
 {(['direct','living-room','workbench','diary','study'] as const).map(target=><button key={target} className="btn" disabled={!props.ready} onClick={()=>{props.onPrepare(target);props.onEntered(target);}}>{({'direct':'聊天','living-room':'群聊',workbench:'工作台',diary:'日记',study:'书房'})[target]}</button>)}</div>;
}
