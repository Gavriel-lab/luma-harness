'use strict';

/**
 * 小屋 · preload 桥
 *
 * 窄接口：
 * - 数据持久化：会话初始化、四态加载、保存、坏原文备份、有效副本检查/恢复、系统导出、关闭握手；
 * - 凭据存储：保存密钥（加密写入）、删除凭据、检查凭据是否存在（绝不提供读取明文密钥接口）；
 * - 模型传输：流式请求发起与停止、连接连通性测试、接收 chunk/done/error/stopped 事件。
 * 不暴露 ipcRenderer 本身，也不暴露 fs / shell / 任意路径读写。
 * 沙盒 preload 必须是 CommonJS 格式，这里用 .cjs。
 */
const { contextBridge, ipcRenderer } = require('electron');

/** 关闭请求的监听句柄，交给 renderer 注销 */
const closeListeners = new Set();

const desktopBridge = {
  isDesktop: true,
  openLocalMobile:()=>ipcRenderer.invoke('public:open-mobile'),
  autonomy: { presence: () => ipcRenderer.invoke('autonomy:presence') },
  onAuthoritativeMutation:handler=>{
    const listener=(_event,{mutationId,command})=>Promise.resolve().then(()=>handler(command))
      .then(result=>ipcRenderer.send('authority:mutation-ack',{mutationId,ok:result?.ok===true,applied:result?.applied===true,reason:result?.reason}))
      .catch(e=>ipcRenderer.send('authority:mutation-ack',{mutationId,ok:false,applied:false,reason:e?.message||'权威写入失败'}));
    ipcRenderer.on('authority:mutation',listener);return()=>ipcRenderer.removeListener('authority:mutation',listener);
  },
  bridge:{
    snapshot:()=>ipcRenderer.invoke('bridge:snapshot'),
    register:payload=>ipcRenderer.invoke('bridge:register',payload),
    dispatch:payload=>ipcRenderer.invoke('bridge:dispatch',payload),
    cancel:jobId=>ipcRenderer.invoke('bridge:cancel',{jobId}),
    accept:jobId=>ipcRenderer.invoke('bridge:accept',{jobId}),
    launch:agentId=>ipcRenderer.invoke('bridge:launch',{agentId}),
    resume:jobId=>ipcRenderer.invoke('bridge:resume',{jobId,confirmed:true}),
    chatRoute:(agentId,enabled)=>ipcRenderer.invoke('bridge:chat-route',{agentId,enabled}),
    setDispatchChannel:enabled=>ipcRenderer.invoke('bridge:dispatch-channel',{enabled}),
    onChanged:handler=>{const listener=(_event,snapshot)=>handler(snapshot);ipcRenderer.on('bridge:changed',listener);return()=>ipcRenderer.removeListener('bridge:changed',listener);}
  },

  /** renderer 每次挂载生成新的 sessionId：重载后第一次修改才能正常落盘 */
  beginSession: (sessionId) => ipcRenderer.invoke('session:begin', sessionId),

  /** 四态：missing / ok / corrupt / unreadable */
  load: () => ipcRenderer.invoke('data:load'),

  save: (payload, revision, sessionId) => ipcRenderer.invoke('data:save', payload, revision, sessionId),

  backupRaw: (raw) => ipcRenderer.invoke('data:backup-raw', raw),

  readBackup: () => ipcRenderer.invoke('data:read-backup'),

  restoreBackup: (sessionId, revision) => ipcRenderer.invoke('data:restore-backup', sessionId, revision),

  paths: () => ipcRenderer.invoke('data:paths'),

  /** 返回 { ok, applied, canceled, filePath? }：取消不算失败，成功只在真正写盘后才成立 */
  exportData: (payload) => ipcRenderer.invoke('data:export', payload),
  discardAndClose: () => ipcRenderer.invoke('app:discard-and-close', { confirmed: true }),

  /**
   * 关闭握手：主进程请求提交最新状态，返回注销函数。
   * 响应 requestId 必须与请求一致，否则主进程不会放行关闭。
   */
  onCloseRequest: (handler) => {
    const listener = (_event, requestId) => {
      Promise.resolve().then(() => handler(requestId))
        .then((result) => {
          ipcRenderer.send('app:close-ack', {
            requestId,
            ok: result?.ok !== false,
            reason: result?.reason,
          });
        })
        .catch((e) => {
          ipcRenderer.send('app:close-ack', { requestId, ok: false, reason: e && e.message ? e.message : '保存失败' });
        });
    };
    ipcRenderer.on('app:close-request', listener);
    closeListeners.add(listener);
    return () => {
      ipcRenderer.removeListener('app:close-request', listener);
      closeListeners.delete(listener);
    };
  },

  /** 主进程告知上次关闭被拦下（写入失败或超时） */
  onCloseFailed: (handler) => {
    const listener = (_event, reason) => handler(reason);
    ipcRenderer.on('app:close-failed', listener);
    return () => ipcRenderer.removeListener('app:close-failed', listener);
  },

  /* ---------------------- 凭据管理（安全窄桥） ---------------------- */
  credentials: {
    set: (ref, key) => ipcRenderer.invoke('credentials:set', { ref, key }),
    delete: (ref) => ipcRenderer.invoke('credentials:delete', { ref }),
    has: (ref) => ipcRenderer.invoke('credentials:has', { ref }),
    isAvailable: () => ipcRenderer.invoke('credentials:is-available'),
  },

  /* ---------------------- 真实传输与流式 ---------------------- */
  attachments: {
    importFile: (input) => ipcRenderer.invoke('attachments:import', input),
    preview: (id, full = false) => ipcRenderer.invoke('attachments:preview', { id, full }),
    exportFile: (id) => ipcRenderer.invoke('attachments:export', id),
  },
  chat: {
    startStream: (params) => ipcRenderer.invoke('chat:start-stream', params),
    stopStream: (requestId) => ipcRenderer.invoke('chat:stop-stream', { requestId }),
    testConnection: (profile) => ipcRenderer.invoke('chat:test-connection', profile),

    onStreamChunk: (handler) => {
      const listener = (_e, data) => handler(data);
      ipcRenderer.on('chat:stream-chunk', listener);
      return () => ipcRenderer.removeListener('chat:stream-chunk', listener);
    },
    onStreamDone: (handler) => {
      const listener = (_e, data) => handler(data);
      ipcRenderer.on('chat:stream-done', listener);
      return () => ipcRenderer.removeListener('chat:stream-done', listener);
    },
    onStreamError: (handler) => {
      const listener = (_e, data) => handler(data);
      ipcRenderer.on('chat:stream-error', listener);
      return () => ipcRenderer.removeListener('chat:stream-error', listener);
    },
    onStreamStopped: (handler) => {
      const listener = (_e, data) => handler(data);
      ipcRenderer.on('chat:stream-stopped', listener);
      return () => ipcRenderer.removeListener('chat:stream-stopped', listener);
    },
    onCodexThreadBound: (handler) => {
      const listener = (_e, data) => handler(data);
      ipcRenderer.on('codex:thread-bound', listener);
      return () => ipcRenderer.removeListener('codex:thread-bound', listener);
    },
    onMemoryReceipt: (handler) => {
      const listener = (_e, data) => handler(data);
      ipcRenderer.on('chat:memory-receipt', listener);
      return () => ipcRenderer.removeListener('chat:memory-receipt', listener);
    },
  },

  /* ---------------------- Codex CLI 专属服务 ---------------------- */
  codex: {
    listModels: () => ipcRenderer.invoke('codex:list-models'),
  },

  /* ---------------------- MemoryGateway 长期记忆适配 ---------------------- */
  memoryGateway: {
    checkHealth: (baseUrl, credentialRef) => ipcRenderer.invoke('memoryGateway:check-health', { baseUrl, credentialRef }),
    recall: (params) => ipcRenderer.invoke('memoryGateway:recall', params),
    ingest: (params) => ipcRenderer.invoke('memoryGateway:ingest', params),
    search: (params) => ipcRenderer.invoke('memoryGateway:search', params),
  },

  /* ---------------------- 模型目录拉取 ---------------------- */
  models: {
    fetch: (params) => ipcRenderer.invoke('models:fetch', params),
  },

  /* ---------------------- CloudSync 同步与记忆操作 ---------------------- */
  cloudSync: {
    getStatus: () => ipcRenderer.invoke('cloudSync:get-status'),
    login: (credentials) => ipcRenderer.invoke('cloudSync:login', credentials),
    logout: () => ipcRenderer.invoke('cloudSync:logout'),
    syncNow: () => ipcRenderer.invoke('cloudSync:sync-now'),
    onSyncState: (handler) => {
      const listener = (_e, state) => handler(state);
      ipcRenderer.on('cloudSync:sync-state', listener);
      return () => ipcRenderer.removeListener('cloudSync:sync-state', listener);
    },
  },
  memory: {
    ownerReadById: (params) => ipcRenderer.invoke('memory:owner-read-by-id', params),
    readById: (params) => ipcRenderer.invoke('memory:read-by-id', params),
    resolveConflict: (params) => ipcRenderer.invoke('memory:resolve-conflict', params),
  },
  diary: {
    getOwnerJournal: date => ipcRenderer.invoke('diary:owner-read', date),
    saveOwnerJournal: entry => ipcRenderer.invoke('diary:owner-save', entry),
    getBooks: () => ipcRenderer.invoke('diary:books'),
    getCatalog: (agentId, options) => ipcRenderer.invoke('diary:catalog', agentId, options),
    getEntry: (agentId, dateStr, version) => ipcRenderer.invoke('diary:entry', agentId, dateStr, version),
    getSettings: () => ipcRenderer.invoke('diary:settings-get'),
    setSettings: (payload) => ipcRenderer.invoke('diary:settings-set', payload),
  },
  study: {
    getBooks: () => ipcRenderer.invoke('study:books'),
    getBook: (bookId) => ipcRenderer.invoke('study:book', bookId),
    createBook: (payload) => ipcRenderer.invoke('study:create-book', payload),
    setBookStatus: (payload) => ipcRenderer.invoke('study:set-status', payload),
    acquireLock: (payload) => ipcRenderer.invoke('study:acquire-lock', payload),
    releaseLock: (payload) => ipcRenderer.invoke('study:release-lock', payload),
    appendSection: (payload) => ipcRenderer.invoke('study:append-section', payload),
    addAnnotation: (payload) => ipcRenderer.invoke('study:add-annotation', payload),
    submitRevision: (payload) => ipcRenderer.invoke('study:submit-revision', payload),
    markInkDry: (payload) => ipcRenderer.invoke('study:mark-dry', payload),
    setSectionHidden: (payload) => ipcRenderer.invoke('study:set-section-hidden', payload),
    requestSectionRewrite: (payload) => ipcRenderer.invoke('study:request-section-rewrite', payload),
    cancelSectionRewrite: (payload) => ipcRenderer.invoke('study:cancel-section-rewrite', payload),
    getSettings: () => ipcRenderer.invoke('study:settings-get'),
    setSettings: (payload) => ipcRenderer.invoke('study:settings-set', payload),
  },
};

contextBridge.exposeInMainWorld('xiaowuDesktop', desktopBridge);
contextBridge.exposeInMainWorld('xiaowu', desktopBridge);
