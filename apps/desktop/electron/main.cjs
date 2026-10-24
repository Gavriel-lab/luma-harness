'use strict';

try {
  const { setGlobalDispatcher, EnvHttpProxyAgent } = require('undici');
  setGlobalDispatcher(new EnvHttpProxyAgent());
} catch (e) {
  console.warn('[relay] EnvHttpProxyAgent setup warning:', e.message);
}

/**
 * 小屋 · Electron 主进程
 *
 * 安全基线（对齐 Electron 官方安全指南）：
 * - contextIsolation 开、sandbox 开、nodeIntegration 关、webSecurity 保持默认开；
 * - 生产用自定义 app 协议加载本机打包资源，限制在打包输出目录内，禁止任意文件访问与路径穿越；
 * - 拒绝非预期导航、新窗口与权限请求；
 * - preload 只暴露固定的存储/导出方法，不暴露 ipcRenderer / fs / shell；
 * - 每个 IPC 都验证：调用方是本窗口主 frame、来源可信、payload 结构与大小合法。
 */
const electron = require('electron');
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } =
  typeof electron === 'object' && electron !== null ? electron : {};

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { DataStore } = require('./dataStore.cjs');
const { BridgeBroker } = require('./bridgeBroker.cjs');
const { createModelForwarder } = require('./modelForwarder.cjs');
const { BridgeLauncher } = require('./bridgeLauncher.cjs');
const { CredentialsStore } = require('./credentialsStore.cjs');
const { ChatService } = require('./chatService.cjs');
const { MobileRpc, MobileRelay } = require('./mobileRelay.cjs');
const { DiaryService } = require('./diaryService.cjs');
const { StudyService } = require('./studyService.cjs');
const { AutonomyService } = require('./autonomyService.cjs');
const { LoungeService } = require('./loungeService.cjs');
const { MomentsService } = require('./momentsService.cjs');
const { XiaoduCompanionServer } = require('./xiaoduCompanion.cjs');
const { CodexService } = require('./codexService.cjs');
const { MemoryGatewayMemoryProvider } = require('./memoryGatewayProvider.cjs');
const { assembleAuthoritativeTurn, readMemoryById } = require('./memoryManager.cjs');
const { ExternalMemoryMemory } = require('./externalMemoryMemory.cjs');
const { CloudSyncSyncService } = require('./cloudSyncSyncService.cjs');
const {hasUserOrigin}=require('./codexExecutionPolicy.cjs');
const { AttachmentsStore, prepareAttachmentContext, applyAttachmentWire } = require('./attachmentsStore.cjs');


const APP_ID = 'dev.luma.harness';
if(app?.setName)app.setName('Luma Harness');
if(app?.setPath&&!process.argv.some(a=>a.startsWith('--user-data-dir=')))app.setPath('userData',path.join(app.getPath('appData'),'luma-harness')); 

/**
 * 隔离测试用的数据目录：允许用 --user-data-dir=<path> 指定本次运行的数据根目录。
 * 未传参数时行为与以前完全一致（使用 Electron 默认 userData）；
 * 必须在 app.whenReady() 之前设置，否则会晚于单实例锁与 DataStore 的初始化。
 */
function applyUserDataOverride() {
  const flag = '--user-data-dir=';
  const hit = process.argv.find((arg) => typeof arg === 'string' && arg.startsWith(flag));
  if (!hit || !app || typeof app.setPath !== 'function') return null;
  const value = hit.slice(flag.length).trim();
  if (!value) return null;
  const resolved = path.resolve(value);
  app.setPath('userData', resolved);
  return resolved;
}

const userDataOverride = applyUserDataOverride();

// 工单 2026-10-18（编辑助手）：记忆独立同步后台分流，关窗后继续同步
const isMemorySyncMode = typeof process !== 'undefined' && Array.isArray(process.argv) && process.argv.includes('--memory-sync');
if (isMemorySyncMode) {
  const baseUserData = userDataOverride || (app && typeof app.getPath === 'function' ? app.getPath('userData') : path.resolve(process.cwd()));
  const syncProfileDir = path.join(baseUserData, 'luma-memory-sync', 'profile');
  if (app && typeof app.setPath === 'function') {
    app.setPath('userData', syncProfileDir);
  }
  const { runMemorySyncDaemon } = require('./memorySyncDaemon.cjs');
  runMemorySyncDaemon({
    app,
    userDataDir: baseUserData,
  });
}

function applyRemoteDebuggingOverride() {
  const flag = '--remote-debugging-port=';
  const hit = process.argv.find((arg) => typeof arg === 'string' && arg.startsWith(flag));
  if (!hit || !app?.commandLine?.appendSwitch) return null;
  const port = hit.slice(flag.length).trim();
  if (port) {
    app.commandLine.appendSwitch('remote-debugging-port', port);
    app.commandLine.appendSwitch('remote-allow-origins', '*');
  }
  return port;
}
applyRemoteDebuggingOverride();
const isDev = !app?.isPackaged && process.env.XIAOWU_LOAD_DIST !== '1';
const DEV_ORIGIN = 'http://127.0.0.1:5183';
const DEV_URL = process.env.XIAOWU_DEV_URL ?? `${DEV_ORIGIN}/`;
const DIST_DIR = path.join(__dirname, '..', 'dist');
/**
 * 工单 18-编辑助手：本地数据容量策略
 * 适应真实多模态历史与合理增长余量；
 * 保持统一、明确、有限的保护边界，解决合法读入却无法保存的不变量。
 */
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024; // 64 MiB 本地状态保存上限
const MAX_RAW_BYTES = 128 * 1024 * 1024; // 128 MiB 为格式化导出、包装及原文备份保留余量
const CLOSE_HANDSHAKE_TIMEOUT = 4000;

if (protocol && protocol.registerSchemesAsPrivileged) {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

let mainWindow = null;
let store = null;
let externalMemoryMemory = null;
let localMobile = null;
let credentialsStore = null;
let chatService = null;
let codexService = null;
let memoryGatewayProvider = null;
let attachmentsStore = null;
let closeHandshake = null;
let bridgeBroker = null;
let bridgeLauncher = null;
let coordinatorCodexService = null;
let mobileRelay = null;
let diaryService = null;
let studyService = null;
let autonomyService = null;
let momentsService = null;
let loungeService = null;
let xiaoduCompanion = null;
let cloudSyncSyncService = null;
const deliveredMemoryReceipts = new Map();
const authorityMutationWaiters = new Map();
let authorityMutationQueue = Promise.resolve();
/** Trusted main-process callers only; the renderer applies this to its latest
 * reducer state and ACKs its existing DataStore save, preserving live chat. */
function requestAuthoritativeMutation(command) {
  const run=()=>new Promise(resolve=>{
    if(!mainWindow||mainWindow.isDestroyed()){resolve({ok:false,applied:false,reason:'小屋窗口未就绪'});return;}
    if(!['create-ticket','reject-review','ticket-origin-reported','approve-plan','user-accept-project','user-revise-project','patch-task','update-plan'].includes(command?.operation)&&!['mobile-chat','mobile-chat-events','companion-message','mobile-message-delete'].includes(command?.type)){resolve({ok:false,applied:false,reason:'不支持的权威写入'});return;}
    const mutationId='authority_'+require('node:crypto').randomUUID();
    const timer=setTimeout(()=>{authorityMutationWaiters.delete(mutationId);resolve({ok:false,applied:false,reason:'权威数据保存确认超时，请读取实际状态后重试'});},20000);
    authorityMutationWaiters.set(mutationId,{resolve,timer,command});
    mainWindow.webContents.send('authority:mutation',{mutationId,command});
  });
  const result=authorityMutationQueue.then(run,run);authorityMutationQueue=result.catch(()=>{});return result;
}

if (!isMemorySyncMode && app && app.requestSingleInstanceLock) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      if(process.env.LUMA_HEADLESS==='1')return;
    mainWindow.show();
      mainWindow.focus();
    });
  }
}

/**
 * R3-E：解析随包的窗口图标。
 * 打包运行：extraResources 把 build/icon.ico 复制到 resources/icons/xiaowu.ico；
 * 开发运行：回退 electron/icons/xiaowu.ico。找不到就返回 undefined，行为与以前一致。
 */
function resolveWindowIcon() {
  if (process.platform !== 'win32') return undefined;
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'icons', 'xiaowu.ico'));
  candidates.push(path.join(__dirname, 'icons', 'xiaowu.ico'));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: '小屋 · 试聊版',
    autoHideMenuBar: true,
    backgroundColor: '#14161c',
    show: false,
    // R3-E：窗口/任务栏图标随包携带（extraResources 复制到 resources/icons/xiaowu.ico）；
    // EXE 内嵌资源图标由 electron-builder 的 win.icon 资源编辑写入，三处统一用同一枚 LG。
    icon: resolveWindowIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  let shown = false;
  const doShow = () => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    mainWindow.show();
    mainWindow.focus();
  };

  mainWindow.once('ready-to-show', () => {
    doShow();
  });

  // Safety fallback: ensure window is visible even if ready-to-show is delayed or skipped
  const showFallbackTimer = setTimeout(() => {
    if (!shown) {
      console.warn('[main] ready-to-show timer fallback triggered; showing window');
      doShow();
    }
  }, 2500);
  showFallbackTimer.unref?.();

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error(`[main:did-fail-load] code: ${errorCode}, desc: ${errorDescription}, url: ${validatedURL}`);
    doShow();
  });
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error(`[main:render-process-gone] reason: ${details.reason}, exitCode: ${details.exitCode}`);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const allowedOrigin = isDev ? DEV_ORIGIN : 'app://bundle';
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(allowedOrigin)) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);

  if (isDev) {
    void mainWindow.loadURL(DEV_URL);
  } else {
    void mainWindow.loadURL('app://bundle/index.html');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    closeHandshake = null;
  });

  // 关闭握手：先让渲染器提交最新状态并等主进程确认落盘，再真正关闭。
  // 关键：握手期间必须一直 preventDefault，否则重复点击关闭会绕过等待直接放行。
  let closing = false;
  mainWindow.on('close', (event) => {
    if (closing) return; // 已确认落盘，正在走最后一步
    event.preventDefault();
    if (closeHandshake) return; // 已在握手中，重复触发不重发请求，但同样不放行
    void runCloseHandshake(mainWindow, () => {
      closing = true;
    });
  });
}

