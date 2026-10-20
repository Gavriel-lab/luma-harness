import type { ChatAdapter, ChatChunk, ChatRequest } from './ChatAdapter';

export interface StreamStart {
  conversationId: string;
  requestId: string;
  messageId: string;
}

export interface StreamHandlers {
  /** 请求被接受，可以先插入一条 streaming 占位消息 */
  onStart: (start: StreamStart) => void;
  onDelta: (info: StreamStart & { delta: string }) => void;
  onThinking: (info: StreamStart) => void;
  onDone: (info: StreamStart) => void;
  onError: (info: StreamStart & { message: string }) => void;
  /** 取消完成；迟到回调会被丢弃，不再触发任何 handler */
  onCancelled: (info: StreamStart & { reason: 'user' | 'superseded' }) => void;
}

/**
 * ChatBus：持有当前请求句柄与绑定信息，负责取消与迟到回调丢弃。
 *
 * 关键规则：
 * 1. 原型全局同时只允许一个进行中的请求，新发送会停止旧回复；
 * 2. 每个回调都必须通过会话 ID + 请求 ID 双重校验；
 * 3. 切换会话不自动取消，回调写入原消息的会话；
 * 4. 取消后所有已排队的回调全部丢弃。
 */
export class ChatBus {
  private handle: { cancel: () => void } | null = null;
  private current: StreamStart | null = null;
  private stopping = false;
  private lastStoppingHandle: { cancel: () => void } | null = null;

  constructor(
    private readonly adapter: ChatAdapter,
    private readonly handlers: StreamHandlers,
  ) {}

  get active(): StreamStart | null {
    return this.current;
  }

  /** 某会话是否正在生成（用于显示「生成中」标记） */
  isStreaming(conversationId: string): boolean {
    return this.current?.conversationId === conversationId;
  }

  start(req: Omit<ChatRequest, 'requestId'> & { requestId: string; messageId: string }): void {
    this.cancel('superseded');

    const info: StreamStart = {
      conversationId: req.conversationId,
      requestId: req.requestId,
      messageId: req.messageId,
    };
    this.current = info;
    this.stopping = false;
    this.lastStoppingHandle = null;
    this.handlers.onStart(info);

    const accept = (chunk: ChatChunk): boolean => {
      // 迟到的回调必须同时匹配会话与请求；若处于前次中断失败保留句柄等待终态中，允许将迟到的确认终态转为 onCancelled
      if (!this.current) {
        if (chunk.type === 'done' && this.lastStoppingHandle === handle) {
          this.lastStoppingHandle = null;
          this.stopping = false;
          this.handlers.onCancelled({ ...info, reason: 'user' });
          return true;
        }
        return false;
      }
      if (this.current.requestId !== info.requestId || this.current.conversationId !== info.conversationId) {
        return false;
      }
      switch (chunk.type) {
        case 'thinking':
          if (!this.stopping) this.handlers.onThinking(info);
          break;
        case 'delta':
          if (!this.stopping && chunk.delta) this.handlers.onDelta({ ...info, delta: chunk.delta });
          break;
        case 'done':
          this.current = null;
          this.handle = null;
          if (this.stopping) {
            this.stopping = false;
            this.handlers.onCancelled({ ...info, reason: 'user' });
          } else {
            this.handlers.onDone(info);
          }
          break;
        case 'error':
          this.lastStoppingHandle = this.stopping ? this.handle : null;
          this.current = null;
          this.handle = null;
          this.stopping = false;
          this.handlers.onError({ ...info, message: chunk.message ?? '未知错误' });
          break;
      }
      return true;
    };

    const handle = this.adapter.send(req, accept);
    if (this.current === info) this.handle = handle;
    else handle.cancel();
  }

  /** 取消当前请求；reason 用于区分「用户停止」与「被新请求取代」 */
  cancel(reason: 'user' | 'superseded' = 'user'): void {
    const info = this.current;
    if (!info) {
      if (reason === 'user' && this.lastStoppingHandle) {
        try {
          const res = this.lastStoppingHandle.cancel() as any;
          if (res && typeof res.then === 'function') {
            this.stopping = true;
          }
        } catch {}
      }
      return;
    }

    this.lastStoppingHandle = null;

    if (reason === 'superseded') {
      const handle = this.handle;
      this.handle = null;
      this.current = null;
      this.stopping = false;
      handle?.cancel();
      this.handlers.onCancelled({ ...info, reason: 'superseded' });
      return;
    }

    // 用户主动点击停止：
    if (this.handle) {
      try {
        const res = this.handle.cancel() as any;
        // 若底层适配器返回了 Promise（如 RemoteDesktopAdapter），进入 stopping 状态等待异步终态/错误
        if (res && typeof res.then === 'function') {
          this.stopping = true;
          return;
        }
      } catch (err) {
        console.error('[ChatBus] 取消适配器请求失败', err);
      }
    }

    // 同步完成取消（如 DemoAdapter）
    this.handle = null;
    this.current = null;
    this.stopping = false;
    this.handlers.onCancelled({ ...info, reason: 'user' });
  }
}
