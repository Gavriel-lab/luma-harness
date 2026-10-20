import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Download, DoorOpen, Moon, PanelRightClose, PanelRightOpen, Sparkles, Sun, Sunrise, Wind, X, Home, Menu, Sliders } from 'lucide-react';
import { useAppStore } from './ui/useAppStore';
import { useModalFocus } from './ui/useModalFocus';
import { THEMES, themeById } from './ui/themes';
import { SideNav } from './components/SideNav';
import { ChatPanel } from './components/ChatPanel';
import { Workbench } from './components/Workbench';
import { RecoveryNotice, ConfirmDialog, type ConfirmRequest } from './components/Overlays';
import { MemberSettingsModal } from './components/MemberSettingsModal';
import { MemoryModal } from './components/MemoryModal';
import type { ThemeId } from './types';
import { sanitizeFontStyle } from './utils/customFont';
import { WelcomeDoor } from './components/WelcomeDoor';
import { markWelcomeShown, type DoorStage } from './ui/welcomeDoor';
import type { RegionTarget } from './ui/entranceArt';
import { DiaryLibrary } from './components/Diary/DiaryLibrary';
import { StudyRoom } from './components/Study/StudyRoom';
import { NavigationMenu } from './components/NavigationMenu';

const THEME_ICONS: Record<ThemeId, typeof Moon> = {
  fusion: Sparkles,
  day: Sunrise,
  night: Moon,
};