async function runCloseHandshake(win, markClosing) {
  if (!win || win.isDestroyed()) return;
  const requestId = `close_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const settled = new Promise((resolve) => {
    closeHandshake = { requestId, resolve };
  });

  win.webContents.send('app:close-request', requestId);

  const timeout = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), CLOSE_HANDSHAKE_TIMEOUT));
  const result = await Promise.race([settled, timeout]);
  closeHandshake = null;

  if (!win || win.isDestroyed()) return;

  if (result && result.ok === false) {
    // 渲染器报告没写成功：保留窗口，让用户决定，绝不静默丢内容
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send('app:close-failed', result.reason ?? '未保存的内容没有写入磁盘');
    return;
  }
  if (result && result.timedOut) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send('app:close-failed', '保存超时，最后一次改动可能没有落盘');
    return;
  }

  // 已确认落盘（或用户显式放弃未保存内容），放行关闭
  await store?.flush();
  if (typeof markClosing === 'function') markClosing();
  win.destroy();
}

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'bundle') return new Response('not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const target = path.resolve(DIST_DIR, rel);
    // 目录穿越防护：解析后必须仍在 dist 内
    if (target !== DIST_DIR && !target.startsWith(DIST_DIR + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }
    try {
      return await net.fetch(pathToFileURL(target).toString());
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

if (!isMemorySyncMode && app && app.whenReady) {
  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

    process.env.LUMA_WORKSPACE ||= path.join(app.getPath('userData'),'workspace');
    fs.mkdirSync(process.env.LUMA_WORKSPACE,{recursive:true});
    store = new DataStore(app.getPath('userData'),{memoryEngine:'manual'});
    // Recover derived records/outbox from preserved history before either device reads it.
    const existing = store.read();
    if (existing.ok) {
      const recovered = await store.modify(() => {});
      if (!recovered.ok) console.warn('[memory] 历史整理未保存:', recovered.reason);
    }
    externalMemoryMemory=new ExternalMemoryMemory({store,userData:app.getPath('userData')});
    void externalMemoryMemory.start().catch(error=>console.warn('[memory] ExternalMemory:',error.message));
    credentialsStore = new CredentialsStore(app.getPath('userData'));
    attachmentsStore = new AttachmentsStore(app.getPath('userData'), electron.nativeImage);
    chatService = new ChatService(credentialsStore);
    memoryGatewayProvider = new MemoryGatewayMemoryProvider(credentialsStore);
    codexService = new CodexService({usageFile:path.join(app.getPath('userData'),'luma-memory-engine','codex-usage.json')});

    if (!isDev) registerAppProtocol();

    bridgeBroker = new BridgeBroker({dir:path.join(app.getPath('userData'),'xiaowu-bridge'),getData:getAuthoritativeData,mutateTickets:requestAuthoritativeMutation,modelForwarder:createModelForwarder({getAuthoritativeData,credentialsStore}),notify:snapshot=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('bridge:changed',snapshot);},onContext:(job,packet)=>{
      if(job.kind==='chat') {
        const receipt = bridgeBroker.receipt(job,packet);
        deliveredMemoryReceipts.set(job.requestId,receipt);
        void cloudSyncSyncService?.enqueueReceipt(receipt);
        if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('chat:memory-receipt',{requestId:job.requestId,conversationId:job.conversationId,targetAgentId:job.agentId,receipt});
      }
    }});
    await bridgeBroker.start();
    bridgeLauncher = new BridgeLauncher({broker:bridgeBroker});
    bridgeBroker.launchExecutor = agentId => bridgeLauncher.launch(agentId);
    createWindow();
    const homeId = bridgeBroker?.data?.homeId || 'home_default';
    diaryService = new DiaryService({
      userDataDir: app.getPath('userData'),
      getData: getAuthoritativeData,
      startChat: startAuthoritativeChat,
      stopChat: stopAuthoritativeChat,
      isBusy: agentId => autonomyService?.isAway(agentId) || memberHasActiveChat(agentId),
    });

    momentsService = new MomentsService({
      userDataDir: app.getPath('userData'),
      getData: getAuthoritativeData,
      attachmentsStore
    });
    if (externalMemoryMemory) externalMemoryMemory.momentsService = momentsService;

    loungeService = new LoungeService({
      userDataDir: app.getPath('userData'),
      getData: getAuthoritativeData,
      startChat: startAuthoritativeChat,
      stopChat: stopAuthoritativeChat,
      publishMessage: async body => {
        if (bridgeBroker) return bridgeBroker.publishMessage(body);
        const livingConv = getAuthoritativeData()?.conversations?.find(c => c.kind === 'living-room' || c.id === 'conv_living_room');
        const convId = body.conversationId || livingConv?.id || 'conv_living_room';
        const msgId = 'msg_lounge_' + crypto.createHash('sha256').update(body.requestId).digest('hex').slice(0, 32);
        const message = {
          id: msgId,
          conversationId: convId,
          agentId: body.agentId,
          text: body.text,
          createdAt: Date.now(),
          status: 'sent',
          demo: false,
          requestId: body.requestId,
          sourceChannel: 'luma'
        };
        const res = await requestAuthoritativeMutation({ type: 'companion-message', message });
        return { ok: res?.ok, saved: res?.ok, messageId: msgId, conversationId: convId };
      },
      isBusy: agentId => autonomyService?.isAway(agentId) || diaryService?.isWriting(agentId) || memberHasActiveChat(agentId),
    });
    if (bridgeBroker) {
      bridgeBroker.onLivingRoomMessage = msg => loungeService?.onLivingRoomMessage(msg);
      bridgeBroker.attachCoordinatorReviewer({ startChat: startAuthoritativeChat, getData: getAuthoritativeData });
    }

    studyService = new StudyService({
      userDataDir: app.getPath('userData'),
      getData: getAuthoritativeData,
      startChat: startAuthoritativeChat,
      stopChat: stopAuthoritativeChat,
      isBusy: agentId => autonomyService?.isAway(agentId) || diaryService?.isWriting(agentId) || memberHasActiveChat(agentId),
    });

    autonomyService = new AutonomyService({
      userDataDir: app.getPath('userData'), getData: getAuthoritativeData,
      startChat: startAuthoritativeChat,
      stopChat: stopAuthoritativeChat,
      publish: message => requestAuthoritativeMutation({type:'companion-message',message}),
      momentsService,
      diaryService,
      studyService,
      loungeService,
      attachmentsStore,
      isBusy: agentId => diaryService?.isWriting(agentId) || memberHasActiveChat(agentId),
    });
    const mobileRpc = new MobileRpc({
      homeId,
      getData: getAuthoritativeData,
      getRegistrations: () => bridgeBroker?.data?.registrations || {},
      startChat: startAuthoritativeChat,
      validateChat: validateStartStreamParams,
      mutate: requestAuthoritativeMutation,
      attachmentsStore,
      store,
      getSyncService: () => cloudSyncSyncService,
      getMemoryEngine: () => externalMemoryMemory,
      diaryService,
      studyService,
      autonomyService,
      momentsService,
      bridgeBroker: () => bridgeBroker,
      notify: (channel,data) => { if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send(channel,data); },
    });
    autonomyService.resumeWaiting=async (params,messageId)=>{const run=await mobileRpc.launchReply(params,messageId);await run.completed;};
    autonomyService.start();
    if(process.env.LUMA_DISABLE_LOCAL_MOBILE!=='1'){
      const {startLocalMobile}=require('./localMobile.cjs');
      localMobile=await startLocalMobile({rpc:mobileRpc,dataDir:app.getPath('userData'),port:Number(process.env.LUMA_LOCAL_MOBILE_PORT||8787),
        assetsDir:app.isPackaged?path.join(process.resourcesPath,'mobile-app'):path.resolve(__dirname,'../../mobile/dist'),
        routeModule:app.isPackaged?path.join(process.resourcesPath,'mobile-gateway/mobile-api.mjs'):path.resolve(__dirname,'../../../services/gateway/mobile-api.mjs')});
    }
    mobileRelay = new MobileRelay({dir:path.join(app.getPath('userData'),'luma-relay'),homeId,rpc:mobileRpc});
    mobileRelay.start();

    xiaoduCompanion = new XiaoduCompanionServer({ rpc: mobileRpc, port: 58563 });
    if(process.env.LUMA_ENABLE_LOCAL_COMPANION==='1')xiaoduCompanion.start();

    cloudSyncSyncService = new CloudSyncSyncService({
      dataStore: store,
      credentialsStore,
      onStateChange: (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('cloudSync:sync-state', state);
        }
      },
    });
    void cloudSyncSyncService.init().catch((err) => {
      console.warn('[cloudSync] init failed:', err.message);
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  let shutdown = null, shutdownComplete = false;
  const closeServices = () => shutdown ||= (async () => {
    const timeout = new Promise(resolve => setTimeout(() => resolve("timeout"), 6000));
    const perform = (async () => {
      try { await externalMemoryMemory?.stop(); } catch (e) { console.error('[shutdown] ExternalMemory:',e.message); }
      try { await localMobile?.close(); } catch (e) { console.error('[shutdown] local mobile:',e.message); }
      try { await diaryService?.stop(); } catch (e) { console.error("[shutdown] diaryService:", e.message); }
      try { await autonomyService?.stop(); } catch (e) { console.error('[shutdown] autonomy:', e.message); }
      try { mobileRelay?.stop(); } catch (e) { console.error("[shutdown] mobileRelay:", e.message); }
      try { xiaoduCompanion?.stop(); } catch (e) { console.error("[shutdown] xiaoduCompanion:", e.message); }
      try { cloudSyncSyncService?.dispose(); } catch (e) { console.error("[shutdown] cloudSyncSyncService:", e.message); }
      try { await codexService?.dispose(); } catch (e) { console.error("[shutdown] codexService:", e.message); }
      try { await coordinatorCodexService?.dispose(); } catch (e) { console.error("[shutdown] coordinatorCodexService:", e.message); }
      try { await bridgeLauncher?.stop(); } catch (e) { console.error("[shutdown] bridgeLauncher:", e.message); }
      try { await bridgeBroker?.stop(); } catch (e) { console.error("[shutdown] bridgeBroker:", e.message); }
      try { await store?.flush(); } catch (e) { console.error("[shutdown] store:", e.message); }
      return "done";
    })();

    const result = await Promise.race([perform, timeout]);
    if (result === "timeout") {
      console.warn("[shutdown] Services disposal timed out after 6000ms; forcing final flush");
      try { await store?.flush(); } catch {}
    }
  })().finally(() => {
    shutdownComplete = true;
    app.quit();
    setTimeout(() => {
      process.exit(0);
    }, 1500).unref?.();
  });

  app.on("window-all-closed", () => {
    void closeServices();
  });
  app.on("before-quit", event => {
    if (shutdownComplete) return;
    event.preventDefault();
    void closeServices();
  });
}

function memberHasActiveChat(agentId) {
  const data = getAuthoritativeData();
  const conversation = data?.conversations?.find(c => c.kind === 'direct' && c.agentId === agentId);
  return !conversation || data.messages.some(m => m.conversationId === conversation.id &&
    (m.status === 'streaming' || m.agentId === 'agent_owner' && m.createdAt > Date.now() - 120000)) ||
    bridgeBroker?.data.jobs.some(j => j.agentId === agentId && !j.report && ['queued','doing','cancelling'].includes(j.state));
}

async function stopAuthoritativeChat(requestId) {
  const job = bridgeBroker?.data.jobs.find(j => j.kind === 'chat' && j.requestId === requestId && !j.report);
  if (job) bridgeBroker.cancel(job.jobId);
  if (coordinatorCodexService?.activeTurns.has(requestId)) await coordinatorCodexService.stopStream(requestId);
  if (codexService?.activeTurns.has(requestId)) await codexService.stopStream(requestId);
  chatService?.stopStream(requestId);
}

async function startAuthoritativeChat(params, sendEvent) {

    let authData = getAuthoritativeData();
    const val = validateStartStreamParams(params, authData);
    if (!val.ok) {
      console.error(`[main:start-stream REJECT] targetAgentId: ${params?.targetAgentId}, conversationId: ${params?.conversationId}, reason: ${val.reason}`);
      if (params?.requestId && params?.conversationId) {
        sendEvent('chat:stream-error', {
          requestId: params.requestId,
          conversationId: params.conversationId,
          error: `主进程参数校验拒绝: ${val.reason}`,
        });
      }
      return { ok: false, reason: val.reason };
    }

    if(autonomyService?.deferChat(params,sendEvent))return {ok:true,away:true};
    const semantic=await externalMemoryMemory?.prepare(params)||{memoryIds:[],messageIds:[]};
    authData=getAuthoritativeData();
    const refreshed=validateStartStreamParams(params,authData);
    if(!refreshed.ok)return {ok:false,reason:refreshed.reason};
    params={...params,semanticMemoryIds:semantic.memoryIds,semanticMessageIds:semantic.messageIds,
      externalMemoryContext:{...semantic}};
    if(bridgeBroker?.data.registrations[params.targetAgentId]?.chatEnabled){
      try {
        // The phone has no separate "connect client" button. Wake only the
        // already registered executor; launch() reuses its owned live wrapper.
        await bridgeLauncher.launch(params.targetAgentId);
        const reg=bridgeBroker.data.registrations[params.targetAgentId];
        let authorizedAttachments=[];
        if(attachmentsStore && reg?.workspace){
          const excluded=new Set(params.excludeMessageIds||[]);
          let currentMsg=authData?.messages?.find(m=>m.id===params.requestId||(m.requestId===params.requestId&&m.agentId==='agent_owner'));
          if(!currentMsg || !currentMsg.attachments?.length){
            currentMsg=authData?.messages?.slice().reverse().find(m=>m.conversationId===params.conversationId && m.agentId==='agent_owner' && Array.isArray(m.attachments) && m.attachments.length>0 && (excluded.has(m.id) || Date.now() - (m.createdAt || 0) < 120000));
          }
          const atts=(Array.isArray(params.attachments) && params.attachments.length) ? params.attachments : (currentMsg?.attachments || []);
          if(Array.isArray(atts)&&atts.length>0){
            const attDir=path.join(reg.workspace,'.attachments');
            fs.mkdirSync(attDir,{recursive:true});
            for(const att of atts){
              try {
                const res=attachmentsStore.resolve(att.id);
                if(res.kind==='image'){
                  const targetExt=path.extname(res.imagePath)||'.jpg';
                  const targetFile=path.join(attDir,`${att.id}${targetExt}`);
                  fs.copyFileSync(res.imagePath,targetFile);
                  authorizedAttachments.push({
                    id:att.id,
                    name:att.name,
                    relativePath:`.attachments/${att.id}${targetExt}`,
                    absolutePath:targetFile,
                  });
                }
              }catch(e){}
            }
          }
        }
        const turn=bridgeBroker.chat({...params,...(authorizedAttachments.length?{authorizedAttachments}:{})});
        const job=bridgeBroker.data.jobs.find(j=>j.jobId===turn.jobId);
        const initialReceipt = bridgeBroker.receipt(job,turn.packet,'prepared');
        deliveredMemoryReceipts.set(params.requestId,initialReceipt);
        const finishReceipt = status => {
          const receipt = {...(deliveredMemoryReceipts.get(params.requestId) || initialReceipt),status,completedAtMs:Date.now()};
          if(status==='completed')void externalMemoryMemory?.delivered(params,receipt);
          deliveredMemoryReceipts.delete(params.requestId);
          void cloudSyncSyncService?.enqueueReceipt(receipt);
          sendEvent('chat:memory-receipt',{requestId:params.requestId,conversationId:params.conversationId,targetAgentId:params.targetAgentId,receipt});
        };
        sendEvent('chat:memory-receipt',{requestId:params.requestId,conversationId:params.conversationId,targetAgentId:params.targetAgentId,receipt:initialReceipt});
        void turn.promise.then(text=>{
          finishReceipt('completed');
          if(sendEvent){
            sendEvent('chat:stream-chunk',{requestId:params.requestId,conversationId:params.conversationId,delta:text});
            sendEvent('chat:stream-done',{requestId:params.requestId,conversationId:params.conversationId});
          }
        }).catch(e=>{
          if(sendEvent){
            const cancelled=job.state==='cancelled'||job.report?.outcome==='cancelled';
            finishReceipt(cancelled?'cancelled':'failed');
            sendEvent(cancelled?'chat:stream-stopped':'chat:stream-error',{requestId:params.requestId,conversationId:params.conversationId,...(cancelled?{}:{error:e.message}),reason:job.invalidated?'context-invalidated':'user'});
          }
        });
        return {ok:true};
      }catch(e){return {ok:false,reason:e.message};}
    }
    // 权威 Profile 注入：确保无论渲染端传什么，关键连接参数以权威存储为准
    const targetAgent = Array.isArray(authData?.agents) ? authData.agents.find((a) => a.id === params.targetAgentId) : null;
    const authProfile = Array.isArray(authData?.chatProfiles) && targetAgent?.profileId
      ? authData.chatProfiles.find((p) => p.id === targetAgent.profileId)
      : null;

    // 权威确定该成员专属直连私聊会话
    const targetDirectConv = Array.isArray(authData?.conversations)
      ? authData.conversations.find((c) => c.kind === 'direct' && c.agentId === params.targetAgentId)
      : null;

    // 工单 08-R2：主进程权威组装。渲染进程只提供本轮文本/目标/会话/重试边界，
    // 资料、人格、预算与来源收据全部在这里从权威存储生成，随后才有 wire。
    let prepared;
    try {
      prepared = attachmentsStore ? prepareAttachmentContext(authData, params, attachmentsStore) : { data: authData, currentText: params.currentText, currentFiles: [] };
    } catch (error) {
      return { ok: false, reason: `附件未能发送：${error.message}` };
    }
    const assembled = assembleAuthoritativeTurn(prepared.data, {
      requestId: params.requestId,
      conversationId: params.conversationId,
      targetAgentId: params.targetAgentId,
      currentText: prepared.currentText,
      cutoffTime: params.cutoffTime,
      extraMemoryGatewayMemories: params.extraMemoryGatewayMemories,
      excludeMessageIds: params.excludeMessageIds,
      semanticMemoryIds: params.semanticMemoryIds,
      semanticMessageIds: params.semanticMessageIds,
      externalMemoryContext: params.externalMemoryContext,
    });
    const attachmentWire = assembled.ok && attachmentsStore ? applyAttachmentWire(assembled, authData, prepared, attachmentsStore) : { apiMessages: assembled.apiMessages, imageInputs: [], attachmentSources: [] };
    if (attachmentWire.attachmentSources.length) assembled.receipt.attachmentSources = attachmentWire.attachmentSources;

    // 来源收据先于流式结果送达渲染端（含失败收据），渲染端只展示，不得自造
    if (sendEvent) {
      sendEvent('chat:memory-receipt', {
        requestId: params.requestId,
        conversationId: params.conversationId,
        targetAgentId: params.targetAgentId,
        // 工单 08-R4：Codex 收据关联权威 canonical thread（实际绑定确定后再补正）
        ...(assembled.protocol === 'codex' && assembled.canonicalThreadId ? { threadId: assembled.canonicalThreadId } : {}),
        receipt: assembled.receipt,
        updatedCheckpoints: assembled.updatedCheckpoints,
      });
      if (cloudSyncSyncService && assembled.receipt) {
        void cloudSyncSyncService.enqueueReceipt(assembled.receipt);
      }
    }

    if (!assembled.ok) {
      console.error(`[main:start-stream ASSEMBLE-REJECT] targetAgentId: ${params.targetAgentId}, conversationId: ${params.conversationId}, reason: ${assembled.reason}`);
      if (sendEvent) {
        sendEvent('chat:stream-error', {
          requestId: params.requestId,
          conversationId: params.conversationId,
          error: assembled.reason,
        });
      }
      return { ok: false, reason: assembled.reason };
    }

    // 权威判定 canonical thread：仅允许从权威存储的 targetAgent.canonicalCodexThreadId 或 targetDirectConv.codexThreadId 获取
    // 严禁回退到客厅共享 conv.codexThreadId！严禁信任渲染端传入的 canonicalCodexThreadId / codexThreadId
    const canonicalThreadId = targetAgent?.canonicalCodexThreadId
      || targetDirectConv?.codexThreadId
      || null;

    // 权威 developerInstructions / wire 消息：以权威组装结果为准（渲染端不参与内容决策）
    const authoritativeInstructions = assembled.protocol === 'codex'
      ? assembled.developerInstructions
      : '';

    const safeProfile = authProfile ? {
      ...authProfile,
      ...params.profile,
      id: authProfile.id,
      providerType: authProfile.providerType,
      baseUrl: authProfile.baseUrl,
      model: authProfile.model || params.profile?.model,
      credentialRef: authProfile.credentialRef || `cred_${params.targetAgentId}`,
      codexModel: authProfile.codexModel || authProfile.model || params.profile?.codexModel,
      codexCwd: authProfile.codexCwd || params.profile?.codexCwd,
      canonicalCodexThreadId: canonicalThreadId || undefined,
      codexThreadId: canonicalThreadId || undefined,
      developerInstructions: authoritativeInstructions,
    } : {
      ...(params.profile || {}),
      canonicalCodexThreadId: canonicalThreadId || undefined,
      codexThreadId: canonicalThreadId || undefined,
      developerInstructions: authoritativeInstructions,
    };

    const safeParams = {
      ...params,
      profile: safeProfile,
      // 权威 wire：API 为完整消息列表；Codex 为单轮 turn 文本（thread 自身维护历史）
      messages: assembled.protocol === 'codex'
        ? [{ role: 'user', content: assembled.codexTurnText }]
        : attachmentWire.apiMessages,
      imageInputs: attachmentWire.imageInputs,
      currentText: params.currentText,
    };

    const updateReceiptOnStreamEvent = (channel, data) => {
      if (!assembled.receipt) return;
      if (channel === 'chat:stream-done') {
        void externalMemoryMemory?.delivered(params,assembled.receipt);
        const usedChars = typeof data?.accumulatedText === 'string'
          ? data.accumulatedText.length
          : assembled.receipt.usedChars;
        void cloudSyncSyncService?.enqueueReceipt({
          ...assembled.receipt,
          status: 'completed',
          usedChars,
          completedAtMs: Date.now(),
        });
      } else if (channel === 'chat:stream-stopped') {
        void cloudSyncSyncService?.enqueueReceipt({
          ...assembled.receipt,
          status: 'cancelled',
          completedAtMs: Date.now(),
        });
      } else if (channel === 'chat:stream-error') {
        void cloudSyncSyncService?.enqueueReceipt({
          ...assembled.receipt,
          status: 'failed',
          error: data?.error || '流式异常',
          completedAtMs: Date.now(),
        });
      }
    };

    if (safeProfile?.providerType === 'codex-app-server') {
      if (!codexService) return { ok: false, reason: 'Codex CLI 服务未就绪' };
      let selectedCodex=codexService;
      if(params.targetAgentId==='agent_coordinator'){
        bridgeBroker.issueCoordinator();
        // Do not rotate a live coordinator token beneath an existing MCP server.
        if(!coordinatorCodexService){
          const development=path.join(__dirname,'..','connectors','coordinator.mjs');
          coordinatorCodexService=new CodexService({allowLocalOperations:true,writableRoots:[process.env.LUMA_WORKSPACE],forkOnWriterConflict:true,usageFile:path.join(app.getPath('userData'),'luma-memory-engine','codex-usage.json'),mcpWorkbench:{command:process.execPath,script:fs.existsSync(development)?development:path.join(process.resourcesPath,'connectors','coordinator.mjs'),manifest:bridgeBroker.sessions.get('coordinator').manifestPath}});
        }
        selectedCodex=coordinatorCodexService;
      }
      void selectedCodex.startStream({
        ...safeParams,
        localOperations:hasUserOrigin(params,authData),
        threadId: canonicalThreadId,
        onContinuityRequired:()=>externalMemoryMemory.continuity(params),
        onThreadBound: async (newThreadId, instructionSources) => {
          if (!newThreadId) return { ok: false, reason: '未收到有效的 threadId' };
          const nowIso = new Date().toISOString();
          try {
            const bindRes = await store.bindThread(
              params.conversationId,
              safeProfile?.id,
              newThreadId,
              instructionSources,
              nowIso,
              params.targetAgentId,
            );
            if (!bindRes.ok || !bindRes.applied) {
              console.error('[main] 持久化 thread 绑定失败:', bindRes.reason);
              return { ok: false, reason: bindRes.reason || '权威存储拒绝绑定' };
            }
            if (assembled.receipt) assembled.receipt.threadId = newThreadId;
          } catch (e) {
            console.error('[main] 写入 thread 绑定异常:', e);
            return { ok: false, reason: e.message };
          }

          if (newThreadId) {
            sendEvent('codex:thread-bound', {
              conversationId: params.conversationId,
              threadId: newThreadId,
              canonicalThreadId: newThreadId,
              agentId: params.targetAgentId,
              instructionSources,
              profileId: safeProfile?.id,
              verifiedAt: nowIso,
            });
            sendEvent('chat:memory-receipt', {
              requestId: params.requestId,
              conversationId: params.conversationId,
              targetAgentId: params.targetAgentId,
              threadId: newThreadId,
              receipt: { ...assembled.receipt, threadId: newThreadId },
              updatedCheckpoints: [],
            });
          }
          return { ok: true };
        },
      }, (channel, data) => {
        updateReceiptOnStreamEvent(channel, data);
        if (sendEvent) {
          sendEvent(channel, data);
        }
      }).catch(async (err) => {
        console.error('[main] codexService.startStream 未捕获异常:', err);
        const errMsg = err?.message || String(err);
        updateReceiptOnStreamEvent('chat:stream-error', { error: errMsg });
        if (errMsg && (errMsg.includes('恢复失败') || errMsg.includes('专属会话恢复') || errMsg.includes('RESUME') || errMsg.includes('验证') || errMsg.includes('failure') || errMsg.includes('FAILURE'))) {
          try {
            await store.recordVerificationFailure(params.conversationId, safeProfile?.id, errMsg, undefined, params.targetAgentId);
          } catch (recErr) {
            console.error('[main] 记录验证失败异常:', recErr);
          }
        }
        if (sendEvent) {
          sendEvent('chat:stream-error', {
            requestId: params.requestId,
            conversationId: params.conversationId,
            error: `Codex 桥接错误: ${errMsg}`,
          });
        }
      });
      return { ok: true };
    }

    if (!chatService) return { ok: false, reason: '聊天传输服务未就绪' };

    void chatService.startStream(safeParams, (channel, data) => {
      updateReceiptOnStreamEvent(channel, data);
      if (sendEvent) {
        sendEvent(channel, data);
      }
    }).catch((err) => {
      console.error('[main] startStream 未捕获异常:', err);
      const errMsg = err?.message || '真实聊天服务异常';
      updateReceiptOnStreamEvent('chat:stream-error', { error: errMsg });
      if (sendEvent) {
        sendEvent('chat:stream-error', {
          requestId: params.requestId,
          conversationId: params.conversationId,
          error: errMsg,
        });
      }
    });

    return { ok: true };

}

/* ============================ IPC ============================ */

/** 校验调用方：必须是本窗口主 frame，且来源是本应用自身 */
function senderOk(event) {
  const wc = mainWindow && mainWindow.webContents;
  if (!wc || event.sender !== wc) return false;
  const frame = event.senderFrame;
  if (frame && frame.parent !== null) return false; // 子 frame 一律拒绝
  let url = '';
  try {
    url = frame ? frame.url : event.sender.getURL();
  } catch {
    return false;
  }
  return isDev ? url.startsWith(DEV_ORIGIN) : url.startsWith('app://bundle');
}

function reject() {
  return { ok: false, applied: false, reason: '调用方不被信任' };
}

function tooBig(payload, max) {
  return typeof payload === 'string' && Buffer.byteLength(payload, 'utf8') > max;
}

if (ipcMain) {
  ipcMain.on('authority:mutation-ack',(event,result)=>{
    if(!senderOk(event))return;
    const waiter=authorityMutationWaiters.get(result?.mutationId);if(!waiter)return;
    authorityMutationWaiters.delete(result.mutationId);clearTimeout(waiter.timer);
    waiter.resolve({ok:result.ok===true,applied:result.applied===true,reason:typeof result.reason==='string'?result.reason:undefined});
    if (result.ok && waiter.command?.type === 'companion-message') {
      const msg = waiter.command.message;
      if (msg && (msg.conversationId === 'conv_living_room' || msg.conversationId?.includes('living'))) {
        void loungeService?.onLivingRoomMessage(msg);
      }
    }
  });
  ipcMain.on('authority:ready', (event) => {
    if (!senderOk(event)) return;
    void bridgeBroker?.recoverPendingHandoffs?.();
  });
  ipcMain.handle('authority:ready', async (event) => {
    if (!senderOk(event)) return reject();
    return bridgeBroker ? await bridgeBroker.recoverPendingHandoffs() : { checked: 0, recovered: 0 };
  });
  for(const operation of ['snapshot','register','dispatch','cancel','accept','chat-route','launch','resume','dispatch-channel','approve-plan','user-accept','user-revise','schedule-work','ready']) {
    ipcMain.handle('bridge:'+operation,async(event,payload)=>{
      if(!senderOk(event)||!bridgeBroker)return reject();
      try {
        if(operation==='snapshot')return bridgeBroker.snapshot();
        if(operation==='ready')return await bridgeBroker.recoverPendingHandoffs();
        if(operation==='register'){
          const selected=await dialog.showOpenDialog(mainWindow,{title:'批准此成员的工作目录',properties:['openDirectory']});
          if(selected.canceled)return {ok:false,reason:'已取消登记'};
          return bridgeBroker.register({agentId:payload?.agentId,executorId:payload?.executorId,workspace:selected.filePaths[0]});
        }
        if(operation==='dispatch')return bridgeBroker.dispatch(payload||{});
        if(operation==='cancel')return bridgeBroker.cancel(payload?.jobId);
        if(operation==='accept')return bridgeBroker.accept(payload?.jobId);
        if(operation==='approve-plan')return await bridgeBroker.approvePlan({ticketId:payload?.ticketId,planVersion:payload?.planVersion,explicit:true});
        if(operation==='user-accept')return await bridgeBroker.userAcceptProject({ticketId:payload?.ticketId,feedback:payload?.feedback,explicit:true});
        if(operation==='user-revise')return await bridgeBroker.userReviseProject({ticketId:payload?.ticketId,feedback:payload?.feedback,explicit:true});
        if(operation==='schedule-work')return bridgeBroker.scheduleCoordinatorWork(payload?.ticketId);
        if(operation==='chat-route')return bridgeBroker.enableChat(payload?.agentId,payload?.enabled);
        if(operation==='launch')return await bridgeLauncher.launch(payload?.agentId);
        if(operation==='dispatch-channel')return bridgeBroker.setDispatchChannelEnabled(payload?.enabled);
        if(operation==='resume'){
          const job=bridgeBroker.data.jobs.find(j=>j.jobId===payload?.jobId);
          if(payload?.confirmed!==true||!job)return {ok:false,reason:'需要确认旧客户端已停止'};
          await bridgeLauncher.stop(job.agentId);
          const resumed=bridgeBroker.resume(job.jobId,true);
          await bridgeLauncher.launch(job.agentId);return resumed;
        }
      }catch(e){return {ok:false,reason:e.message};}
    });
  }
  ipcMain.handle('public:open-mobile',async event=>{if(!senderOk(event)||!localMobile)return {ok:false};await shell.openExternal(localMobile.url);return {ok:true};});
  ipcMain.handle('data:load', (event) => {
    if (!senderOk(event)) return { ok: false, state: 'unreadable', raw: null, reason: '调用方不被信任' };
    return store.read();
  });

  ipcMain.handle('session:begin', (event, sessionId) => {
    if (!senderOk(event)) return { ok: false };
    return store.beginSession(sessionId);
  });

ipcMain.handle('data:save', async (event, payload, revision, sessionId) => {
  if (!senderOk(event)) return reject();
  if (typeof payload !== 'string') return { ok: false, applied: false, reason: '数据格式不正确' };
  if (tooBig(payload, MAX_PAYLOAD_BYTES)) {
    return { ok: false, applied: false, reason: '数据体积超出上限，已拒绝写入' };
  }
  const result = await store.save(payload, Number.isInteger(revision) ? revision : undefined, sessionId);
  if (result?.ok && result?.applied) {
    void bridgeBroker?.recoverPendingHandoffs?.();
  }
  return result;
});

ipcMain.handle('data:backup-raw', (event, raw) => {
  if (!senderOk(event)) return { ok: false, applied: false, reason: '调用方不被信任' };
  if (typeof raw !== 'string') return { ok: false, applied: false, reason: '原文格式不正确' };
  if (tooBig(raw, MAX_RAW_BYTES)) return { ok: false, applied: false, reason: '原文体积超出上限' };
  return store.backupRaw(raw);
});

ipcMain.handle('data:read-backup', (event) => {
  if (!senderOk(event)) return { ok: false, usable: false, reason: '调用方不被信任' };
  return store.readBackup();
});

ipcMain.handle('data:restore-backup', async (event, sessionId, revision) => {
  if (!senderOk(event)) return { ok: false, applied: false, reason: '调用方不被信任' };
  return store.restoreBackupToPrimary(sessionId, Number.isInteger(revision) ? revision : undefined);
});

ipcMain.handle('data:paths', (event) => {
  if (!senderOk(event)) return null;
  return store.paths();
});

/** 正常导出：系统另存为对话框。取消不写文件、不报错；成功只在真正写盘后成立。 */
ipcMain.handle('data:export', async (event, payload) => {
  if (!senderOk(event)) return { ok: false, applied: false, reason: '调用方不被信任' };
  if (!payload || typeof payload.content !== 'string') return { ok: false, applied: false, reason: '导出内容不正确' };
  if (tooBig(payload.content, MAX_RAW_BYTES)) return { ok: false, applied: false, reason: '导出内容过大' };
  if (typeof payload.suggestedName !== 'string' || !/^[\w一-龥.-]+\.json$/.test(payload.suggestedName)) {
    return { ok: false, applied: false, reason: '文件名不合法' };
  }

  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出小屋本地数据',
    defaultPath: payload.suggestedName,
    filters: [{ name: 'JSON 文件', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { ok: true, applied: false, canceled: true };

  const temp = `${result.filePath}.part`;
  try {
    // 先写同目录临时文件再替换，避免半截文件
    await fsp.writeFile(temp, payload.content, 'utf8');
    await fsp.rename(temp, result.filePath);
    return { ok: true, applied: true, canceled: false, filePath: result.filePath };
  } catch (e) {
    try { await fsp.rm(temp, { force: true }); } catch { /* 忽略 */ }
    return { ok: false, applied: false, reason: `导出失败：${e && e.message}` };
  }
});

/** 渲染器报告最新状态已提交（或用户显式放弃） */
ipcMain.on('app:close-ack', (event, result) => {
  if (!senderOk(event)) return;
  if (!closeHandshake) return;
  const { resolve, requestId } = closeHandshake;
  if (!result || result.requestId !== requestId) return;
  resolve({ ok: result.ok !== false, reason: result.reason });
});

/** 只用于用户点击明确的放弃退出按钮；不提交新的草稿。 */
ipcMain.handle('app:discard-and-close', async (event, decision) => {
  if (!senderOk(event)) return reject();
  if (decision?.confirmed !== true) return { ok: false, reason: '尚未确认放弃未保存内容' };
  if (closeHandshake) return { ok: false, reason: '保存仍在进行，请稍后重试' };
  const win = mainWindow;
  await store?.flush(); // 等待已经提交的写入，避免关闭到一半中断文件操作
  if (!win || win.isDestroyed()) return { ok: false, reason: '窗口已关闭' };
  win.destroy();
  return { ok: true };
});

function validateCredentialRef(ref, authData) {
  if (!ref || typeof ref !== 'string' || ref.length > 64) {
    return { ok: false, reason: '凭据引用不合法' };
  }
  if (!authData) {
    return { ok: false, reason: '权威存储未就绪或已损坏，已拦截请求' };
  }
  if (ref === 'cred_memoryGateway') return { ok: true };
  const agents = Array.isArray(authData.agents) ? authData.agents : [];
  const matched = agents.some((a) => `cred_${a.id}` === ref);
  if (!matched) {
    return { ok: false, reason: `安全拦截：凭据引用 ${ref} 未绑定任何权威成员` };
  }
  return { ok: true };
}

/* ---------------------- 凭据管理 IPC ---------------------- */

ipcMain.handle('credentials:is-available', (event) => {
  if (!senderOk(event)) return false;
  return credentialsStore ? credentialsStore.isAvailable() : false;
});

ipcMain.handle('credentials:set', async (event, payload) => {
  if (!senderOk(event)) return reject();
  if (!credentialsStore) return { ok: false, reason: '凭据存储模块尚未就绪' };
  const authData = getAuthoritativeData();
  const v = validateCredentialRef(payload?.ref, authData);
  if (!v.ok) return { ok: false, reason: v.reason };
  return credentialsStore.setKey(payload?.ref, payload?.key);
});

ipcMain.handle('credentials:delete', async (event, payload) => {
  if (!senderOk(event)) return reject();
  if (!credentialsStore) return { ok: false, reason: '凭据存储模块尚未就绪' };
  const authData = getAuthoritativeData();
  const v = validateCredentialRef(payload?.ref, authData);
  if (!v.ok) return { ok: false, reason: v.reason };
  return credentialsStore.deleteKey(payload?.ref);
});

ipcMain.handle('credentials:has', (event, payload) => {
  if (!senderOk(event)) return false;
  if (!credentialsStore) return false;
  const authData = getAuthoritativeData();
  const v = validateCredentialRef(payload?.ref, authData);
  if (!v.ok) return false;
  return credentialsStore.hasKey(payload?.ref);
});

}

function validateChatProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    return { ok: false, reason: '缺少有效配置信息 (profile)' };
  }
  if (!profile.id || typeof profile.id !== 'string' || profile.id.length > 64) {
    return { ok: false, reason: 'profile.id 不合法' };
  }
  // Codex app-server 使用本机 stdio 协议，不需要外部 baseUrl 或 API 密钥
  if (profile.providerType === 'codex-app-server') {
    return { ok: true };
  }
  if (!profile.baseUrl || typeof profile.baseUrl !== 'string' || profile.baseUrl.length > 512) {
    return { ok: false, reason: 'profile.baseUrl 不合法' };
  }
  if (!profile.model || typeof profile.model !== 'string' || !profile.model.trim() || profile.model.length > 128) {
    return { ok: false, reason: 'profile.model 必须填写且不超过 128 字符' };
  }
  if (profile.credentialRef && (typeof profile.credentialRef !== 'string' || !/^[a-zA-Z0-9_\-:]{1,64}$/.test(profile.credentialRef))) {
    return { ok: false, reason: 'credentialRef 格式不合法或含有非法字符' };
  }
  return { ok: true };
}

function validateStartStreamParams(params, authData) {
  if (!params || typeof params !== 'object') {
    return { ok: false, reason: '请求参数无效' };
  }
  if (!params.requestId || typeof params.requestId !== 'string' || params.requestId.length > 128) {
    return { ok: false, reason: 'requestId 不合法' };
  }
  if (!params.conversationId || typeof params.conversationId !== 'string' || params.conversationId.length > 128) {
    return { ok: false, reason: 'conversationId 不合法' };
  }
  if (!params.targetAgentId || typeof params.targetAgentId !== 'string' || params.targetAgentId.length > 64) {
    return { ok: false, reason: 'targetAgentId 必须有效指定' };
  }

  // 权威存储交叉核验：缺失或损坏直接拒绝，绝不 fallback（先于一切渲染端内容检查）
  if (!authData) {
    return { ok: false, reason: '权威存储未就绪或已损坏，已拦截请求' };
  }

  // 工单 08-R2：渲染进程只提交本轮文本、目标成员、会话与请求/重试边界。
  // 系统历史、来源表与收据一律由主进程从权威存储组装，渲染进程提交的 messages 通道直接拒绝。
  if (Array.isArray(params.messages) && params.messages.length > 0) {
    return {
      ok: false,
      reason: '安全拦截：渲染进程不得提交上下文消息列表 (messages)，上下文与资料只能由主进程从权威存储组装',
    };
  }
  if (params.currentText !== undefined && (typeof params.currentText !== 'string' || params.currentText.length > 32000)) {
    return { ok: false, reason: '本轮输入不合法或超过安全上限 (32000 字符)' };
  }
  if (params.cutoffTime !== undefined && params.cutoffTime !== null && (typeof params.cutoffTime !== 'number' || !Number.isFinite(params.cutoffTime))) {
    return { ok: false, reason: 'cutoffTime 重试边界不合法' };
  }
  if (params.extraMemoryGatewayMemories !== undefined && (!Array.isArray(params.extraMemoryGatewayMemories) || params.extraMemoryGatewayMemories.length > 10)) {
    return { ok: false, reason: '外部记忆召回参数不合法' };
  }
  if (params.excludeMessageIds !== undefined && (!Array.isArray(params.excludeMessageIds) || params.excludeMessageIds.length > 10 || !params.excludeMessageIds.every((x) => typeof x === 'string' && x.length <= 128))) {
    return { ok: false, reason: '本轮消息排除参数不合法' };
  }
  if (params.injectedSources !== undefined || params.developerInstructions !== undefined) {
    return {
      ok: false,
      reason: '安全拦截：渲染进程不得提交来源收据或开发者指令，这些只能由主进程权威生成',
    };
  }

  // 1. 成员合法性检查与配置绑定检查
  const targetAgent = Array.isArray(authData.agents) ? authData.agents.find((a) => a.id === params.targetAgentId) : null;
  if (!targetAgent) {
    return { ok: false, reason: `权威存储中未找到成员 ${params.targetAgentId}` };
  }
  if (targetAgent.removed) {
    return { ok: false, reason: '该成员已从小屋移除，请先恢复成员。' };
  }
  if (!targetAgent.profileId) {
    return { ok: false, reason: `成员 ${params.targetAgentId} 未绑定服务配置，禁止调用` };
  }

  // 2. 会话归属检查
  const conv = Array.isArray(authData.conversations) ? authData.conversations.find((c) => c.id === params.conversationId) : null;
  if (!conv) {
    return { ok: false, reason: `会话 ${params.conversationId} 未注册或不存在` };
  }
  if (conv.kind === 'direct' && conv.agentId !== params.targetAgentId) {
    return { ok: false, reason: `会话 ${params.conversationId} 属于成员 ${conv.agentId}，禁止成员 ${params.targetAgentId} 发起流式回复` };
  }

  // 3. 配置真实性：必须与已保存的 Profile 一致
  const authProfile = Array.isArray(authData.chatProfiles)
    ? authData.chatProfiles.find((p) => p.id === targetAgent.profileId)
    : null;
  if (!authProfile) {
    return { ok: false, reason: `成员绑定的配置 ${targetAgent.profileId} 不存在` };
  }

  const isCodex = authProfile.providerType === 'codex-app-server';

  // 严格核查受信凭据绑定：严禁跨 agent 借用或伪造 credentialRef
  const expectedCredRef = `cred_${params.targetAgentId}`;
  if (params.profile?.credentialRef && params.profile.credentialRef !== expectedCredRef) {
    return {
      ok: false,
      reason: `凭据受信边界拦截：成员 ${params.targetAgentId} 只能使用自身绑定的凭据引用 (${expectedCredRef})，禁止借用 ${params.profile.credentialRef}`,
    };
  }

  if (!isCodex) {
    if (params.profile?.baseUrl && authProfile.baseUrl && params.profile.baseUrl !== authProfile.baseUrl) {
      return { ok: false, reason: '安全拦截：传入的 baseUrl 与主进程权威保存的配置不一致' };
    }
    if (params.profile?.credentialRef && authProfile.credentialRef && params.profile.credentialRef !== authProfile.credentialRef) {
      return { ok: false, reason: '安全拦截：传入的 credentialRef 与主进程权威保存的配置不一致' };
    }
  }

  // 工单 08-R2：资料授权不再做文本扫描——上下文完全由主进程按来源 owner/scope/版本从权威存储组装，
  // 渲染进程没有可注入历史/收据的通道，因此无需（也不能）用关键词规则判定"泄漏"。
  // 工单 08-R3：新接口允许渲染端不携带 profile 快照，此时校验权威存储中的配置本身。
  return validateChatProfile(params.profile ?? authProfile);
}


function validateTestConnection(profile, authData) {
  const val = validateChatProfile(profile);
  if (!val.ok) {
    return { ok: false, error: `参数校验拒绝: ${val.reason}` };
  }

  // 1. 权威存储交叉核验：无论任何类型（包含 Codex），权威缺失或损坏时一律直接拒绝，网络出站严格为 0
  if (!authData) {
    return { ok: false, error: '权威存储未就绪或已损坏，已拦截请求' };
  }

  // 2. 查找是否为权威存储中已注册的合法 Profile
  const authProfile = Array.isArray(authData.chatProfiles)
    ? authData.chatProfiles.find((p) => p.id === profile.id)
    : null;

  if (authProfile) {
    // 2.1 针对已注册 Profile
    if (profile?.providerType === 'codex-app-server' || authProfile.providerType === 'codex-app-server') {
      if (profile.providerType !== authProfile.providerType) {
        return { ok: false, error: '安全拦截：配置类型与权威注册配置不一致' };
      }
      return { ok: true };
    }

    // 凭据绑定核验：禁止借用其他成员凭据或篡改凭据引用
    if (profile.credentialRef && authProfile.credentialRef && profile.credentialRef !== authProfile.credentialRef) {
      return { ok: false, error: `安全拦截：配置 ${profile.id} 已绑定凭据 ${authProfile.credentialRef}，禁止借用 ${profile.credentialRef}` };
    }

    // 端点核验：禁止篡改已注册配置的 baseUrl 探测 localhost 或未授信外部地址
    if (profile.baseUrl && authProfile.baseUrl && profile.baseUrl !== authProfile.baseUrl) {
      return { ok: false, error: `安全拦截：传入的 baseUrl 与主进程权威保存的配置不一致，禁止探测未授信端点` };
    }

    return { ok: true };
  }

  // 3. 针对首次配置草稿 (未保存过 Profile)
  // 必须关联权威成员，且凭据引用必须合法绑定自身
  const agentId = profile.agentId || (profile.id && profile.id.startsWith('profile_agent_') ? profile.id.replace('profile_', '') : null);
  const targetAgent = agentId && Array.isArray(authData.agents) ? authData.agents.find((a) => a.id === agentId) : null;

  if (!targetAgent) {
    return { ok: false, error: `安全拦截：配置 ${profile.id} 未在权威配置中注册，且未关联有效合法成员` };
  }

  // 凭据引用必须严格与该成员自身绑定
  const expectedCredRef = `cred_${targetAgent.id}`;
  if (profile.credentialRef && profile.credentialRef !== expectedCredRef) {
    return {
      ok: false,
      error: `凭据受信拦截：成员 ${targetAgent.id} 只能使用自身的凭据引用 (${expectedCredRef})，禁止借用 ${profile.credentialRef}`,
    };
  }

  return { ok: true };
}

function validateMemoryGatewayRecall(params, authData) {
  if (!authData) {
    return { ok: false, error: '权威存储未就绪或已损坏，已拦截请求' };
  }

  const authConfig = authData.memoryGatewayConfig;
  if (!authConfig || !authConfig.enabled || !authConfig.baseUrl) {
    return { ok: false, error: 'MemoryGateway 云端服务当前未激活' };
  }

  const conversationId = params?.conversationId;
  if (!conversationId || typeof conversationId !== 'string') {
    return { ok: false, error: '安全拦截：缺少有效 conversationId，禁止跨会话或无会话请求记忆' };
  }

  const conv = Array.isArray(authData.conversations)
    ? authData.conversations.find((c) => c.id === conversationId)
    : null;
  if (!conv) {
    return { ok: false, error: `未注册会话 ${conversationId}` };
  }

  let allowedNamespace = '';
  if (conv.kind === 'direct') {
    if (!conv.agentId) return { ok: false, error: '私聊会话未绑定成员' };
    const cleanId = conv.agentId.replace(/^agent_/, '').replace(/_/g, '');
    allowedNamespace = `xiaowu-direct-${cleanId}`;
  } else if (conv.kind === 'living-room') {
    allowedNamespace = 'xiaowu-living-room';
  } else {
    return { ok: false, error: '未知会话类型' };
  }

  const requestedNamespace = params?.namespace;
  if (!requestedNamespace || requestedNamespace !== allowedNamespace) {
    return {
      ok: false,
      error: `空间隔离拦截：会话 ${conversationId} 仅授权访问 ${allowedNamespace}，禁止访问 ${requestedNamespace}`,
    };
  }

  return { ok: true, allowedNamespace, authConfig };
}

function validateMemoryGatewaySearch(params, authData) {
  if (!authData) {
    return { ok: false, error: '权威存储未就绪或已损坏，已拦截请求' };
  }

  const authConfig = authData.memoryGatewayConfig;
  if (!authConfig || !authConfig.enabled || !authConfig.baseUrl) {
    return { ok: false, error: 'MemoryGateway 云端服务当前未激活' };
  }

  const conversationId = params?.conversationId;
  if (!conversationId || typeof conversationId !== 'string') {
    return { ok: false, error: '安全拦截：缺少有效 conversationId，禁止跨会话或无会话检索记忆' };
  }

  const conv = Array.isArray(authData.conversations)
    ? authData.conversations.find((c) => c.id === conversationId)
    : null;
  if (!conv) {
    return { ok: false, error: `安全拦截：未注册会话 ${conversationId}` };
  }

  let allowedNamespace = '';
  if (conv.kind === 'direct') {
    if (!conv.agentId) return { ok: false, error: '私聊会话未绑定成员' };
    const cleanId = conv.agentId.replace(/^agent_/, '').replace(/_/g, '');
    allowedNamespace = `xiaowu-direct-${cleanId}`;
  } else if (conv.kind === 'living-room') {
    allowedNamespace = 'xiaowu-living-room';
  } else {
    return { ok: false, error: '未知会话类型' };
  }

  // 检查请求的命名空间：必须与该会话授权的空间严格一致，禁止检索未授权空间
  let requestedList = [];
  if (Array.isArray(params?.namespaces)) {
    requestedList = params.namespaces;
  } else if (typeof params?.namespace === 'string') {
    requestedList = [params.namespace];
  }

  if (requestedList.length === 0) {
    requestedList = [allowedNamespace];
  } else {
    for (const ns of requestedList) {
      if (ns !== allowedNamespace) {
        return {
          ok: false,
          error: `空间隔离拦截：会话 ${conversationId} 仅授权检索 ${allowedNamespace}，禁止检索 ${ns}`,
        };
      }
    }
  }

  return { ok: true, allowedNamespace, authConfig };
}

function validateMemoryGatewayIngest(params, authData) {
  if (!authData) {
    return { ok: false, error: '权威存储未就绪或已损坏，已拦截请求' };
  }

  const authConfig = authData.memoryGatewayConfig;
  if (!authConfig || !authConfig.enabled || !authConfig.baseUrl) {
    return { ok: false, error: 'MemoryGateway 云端服务当前未激活' };
  }

  const conversationId = params?.conversationId;
  if (!conversationId || typeof conversationId !== 'string') {
    return { ok: false, error: '安全拦截：缺少有效 conversationId，禁止跨会话或无会话摄入记忆' };
  }

  const conv = Array.isArray(authData.conversations)
    ? authData.conversations.find((c) => c.id === conversationId)
    : null;
  if (!conv) {
    return { ok: false, error: `未注册会话 ${conversationId}` };
  }

  let allowedNamespace = '';
  if (conv.kind === 'direct') {
    if (!conv.agentId) return { ok: false, error: '私聊会话未绑定成员' };
    const cleanId = conv.agentId.replace(/^agent_/, '').replace(/_/g, '');
    allowedNamespace = `xiaowu-direct-${cleanId}`;
  } else if (conv.kind === 'living-room') {
    allowedNamespace = 'xiaowu-living-room';
  } else {
    return { ok: false, error: '未知会话类型' };
  }

  const requestedNamespace = params?.namespace;
  if (!requestedNamespace || requestedNamespace !== allowedNamespace) {
    return {
      ok: false,
      error: `空间隔离拦截：会话 ${conversationId} 仅授权摄入 ${allowedNamespace}，禁止写入 ${requestedNamespace}`,
    };
  }

  return { ok: true, allowedNamespace, authConfig };
}

function getAuthoritativeData() {
  if (!store) return null;
  const res = store.read();
  if (res && res.ok && res.state === 'ok' && typeof res.raw === 'string') {
    try {
      return JSON.parse(res.raw);
    } catch {
      return null;
    }
  }
  return null;
}

if (ipcMain) {
  ipcMain.handle('attachments:import', async (event, input) => {
    if (!senderOk(event) || !attachmentsStore) return reject();
    try { return { ok: true, attachment: await attachmentsStore.importFile(input) }; }
    catch (error) { return { ok: false, reason: error.message }; }
  });
  ipcMain.handle('attachments:preview', async (event, params) => {
    if (!senderOk(event) || !attachmentsStore) return reject();
    try { return { ok: true, ...attachmentsStore.preview(params?.id, params?.full === true) }; }
    catch (error) { return { ok: false, reason: error.message }; }
  });
  ipcMain.handle('attachments:export', async (event, id) => {
    if (!senderOk(event) || !attachmentsStore) return reject();
    try {
      const file = attachmentsStore.resolve(id);
      const chosen = await dialog.showSaveDialog(mainWindow, { title: '保存附件副本', defaultPath: file.name });
      if (chosen.canceled || !chosen.filePath) return { ok: true, canceled: true };
      await fsp.writeFile(chosen.filePath, file.bytes);
      return { ok: true };
    } catch (error) { return { ok: false, reason: error.message }; }
  });
  ipcMain.handle('autonomy:presence', event => senderOk(event)?{running:autonomyService?.active?.agentId||null}:{running:null});
  ipcMain.handle('chat:start-stream', async (event, params) => {
    if (!senderOk(event)) return reject();
    return startAuthoritativeChat(params, (channel,data)=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send(channel,data);});
  });

  ipcMain.handle('chat:stop-stream', async (event, payload) => {
    if (!senderOk(event)) return reject();
    if (!payload?.requestId || typeof payload.requestId !== 'string') return { ok: false, reason: '缺少合法 requestId' };
    const bridgeJob=bridgeBroker?.data.jobs.find(j=>j.kind==='chat'&&j.requestId===payload.requestId);
    if(bridgeJob && !bridgeJob.report){
      const result=bridgeBroker.cancel(bridgeJob.jobId);
      // Cancellation is only confirmed by the executor report; do not emit stopped early.
      return {...result,unconfirmed:bridgeJob.state==='cancelling',error:bridgeJob.state==='cancelling'?'已请求停止，等待客户端确认':undefined};
    }
    let stopRes = { ok: true };
    if(coordinatorCodexService?.activeTurns.has(payload.requestId))return coordinatorCodexService.stopStream(payload.requestId);
    if (codexService) {
      const res = await codexService.stopStream(payload.requestId);
      if (res && res.ok === false) {
        stopRes = res;
      }
    }
    if (chatService) {
      chatService.stopStream(payload.requestId);
    }
    return stopRes;
  });

  ipcMain.handle('chat:test-connection', async (event, profile) => {
    if (!senderOk(event)) return { success: false, error: '调用方不被信任' };

    const authData = getAuthoritativeData();
    const val = validateTestConnection(profile, authData);
    if (!val.ok) {
      return { success: false, error: val.error };
    }

    if (profile?.providerType === 'codex-app-server') {
      if (!codexService) return { success: false, error: 'Codex CLI 服务未就绪' };
      return codexService.testConnection(profile);
    }

    if (!chatService) return { success: false, error: '聊天服务未就绪' };
    return chatService.testConnection(profile);
  });

  ipcMain.handle('codex:list-models', async (event) => {
    if (!senderOk(event)) return [];
    const authData = getAuthoritativeData();
    if (!authData) return [];
    if (!codexService) return [];
    try {
      return await codexService.listModels();
    } catch {
      return [];
    }
  });

  ipcMain.handle('models:fetch', async (event, params) => {
    if (!senderOk(event)) return { ok: false, success: false, error: '调用方不被信任' };

    const authData = getAuthoritativeData();
    if (!authData) {
      return { ok: false, success: false, error: '权威存储未就绪或已损坏，已拦截请求' };
    }

    const { agentId, profileId } = params || {};
    if (!agentId) {
      return { ok: false, success: false, error: '缺少合法 agentId' };
    }

    // 1. 查找权威成员
    const targetAgent = Array.isArray(authData.agents) ? authData.agents.find((a) => a.id === agentId) : null;
    if (!targetAgent) {
      return { ok: false, success: false, error: `安全拦截：未找到权威成员 ${agentId}` };
    }

    // 严格验证传入 profileId 是否与成员自身绑定的 profileId 一致，严禁跨成员越权借用凭据
    if (profileId && targetAgent.profileId && profileId !== targetAgent.profileId) {
      return {
        ok: false,
        success: false,
        error: `安全拦截：跨成员借用配置已拒绝 (成员绑定: ${targetAgent.profileId}, 请求: ${profileId})`,
      };
    }

    const effectiveProfileId = targetAgent.profileId;
    if (!effectiveProfileId) {
      return { ok: false, success: false, error: `安全拦截：成员 ${agentId} 尚未绑定任何连接配置，请先保存配置草稿再拉取模型` };
    }

    // 2. 查找已保存的权威 Profile
    const authProfile = Array.isArray(authData.chatProfiles)
      ? authData.chatProfiles.find((p) => p.id === effectiveProfileId)
      : null;

    if (!authProfile) {
      return { ok: false, success: false, error: `安全拦截：未找到已保存的配置 ${effectiveProfileId}，请先保存配置与凭据再拉取模型` };
    }

    // 3. Codex CLI (严格核验配置 providerType，不借名字绕过)
    const isCodex = authProfile.providerType === 'codex-app-server' || authProfile.provider === 'codex-app-server';
    if (isCodex) {
      if (!codexService) return { ok: false, success: false, error: 'Codex CLI 服务未就绪' };
      try {
        const models = await codexService.listModels();
        const list = models.map((m) => ({
          id: m.id,
          name: m.displayName || m.id,
          description: '本机 Codex CLI 官方模型',
          isDefault: !!m.isDefault,
          provider: 'codex-app-server',
        }));
        return { ok: true, success: true, models: list, count: list.length };
      } catch (err) {
        return { ok: false, success: false, error: `Codex 模型列表获取失败: ${err.message}` };
      }
    }

    // 4. 网络模型接口（OpenRouter / Cloudflare / 通用）
    if (!chatService) return { ok: false, success: false, error: '聊天服务未就绪' };
    return chatService.fetchModels(authProfile);
  });

/* ---------------------- MemoryGateway 长期记忆 IPC ---------------------- */

ipcMain.handle('memoryGateway:check-health', async (event, payload) => {
  if (!senderOk(event)) return { ok: false, error: '调用方不被信任' };
  if (!memoryGatewayProvider) return { ok: false, error: 'MemoryGateway 适配器未就绪' };

  // 权威存储交叉核验：权威缺失或损坏时一律直接拒绝，网络出站严格为 0
  const authData = getAuthoritativeData();
  if (!authData) {
    return { ok: false, error: '权威存储未就绪或已损坏，已拦截请求' };
  }

  const authConfig = authData.memoryGatewayConfig;
  if (!authConfig || !authConfig.enabled) {
    return { ok: false, error: 'MemoryGateway 云端记忆服务当前未激活' };
  }

  const baseUrl = authConfig.baseUrl || payload?.baseUrl;
  if (!baseUrl) {
    return { ok: false, error: '未配置 MemoryGateway 服务地址' };
  }

  // 严禁将其他成员凭据发送至 MemoryGateway 健康检查，仅限 cred_memoryGateway 或 null
  const credentialRef = authConfig.credentialRef === 'cred_memoryGateway' ? 'cred_memoryGateway' : (payload?.credentialRef === 'cred_memoryGateway' ? 'cred_memoryGateway' : null);

  return memoryGatewayProvider.checkHealth(baseUrl, credentialRef);
});

ipcMain.handle('memoryGateway:recall', async (event, params) => {
  if (!senderOk(event)) return { success: false, memories: [], error: '调用方不被信任' };
  if (!memoryGatewayProvider) return { success: false, memories: [], error: 'MemoryGateway 适配器未就绪' };

  const authData = getAuthoritativeData();
  const val = validateMemoryGatewayRecall(params, authData);
  if (!val.ok) {
    return { success: false, memories: [], error: val.error };
  }

  return memoryGatewayProvider.recall({
    baseUrl: val.authConfig.baseUrl,
    credentialRef: val.authConfig.credentialRef || 'cred_memoryGateway',
    query: params?.query,
    namespace: val.allowedNamespace,
    top_k: params?.top_k || params?.k || 5,
    k: params?.top_k || params?.k || 5,
  });
});

ipcMain.handle('memoryGateway:ingest', async (event, params) => {
  if (!senderOk(event)) return { success: false, ingested: 0, error: '调用方不被信任' };
  if (!memoryGatewayProvider) return { success: false, ingested: 0, error: 'MemoryGateway 适配器未就绪' };

  const authData = getAuthoritativeData();
  const val = validateMemoryGatewayIngest(params, authData);
  if (!val.ok) {
    return { success: false, ingested: 0, error: val.error };
  }

  return memoryGatewayProvider.ingestMessages({
    baseUrl: val.authConfig.baseUrl,
    credentialRef: val.authConfig.credentialRef || 'cred_memoryGateway',
    conversationId: params?.conversationId,
    namespace: val.allowedNamespace,
    messages: params?.messages,
  });
});

ipcMain.handle('memoryGateway:search', async (event, params) => {
  if (!senderOk(event)) return { success: false, results: [] };
  if (!memoryGatewayProvider) return { success: false, results: [] };

  const authData = getAuthoritativeData();
  const val = validateMemoryGatewaySearch(params, authData);
  if (!val.ok) {
    return { success: false, results: [], error: val.error };
  }

  return memoryGatewayProvider.search({
    baseUrl: val.authConfig.baseUrl,
    credentialRef: val.authConfig.credentialRef || 'cred_memoryGateway',
    query: params?.query,
    namespace: val.allowedNamespace,
    namespaces: [val.allowedNamespace],
    top_k: params?.top_k || params?.limit || 10,
    limit: params?.limit || 10,
  });
});

/* ---------------------- CloudSync 同步与记忆操作 IPC ---------------------- */

ipcMain.handle('cloudSync:get-status', async (event) => {
  if (!senderOk(event)) return { ok: false, error: '调用方不被信任' };
  if (!cloudSyncSyncService) return { ok: false, error: 'CloudSync 服务未就绪' };
  return { ok: true, ...cloudSyncSyncService.getStatus() };
});

ipcMain.handle('cloudSync:login', async (event, credentials) => {
  if (!senderOk(event)) return { ok: false, error: '调用方不被信任' };
  if (!cloudSyncSyncService) return { ok: false, error: 'CloudSync 服务未就绪' };
  return cloudSyncSyncService.login(credentials);
});

ipcMain.handle('cloudSync:logout', async (event) => {
  if (!senderOk(event)) return { ok: false, error: '调用方不被信任' };
  if (!cloudSyncSyncService) return { ok: false, error: 'CloudSync 服务未就绪' };
  return cloudSyncSyncService.logout();
});

ipcMain.handle('cloudSync:sync-now', async (event) => {
  if (!senderOk(event)) return { ok: false, error: '调用方不被信任' };
  if (!cloudSyncSyncService) return { ok: false, error: 'CloudSync 服务未就绪' };
  return cloudSyncSyncService.syncNow();
});

// Owner 管理模式（界面查看或全量管理）：独立 IPC 入口，与成员受限读取物理隔离
ipcMain.handle('memory:owner-read-by-id', async (event, params) => {
  if (!senderOk(event)) return { ok: false, error: '调用方不被信任' };
  const authData = getAuthoritativeData();
  const memoryId = params?.memoryId;
  if (!memoryId) {
    return { ok: false, code: 'BAD_REQUEST', error: '缺少 memoryId' };
  }
  const mem = (authData.memories || []).find((m) => m.id === memoryId);
  if (!mem || mem.tombstoned || mem.status === 'deleted' || mem.status === 'invalidated') {
    return { ok: false, code: 'NOT_FOUND', error: '记忆不存在' };
  }
  return { ok: true, memory: mem };
});

// AI 成员受限读取：必须绑定可信会话与主体，严禁通过 params.asOwner 绕过或缺失会话绑定
ipcMain.handle('memory:read-by-id', async (event, params) => {
  if (!senderOk(event)) return { ok: false, error: '调用方不被信任' };
  const authData = getAuthoritativeData();
  const memoryId = params?.memoryId;
  if (!memoryId) {
    return { ok: false, code: 'BAD_REQUEST', error: '缺少 memoryId' };
  }

  // 1. 严格禁止在成员读取入口使用 params.asOwner 假借管理员权限
  if (params?.asOwner !== undefined && params?.asOwner !== false) {
    return { ok: false, code: 'FORBIDDEN', error: 'AI 成员读取接口严禁冒充 Owner 权限' };
  }

  // 2. 必须具备实际会话绑定 conversationId
  const conversationId = params?.conversationId;
  if (!conversationId || typeof conversationId !== 'string') {
    return { ok: false, code: 'BAD_REQUEST', error: 'AI 成员读取必须绑定有效会话 conversationId' };
  }

  const conv = (authData.conversations || []).find((c) => c.id === conversationId);
  if (!conv) {
    return { ok: false, code: 'FORBIDDEN', error: '会话不存在或未授权' };
  }

  // 3. 严格解析并核验可信成员主体
  let authoritativeMemberId = null;
  if (conv.kind === 'direct') {
    if (!conv.agentId) {
      return { ok: false, code: 'FORBIDDEN', error: '私聊会话缺失归属成员' };
    }
    // 若入参携带 memberId，必须与该会话归属成员完全一致，严禁跨成员/伪造成员
    if (params?.memberId && params.memberId !== conv.agentId) {
      return { ok: false, code: 'FORBIDDEN', error: `身份不匹配：伪造 memberId ${params.memberId} 与会话归属 ${conv.agentId} 不符` };
    }
    authoritativeMemberId = conv.agentId;
  } else if (conv.kind === 'living-room') {
    const rawMemberId = params?.memberId;
    if (!rawMemberId) {
      return { ok: false, code: 'BAD_REQUEST', error: '客厅读取必须提供合法成员主体' };
    }
    // 必须是已注册的 AI 成员
    const isRegisteredAi = (authData.agents || []).some((a) => a.id === rawMemberId && a.kind === 'ai');
    if (!isRegisteredAi) {
      return { ok: false, code: 'FORBIDDEN', error: '未注册或非法的成员主体' };
    }
    authoritativeMemberId = rawMemberId;
  } else {
    return { ok: false, code: 'FORBIDDEN', error: '不支持的会话类型' };
  }

  // 4. 调用 memoryManager 权威授权校验函数
  return readMemoryById(authData, authoritativeMemberId, memoryId);
});

ipcMain.handle('memory:resolve-conflict', async (event, params) => {
  if (!senderOk(event)) return { ok: false, error: '调用方不被信任' };
  if (!cloudSyncSyncService) return { ok: false, error: 'CloudSync 服务未就绪' };
  return cloudSyncSyncService.resolveMemoryConflict(params);
});

/* ---------------------- 桌面第一人称日记馆 ---------------------- */
for (const [channel, method] of [['diary:owner-read', 'getOwnerJournal'], ['diary:owner-save', 'saveOwnerJournal']]) {
  ipcMain.handle(channel, async (event, payload) => {
    if (!senderOk(event) || !diaryService) return { ok: false, error: '日记服务尚未就绪' };
    try { return { ok: true, ...diaryService[method](payload) }; }
    catch (error) { return { ok: false, error: error.message, code: error.code }; }
  });
}
ipcMain.handle('diary:books', async (event) => {
  if (!senderOk(event)) return { books: [], latestGlobal: null };
  if (!diaryService) return { books: [], latestGlobal: null };
  return diaryService.getBooks();
});

ipcMain.handle('diary:catalog', async (event, agentId, options) => {
  if (!senderOk(event)) return { agentId, entries: [], nextCursor: null };
  if (!diaryService) return { agentId, entries: [], nextCursor: null };
  return diaryService.getCatalog(agentId, options);
});

ipcMain.handle('diary:entry', async (event, agentId, dateStr, version) => {
  if (!senderOk(event)) return null;
  if (!diaryService) return null;
  return diaryService.getEntry(agentId, dateStr, version);
});

ipcMain.handle('diary:settings-get', async (event) => {
  if (!senderOk(event)) return null;
  if (!diaryService) return null;
  return diaryService.getSettings();
});

ipcMain.handle('diary:settings-set', async (event, payload) => {
  if (!senderOk(event)) return null;
  if (!diaryService) return null;
  return diaryService.updateSettings(payload || {});
});

ipcMain.handle('study:books', async (event) => {
  if (!senderOk(event) || !studyService) return [];
  return studyService.getBooks();
});

ipcMain.handle('study:book', async (event, bookId) => {
  if (!senderOk(event) || !studyService) return null;
  return studyService.getBook(bookId);
});

ipcMain.handle('study:create-book', async (event, payload) => {
  if (!senderOk(event) || !studyService) return { ok: false, error: '书房服务尚未就绪' };
  try { return { ok: true, book: studyService.createBook(payload) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('study:set-status', async (event, payload) => {
  if (!senderOk(event) || !studyService) return { ok: false, error: '书房服务尚未就绪' };
  try { return { ok: true, book: studyService.setBookStatus(payload) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('study:acquire-lock', async (event, payload) => {
  if (!senderOk(event) || !studyService) return { ok: false, reason: '书房服务尚未就绪' };
  return studyService.acquireLock(payload);
});

ipcMain.handle('study:release-lock', async (event, payload) => {
  if (!senderOk(event) || !studyService) return { ok: false, reason: '书房服务尚未就绪' };
  return studyService.releaseLock(payload);
});

ipcMain.handle('study:append-section', async (event, payload) => {
  if (!senderOk(event) || !studyService) return { ok: false, error: '书房服务尚未就绪' };
  try { return studyService.appendSection(payload); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('study:add-annotation', async (event, payload) => {
  if (!senderOk(event) || !studyService) return { ok: false, error: '书房服务尚未就绪' };
  try { return studyService.addAnnotation(payload); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('study:submit-revision', async (event, payload) => {
  if (!senderOk(event) || !studyService) return { ok: false, error: '书房服务尚未就绪' };
  try { return studyService.submitRevision(payload); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('study:mark-dry', async (event, payload) => {
  if (!senderOk(event) || !studyService) return { ok: false, error: '书房服务尚未就绪' };
  try { return studyService.markInkDry(payload); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('study:set-section-hidden', async (event, payload) => {
  if (!senderOk(event) || !studyService) return { ok: false, error: '书房服务尚未就绪' };
  try { return studyService.setSectionHidden(payload); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('study:request-section-rewrite', async (event, payload) => {
  if (!senderOk(event) || !studyService) return { ok: false, error: '书房服务尚未就绪' };
  try { return studyService.requestSectionRewrite(payload); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('study:cancel-section-rewrite', async (event, payload) => {
  if (!senderOk(event) || !studyService) return { ok: false, error: '书房服务尚未就绪' };
  try { return studyService.cancelSectionRewrite(payload); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('study:settings-get', async (event) => {
  if (!senderOk(event) || !studyService) return null;
  return studyService.getSettings();
});

ipcMain.handle('study:settings-set', async (event, payload) => {
  if (!senderOk(event) || !studyService) return null;
  return studyService.updateSettings(payload || {});
});
}

module.exports = {
  APP_ID,
  validateChatProfile,
  validateStartStreamParams,
  validateTestConnection,
  validateMemoryGatewayRecall,
  validateMemoryGatewaySearch,
  validateMemoryGatewayIngest,
  assembleAuthoritativeTurn,
  getAuthoritativeData,
};
