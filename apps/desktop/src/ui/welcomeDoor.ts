/**
 * 工单 10-R1「画布与墨滴」的门口逻辑层。
 *
 * 这里放三件与画面无关、但要可单测的事：
 * - 本次运行只走一次首轮揭幕（模块级会话标记，写入时机不在 render 里，见 App.tsx）；
 * - 进入流程状态机：一旦开始进入就不会回到开头，重复点击只进入一次；
 * - 动效开关（应用内设置 + 系统 prefers-reduced-motion）与转场时长。
 *
 * 画布、笔刷、墨滴的计算在 entranceCanvas.ts，入口画几何在 entranceArt.ts。
 */

export type DoorStage = 'cover' | 'entrance';

export const WELCOME_TIMING = {
  /** 首屏归位的时长与起始缩放（由 rAF 逐帧推进，保证有中间帧） */
  introMs: 1400,
  introScale: 1.05,
  /** 进入转场：区域揭幕 → 目标界面 */
  transitionMs: 420,
  /** 转场兜底：动画帧或快照丢了也不会把人关在门外 */
  fallbackMs: 1000,
  /** 门口文案淡入前的等待，避免初始帧闪一下 */
  revealDelayMs: 140,
} as const;

export type WelcomePhase = 'opening' | 'entering' | 'done';

export interface WelcomePhaseInput {
  /** 用户已经选定进入目标 */
  requested: boolean;
  /** 扩散动画结束、兜底计时器到期，或动画丢失兜底触发 */
  transitionSettled: boolean;
}

/**
 * 进入流程状态机：一旦进入 entering 就不会回到 opening，
 * 因此重复点击、快速连点都只触发一次进入。
 */
export function welcomePhase(input: WelcomePhaseInput): WelcomePhase {
  if (!input.requested) return 'opening';
  return input.transitionSettled ? 'done' : 'entering';
}

/** 现在能否真的开始进入流程（数据未就绪、已经开始、已经结束都返回 false） */
export function canStartEnter(phase: WelcomePhase, ready: boolean, locked = false): boolean {
  return ready && !locked && phase === 'opening';
}

/** 动效是否生效：应用内「动效」开关 + 系统 prefers-reduced-motion，任一关闭都要降级 */
export function shouldAnimate(motionEnabled: boolean, prefersReducedMotion: boolean): boolean {
  return motionEnabled && !prefersReducedMotion;
}

/** 进入转场时长：关闭动效时不做长转场，直接进入 */
export function transitionDuration(animate: boolean): number {
  return animate ? WELCOME_TIMING.transitionMs : 0;
}

/* ---------------- 本次运行只揭幕一次 ---------------- */

let welcomeShownThisSession = false;

/**
 * 本次运行是否还没展示过门口。
 * 只读、无副作用，因此可以安全地放在 useState 的惰性初始化里——
 * StrictMode 会重复调用初始化函数，这里不会把标记写脏。
 */
export function shouldShowWelcome(): boolean {
  return !welcomeShownThisSession;
}

/** 门口已经露出/已经进门后登记：之后重新挂载、切会话、换主题都不再展示 */
export function markWelcomeShown(): void {
  welcomeShownThisSession = true;
}

/** 仅供测试复位模块级标记 */
export function resetWelcomeSession(): void {
  welcomeShownThisSession = false;
}