export default function App() {
  const store = useAppStore();
  const { data, dispatch } = store;
  const prefs = data.preferences;

  /**
   * 工单 10-R1：入口画（门口）只负责门口，进入后完全交回原有聊天界面。
   * - 首轮：stage = 'cover'，先看到盖着亚麻画布的浅色画布，落一滴水揭幕；
   * - 从板块回到入口画：stage = 'entrance'，直接看完整主画面，不重播揭幕；
   * - 「换张新画布」才会重新盖一张干净画布（bump canvasEpoch）。
   *
   * 修复 10-A：这里只做「读」，不写任何全局标记——
   * StrictMode 会重复调用惰性初始化函数，一旦在 render 里写标记，
   * 开发预览就会以为「已经展示过」而跳过门口。
   */
  const [doorStage, setDoorStage] = useState<DoorStage | null>(() => null);
  const [canvasEpoch, setCanvasEpoch] = useState(0);
  const doorOpen = doorStage !== null;

  // 门口真的挂上之后才登记本次运行：切会话、换主题都不会再挡住聊天。
  useEffect(() => {
    if (doorOpen) markWelcomeShown();
  }, [doorOpen]);

  useEffect(() => {
    const css = prefs.reading?.customFontStyle;
    if (!css) return;
    const element = document.createElement('style');
    element.id = 'xiaowu-custom-font';
    try { element.textContent = sanitizeFontStyle(css); } catch { return; }
    document.head.appendChild(element);
    return () => element.remove();
  }, [prefs.reading?.customFontStyle]);

  const [navOpen, setNavOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsAgentId, setSettingsAgentId] = useState<string | undefined>();
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [diaryOpen, setDiaryOpen] = useState(false);
  const [studyOpen, setStudyOpen] = useState(false);
  const [bgReady, setBgReady] = useState(false);
  const [tabHidden, setTabHidden] = useState(false);


  if (typeof window !== 'undefined') {
    (window as any).xiaowuDesktopStore = store;
  }

  const openSettings = (agentId?: string) => {
    setSettingsAgentId(agentId);
    setSettingsOpen(true);
  };

  /**
   * 主题切换：先把目标背景加载完，再切 data-theme，
   * 保证过渡期间文字对比稳定，不出现白底闪一下。
   */
  const [appliedTheme, setAppliedTheme] = useState<ThemeId>(prefs.theme);
  useEffect(() => {
    const target = data.preferences.theme;
    const img = new Image();
    const swap = () => {
      setAppliedTheme(target);
      setBgReady(true);
    };
    img.onload = swap;
    img.onerror = swap; // 背景缺失时也要切过去，不把界面锁死
    img.src = `${import.meta.env.BASE_URL}backgrounds/${themeById(target).background}`;
    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [data.preferences.theme]);

  // 后台标签页暂停装饰循环
  useEffect(() => {
    const onChange = () => setTabHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  // 工作桌在窄屏是抽屉：进页面时先收起，不要糊住整个聊天区
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 1180px)').matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1180px)');
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const firstRun = useRef(true);
  useEffect(() => {
    if (!firstRun.current) return;
    firstRun.current = false;
    if (window.matchMedia('(max-width: 1180px)').matches && data.workbenchOpen) {
      dispatch({ type: 'toggleWorkbench', open: false });
    }
  }, [data.workbenchOpen]);

  useEffect(() => {
    if (!navOpen && !(narrow && data.workbenchOpen)) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || confirm) return;
      setNavOpen(false);
      if (narrow) dispatch({ type: 'toggleWorkbench', open: false });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen, narrow, data.workbenchOpen, confirm, dispatch]);
  useModalFocus('.drawer', navOpen && !confirm);
  useModalFocus('.workbench', narrow && data.workbenchOpen && !navOpen && !confirm);

  const scenic = prefs.scenic;
  const shellRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    // 门口显示期间同样把背后界面标记为 inert：鼠标与键盘都不会误触到聊天，
    // 内容保持挂载，数据加载、保存与关闭握手都照常运行。
    shellRef.current?.toggleAttribute('inert', scenic || navOpen || !store.ready || doorOpen);
    // 顶栏不做整体 inert：窗口关闭/最小化等系统控件不受影响，误触由遮罩与下面的控件级隔离挡住。
    topbarRef.current?.toggleAttribute('inert', !store.ready);
  }, [scenic, navOpen, store.ready, doorOpen]);

  /**
   * 修复 10-B：关键提示（恢复 / 关闭受阻 / 保存失败 / 导出失败）优先于门口。
   * 只要这类提示还在，门口就整块让位，并且由提示接管键盘。
   */
  const criticalNotice = Boolean(
    (!store.closeBlockedReason && store.recovery) ||
      store.closeBlockedReason ||
      store.exportError ||
      store.persistError,
  );

  useEffect(() => {
    if (!criticalNotice) return;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      // 只有当焦点还在门口、body 或已失效区域时才主动接管，不打断正在用的对话框
      if (active && active !== document.body && (active.closest('.wd-door') || active.closest('.shell'))) {
        /* 门口或背后界面里的焦点：交给提示 */
      } else if (active && active !== document.body) {
        return;
      }
      const first = document.querySelector<HTMLElement>('.notice button:not([disabled])');
      first?.focus({ preventScroll: true });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [criticalNotice]);

  // 进入后把焦点还给实际可用的操作：成员选择抽屉 / 窄屏工作台抽屉优先，
  // 其余才是聊天输入框。必须等 inert 解除之后再聚焦：
  // inert 子树里的元素不可聚焦，抢在前面会把焦点丢回 body。
  const hadWelcome = useRef(false);
  useEffect(() => {
    if (doorOpen) {
      hadWelcome.current = true;
      return;
    }
    if (!hadWelcome.current) return;
    hadWelcome.current = false;
    const keyboard = document.documentElement.getAttribute('data-wd-keyboard') === '1';
    const focusFirstIn = (selector: string) => {
      const node = document.querySelector<HTMLElement>(
        selector + ' button:not([disabled]), ' + selector + ' [href], ' + selector + ' [tabindex]:not([tabindex="-1"])',
      );
      if (node instanceof HTMLElement) {
        node.focus({ preventScroll: true });
        return true;
      }
      return false;
    };
    // R2-2：无私聊时的成员选择、窄屏工作台抽屉——焦点归实际的选择操作，不被通用聊天聚焦拉走
    if (navOpen && focusFirstIn('.drawer')) return;
    if (narrow && data.workbenchOpen && focusFirstIn('.workbench')) return;
    const composer = document.getElementById('composer-input');
    if (composer instanceof HTMLElement) {
      composer.focus({ preventScroll: true });
      if (!keyboard) composer.setAttribute('data-focus-flat', '1');
      return;
    }
    const firstTopbarButton = topbarRef.current?.querySelector('button');
    if (!keyboard && firstTopbarButton instanceof HTMLElement) firstTopbarButton.focus({ preventScroll: true });
  }, [doorOpen, navOpen, narrow, data.workbenchOpen]);

  const lastDirectRef = useRef<string | null>(null);
  useEffect(() => {
    const current = data.conversations.find((c) => c.id === data.activeConversationId);
    if (current?.kind === 'direct') lastDirectRef.current = current.id;
  }, [data.activeConversationId, data.conversations]);

  /**
   * R2-2：把「目标准备」从「进入完成」里拆出来。
   * 准备发生在扩散开始之前（门口的退出层还完整盖着屏幕），底下先切到目标视图，
   * 揭出的第一批可见帧就对应目标；扩散结束（或有效兜底）后才卸载门口、交接焦点。
   * 全部走现有 dispatch，不刷新窗口、不重建 store：
   * - 小木屋 / 卧房 → 优先回到本次运行中上次使用的有效私聊；没有可用私聊时显示成员选择，不擅自新建会话；
   * - 花园 / 聊天客厅 → 按 kind 找现有 living-room 群聊；
   * - 木桌 / 工作台 → 打开原工作桌（窄窗口仍是原来的抽屉方式）。
   */
  const doorSnapshotRef = useRef<{
    conversationId: string | null;
    workbenchOpen: boolean;
    navOpen: boolean;
    diaryOpen: boolean;
    studyOpen: boolean;
  } | null>(null);

  const prepareDoorTarget = useCallback(
    (target: RegionTarget | null) => {
      if (!target) return;
      doorSnapshotRef.current = {
        conversationId: data.activeConversationId,
        workbenchOpen: data.workbenchOpen,
        navOpen,
        diaryOpen,
        studyOpen,
      };
      if (target === 'diary') {
        setDiaryOpen(true);
        return;
      }
      if (target === 'study') {
        setStudyOpen(true);
        return;
      }
      if (target === 'living-room') {
        const room = data.conversations.find((c) => c.kind === 'living-room');
        if (room) dispatch({ type: 'selectConversation', conversationId: room.id });
        return;
      }
      if (target === 'direct') {
        // 可用私聊 = 还存在、且成员没被移除
        const usable = data.conversations.filter(
          (c) => c.kind === 'direct' && !data.agents.find((agent) => agent.id === c.agentId)?.removed,
        );
        // 1) 本次运行中上次用过的有效私聊；2) 数据里最近说过话的私聊
        const sessionPick = lastDirectRef.current
          ? usable.find((c) => c.id === lastDirectRef.current)
          : undefined;
        const lastActivity = (id: string) =>
          data.messages.reduce((latest, message) => (message.conversationId === id ? Math.max(latest, message.createdAt) : latest), 0);
        const recentPick = [...usable].sort(
          (a, b) => lastActivity(b.id) - lastActivity(a.id) || b.createdAt - a.createdAt,
        )[0];
        const chosen = sessionPick ?? recentPick;
        // 一个可用私聊都没有时显示成员选择，不擅自给某人新建会话
        if (chosen) dispatch({ type: 'selectConversation', conversationId: chosen.id });
        else setNavOpen(true);
        return;
      }
      if (target === 'workbench') {
        dispatch({ type: 'toggleWorkbench', open: true });
      }
    },
    [data.agents, data.conversations, data.activeConversationId, data.workbenchOpen, data.messages, dispatch, navOpen, diaryOpen, studyOpen],
  );

  /** R2-3：进入被关键提示取消时，还原目标准备阶段改动的界面状态，由用户重新选择 */
  const cancelDoorTarget = useCallback(() => {
    const snapshot = doorSnapshotRef.current;
    doorSnapshotRef.current = null;
    if (!snapshot) return;
    if (snapshot.conversationId) dispatch({ type: 'selectConversation', conversationId: snapshot.conversationId });
    if (data.workbenchOpen !== snapshot.workbenchOpen) dispatch({ type: 'toggleWorkbench', open: snapshot.workbenchOpen });
    if (navOpen !== snapshot.navOpen) setNavOpen(snapshot.navOpen);
    if (diaryOpen !== snapshot.diaryOpen) setDiaryOpen(snapshot.diaryOpen);
    if (studyOpen !== snapshot.studyOpen) setStudyOpen(snapshot.studyOpen);
  }, [data.workbenchOpen, dispatch, navOpen, diaryOpen, studyOpen]);

  /** 进入完成（只提交一次）：会话与工作台已在准备阶段切好，这里只卸载门口、解锁交互 */
  const handleDoorEntered = useCallback(() => {
    doorSnapshotRef.current = null;
    setDoorStage(null);
  }, []);

  const saveBeforeDoorEntry = useCallback(async () => {
    // 静态入口也先让目标准备的 dispatch 完成渲染，再保存最新快照。
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    return store.flushSave ? store.flushSave() : true;
  }, [store.flushSave]);

  /**
   * R3-D：返回开门页的统一入口——顶部「小屋」品牌按钮与独立的门图标按钮共用。
   * 直接展示完整入口主画（entrance），不重播首轮盖布；不重建 store、不清会话草稿。
   * 关键提示接管期间不开门（提示优先，不借顶部按钮绕过 R2-3）；门口已经开着时不重复设置。
   */
  const returnToEntrance = useCallback(() => {
    if (doorOpen || criticalNotice) return;
    setDoorStage('entrance');
  }, [criticalNotice, doorOpen]);

  const rootClass = [
    'app',
    scenic ? 'is-scenic' : '',
    prefs.motion ? '' : 'motion-off',
    tabHidden ? 'tab-hidden' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const openConfirm = (req: ConfirmRequest) => setConfirm(req);

  return (
    <div className={rootClass} data-theme={appliedTheme}>
      <Ambient theme={appliedTheme} ready={bgReady} scenic={scenic} />

      <header className="topbar" ref={topbarRef}>
        <button className="btn btn--icon mobile-only" onClick={() => setNavOpen(true)} aria-label="打开导航">
          <Menu size={17} aria-hidden />
        </button>

        {/* R3-D：顶部品牌「小屋」整体可点——与门图标按钮共用同一个返回处理 */}
        <h1 className="topbar__brand">
          <button
            type="button"
            className="brand-home"
            onClick={returnToEntrance}
            disabled={doorOpen}
            title="返回开门页"
            aria-label="返回开门页（小屋）"
            data-testid="brand-home"
          >
            <Home size={17} aria-hidden /> 小屋
          </button>
        </h1>

        <span className="topbar__space" title={`当前空间：${data.activeConversationId}`}>
          空间 · {conversationLabel(data)}
        </span>

        <NavigationMenu disabled={doorOpen || criticalNotice || !store.ready} onNavigate={destination => {
          setNavOpen(false);
          setDiaryOpen(destination === 'diary');
          setStudyOpen(destination === 'study');
          if (scenic) dispatch({ type: 'setScenic', scenic: false });
          if (destination === 'workbench') dispatch({ type: 'toggleWorkbench', open: true });
          if (destination === 'entrance') returnToEntrance();
        }} />

        <div className="topbar__spacer" />

        <div className="topbar__group" role="group" aria-label="主题">
          {THEMES.map((t) => {
            const Icon = THEME_ICONS[t.id];
            return (
              <button
                key={t.id}
                className="btn btn--chip"
                aria-pressed={prefs.theme === t.id}
                onClick={() => store.setTheme(t.id)}
                title={t.note}
              >
                <Icon size={14} aria-hidden />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>

        <button
          className={`btn ${prefs.motion ? 'btn--on' : ''}`}
          aria-pressed={prefs.motion}
          aria-label={prefs.motion ? '动效开' : '动效关'}
          onClick={() => dispatch({ type: 'setMotion', motion: !prefs.motion })}
          title="环境呼吸与入场动效总开关"
        >
          <Wind size={15} aria-hidden />
          <span className="desktop-only">{prefs.motion ? '动效开' : '动效关'}</span>
        </button>

        <button
          className={`btn ${scenic ? 'btn--on' : ''}`}
          aria-pressed={scenic}
          onClick={() => dispatch({ type: 'setScenic', scenic: !scenic })}
          title="隐藏面板看画，草稿与会话都会保留"
        >
          <Sun size={15} aria-hidden />
          <span>{scenic ? '回到小屋' : '看风景'}</span>
        </button>

        {/* 回到入口画：与顶部「小屋」品牌按钮共用 returnToEntrance，不重播首轮揭幕 */}
        <button
          className="btn btn--icon"
          onClick={returnToEntrance}
          disabled={doorOpen}
          title="回到入口画（不重播揭幕）"
        >
          <DoorOpen size={16} aria-hidden />
          <span className="sr-only">回到入口画</span>
        </button>

        <button className="btn" onClick={()=>void (window.xiaowuDesktop as any)?.openLocalMobile?.()}>手机页面预览</button>
        <button className="btn btn--icon" onClick={() => openSettings()} title="成员与接口连接设置">
          <Sliders size={16} aria-hidden />
          <span className="sr-only">成员与接口连接设置</span>
        </button>

        <button className="btn btn--icon" onClick={() => void store.exportData()} title="导出本地数据 JSON">
          <Download size={16} aria-hidden />
          <span className="sr-only">导出本地数据</span>
        </button>

        <button
          className="btn btn--icon narrow-only"
          onClick={() => dispatch({ type: 'toggleWorkbench', open: !data.workbenchOpen })}
          aria-pressed={data.workbenchOpen}
          title={data.workbenchOpen ? '收起工作桌' : '展开工作桌'}
        >
          {data.workbenchOpen ? <PanelRightClose size={16} aria-hidden /> : <PanelRightOpen size={16} aria-hidden />}
          <span className="sr-only">{data.workbenchOpen ? '收起工作桌' : '展开工作桌'}</span>
        </button>

        <button
          className="btn btn--icon wide-only"
          onClick={() => dispatch({ type: 'toggleWorkbench', open: !data.workbenchOpen })}
          aria-pressed={data.workbenchOpen}
          title={data.workbenchOpen ? '收起工作桌' : '展开工作桌'}
        >
          {data.workbenchOpen ? <PanelRightClose size={16} aria-hidden /> : <PanelRightOpen size={16} aria-hidden />}
          <span className="sr-only">{data.workbenchOpen ? '收起工作桌' : '展开工作桌'}</span>
        </button>
      </header>

      <div className="shell" ref={shellRef}>
        {!navOpen && (
          <SideNav
            store={store}
            onRequestDelete={openConfirm}
            onOpenSettings={openSettings}
            onOpenDiary={() => setDiaryOpen(true)}
            onOpenStudy={() => setStudyOpen(true)}
          />
        )}

        <ChatPanel store={store} onOpenMemory={() => setMemoryOpen(true)} />

        {!navOpen && (
          <Workbench
            store={store}
            onRequestDelete={openConfirm}
            onCloseDrawer={() => dispatch({ type: 'toggleWorkbench', open: false })}
            modal={narrow && data.workbenchOpen}
          />
        )}
      </div>

      {navOpen && (
        <>
          <button className="scrim" aria-label="关闭导航" onClick={() => setNavOpen(false)} />
          <div className="drawer panel" role="dialog" aria-modal="true" aria-label="导航">
            <div className="panel__head">
              <p className="panel__title">小屋</p>
              <div className="topbar__spacer" />
              <button className="btn btn--icon" onClick={() => setNavOpen(false)} aria-label="关闭导航">
                <X size={16} aria-hidden />
              </button>
            </div>
            <SideNav
              store={store}
              onRequestDelete={openConfirm}
              onOpenSettings={openSettings}
              onOpenDiary={() => {
                setNavOpen(false);
                setDiaryOpen(true);
              }}
              onOpenStudy={() => {
                setNavOpen(false);
                setStudyOpen(true);
              }}
              embedded
            />
          </div>
        </>
      )}

      {/* 窄屏下工作桌是抽屉，点遮罩关闭 */}
      {narrow && !navOpen && data.workbenchOpen && (
        <button
          className="scrim"
          aria-label="关闭工作桌"
          style={{ zIndex: 44 }}
          onClick={() => dispatch({ type: 'toggleWorkbench', open: false })}
        />
      )}

      {scenic && (
        <div className="scenic-bar">
          <span className="scenic-bar__hint">看风景中 · 草稿和会话都还在</span>
          <button className="btn btn--primary" onClick={() => dispatch({ type: 'setScenic', scenic: false })}>
            <PanelRightOpen size={15} aria-hidden /> 回到小屋
          </button>
        </div>
      )}

      <RecoveryNotice
        recovery={store.closeBlockedReason ? null : store.recovery}
        backupUsable={store.backupUsable}
        persistError={store.persistError}
        onDismiss={store.dismissRecovery}
        onDiscard={store.discardAndStartBlank}
        onRestore={store.restoreFromBackup}
        onExport={() => void store.exportData()}
      />

      {store.closeBlockedReason && (
        <div className="notice" role="alertdialog" aria-label="关闭被拦下">
          <p className="notice__title">
            <AlertTriangle size={15} aria-hidden />
            窗口没有关闭：最后一次改动可能还没保存
          </p>
          <p className="notice__body">{store.closeBlockedReason}</p>
          <div className="notice__actions">
            <button className="btn" onClick={store.dismissCloseBlocked}>
              留在窗口继续编辑
            </button>
            <button className="btn" onClick={() => void store.exportData()}>
              导出本地数据
            </button>
            <button className="btn btn--danger" onClick={store.discardUnsavedAndClose}>
              放弃未保存内容并退出
            </button>
          </div>
        </div>
      )}

      {store.exportError && !store.closeBlockedReason && (
        <div className="notice" role="status">
          <p className="notice__title">
            <AlertTriangle size={15} aria-hidden />
            导出没有完成
          </p>
          <p className="notice__body">{store.exportError}</p>
          <div className="notice__actions">
            <button className="btn" onClick={() => void store.exportData()}>
              <Download size={14} aria-hidden /> 重试
            </button>
          </div>
        </div>
      )}

      {store.persistError && !store.recovery && !store.closeBlockedReason && !store.exportError && (
        <div className="notice" role="status">
          <p className="notice__title">本地保存失败</p>
          <p className="notice__body">当前改动只存在于这个标签页：{store.persistError}。请先导出数据。</p>
          <div className="notice__actions">
            <button className="btn" onClick={store.exportData}>
              <Download size={14} aria-hidden /> 导出本地数据
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        request={confirm}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          confirm?.onConfirm();
          setConfirm(null);
        }}
      />

      {settingsOpen && (
        <MemberSettingsModal
          store={store}
          initialAgentId={settingsAgentId}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {memoryOpen && (
        <MemoryModal
          store={store}
          conversationId={store.data.activeConversationId}
          onClose={() => setMemoryOpen(false)}
        />
      )}

      {diaryOpen && (
        <div className="fixed inset-0 z-40 bg-stone-900/40">
          <DiaryLibrary onBackToHome={() => setDiaryOpen(false)} />
        </div>
      )}

      {studyOpen && (
        <StudyRoom onBackToHome={() => setStudyOpen(false)} />
      )}

      {doorStage && (
        <WelcomeDoor
          ready={store.ready}
          motionEnabled={prefs.motion}
          stage={doorStage}
          suspended={criticalNotice}
          resetToken={canvasEpoch}
          onRevealed={() => setDoorStage('entrance')}
          onNewCanvas={() => {
            setCanvasEpoch((n) => n + 1);
            setDoorStage('cover');
          }}
          onPrepare={prepareDoorTarget}
          onEnterCancelled={cancelDoorTarget}
          beforeEntered={saveBeforeDoorEntry}
          onEntered={handleDoorEntered}
        />
      )}

      <p className="sr-only" aria-live="polite">
        {store.adapter.demo ? '当前为演示模式，未连接真实 AI 服务。' : ''}
      </p>
    </div>
  );
}

function Ambient({ theme, ready, scenic }: { theme: ThemeId; ready: boolean; scenic: boolean }) {
  const meta = themeById(theme);
  return (
    <div className="ambient" aria-hidden="true">
      <img
        key={theme}
        className={`ambient__img ${ready ? 'is-ready' : ''}`}
        src={`${import.meta.env.BASE_URL}backgrounds/${meta.background}`}
        style={
          {
            '--focus-desktop': meta.desktopFocus,
            '--focus-mobile': meta.mobileFocus,
          } as React.CSSProperties
        }
        alt=""
        draggable={false}
      />
      <div className="ambient__glow" style={{ opacity: scenic ? 0.28 : undefined }} />
      <div className="ambient__glow ambient__glow--2" />
      <div className="ambient__veil" />
    </div>
  );
}

function conversationLabel(data: ReturnType<typeof useAppStore>['data']): string {
  const c = data.conversations.find((x) => x.id === data.activeConversationId);
  return c ? c.title : '客厅';
}
