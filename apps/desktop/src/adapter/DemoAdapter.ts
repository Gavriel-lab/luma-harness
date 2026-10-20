import type { ChatAdapter, ChatChunk, ChatHandle, ChatRequest } from './ChatAdapter';

export interface DemoAdapterOptions {
  /** 思考态时长（ms），用于演示「思考呼吸」动画 */
  thinkMs?: number;
  /** 每段输出间隔（ms） */
  tickMs?: number;
  /** 可注入的定时器，便于自动化测试 */
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
  };
}

/**
 * 演示用适配器：不发起任何网络请求，不连接任何真实 AI。
 * 回复文本全部是写死的模板，前缀会显式说明这是演示回复。
 */
export class DemoAdapter implements ChatAdapter {
  readonly id = 'demo';
  readonly label = '演示适配器';
  readonly demo = true;

  private readonly thinkMs: number;
  private readonly tickMs: number;
  private readonly scheduler: NonNullable<DemoAdapterOptions['scheduler']>;

  constructor(options: DemoAdapterOptions = {}) {
    this.thinkMs = options.thinkMs ?? 900;
    this.tickMs = options.tickMs ?? 220;
    // 必须绑到 globalThis：浏览器里裸传 setTimeout 会抛 Illegal invocation
    const g = globalThis as unknown as {
      setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
      clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
    };
    this.scheduler = options.scheduler ?? {
      setTimeout: (fn, ms) => g.setTimeout(fn, ms),
      clearTimeout: (id) => g.clearTimeout(id),
    };
  }

  private composeReply(req: ChatRequest): string {
    const where = req.toAgentId ? '私聊' : '客厅群聊';
    const heard = req.text.length > 40 ? `${req.text.slice(0, 40)}…` : req.text;
    const lines = [
      '【演示回复】这里是小屋的本地演示内容，真实 AI 尚未接入。',
      `我读到的是（${where}）：「${heard}」`,
      '这段文字由 DemoAdapter 本地生成，没有联网，也没有真实模型参与。',
      '后续工单 02 会在可信后端接入真实服务，前端接口不变。',
    ];
    if (req.toAgentId) {
      lines.push('这一条属于成员私聊，不会串到客厅或其他成员会话。');
    } else {
      lines.push('这一条属于客厅群聊，发言者身份由消息本身记录，不靠名字推断。');
    }
    return lines.join('\n');
  }

  send(req: ChatRequest, onChunk: (chunk: ChatChunk) => void): ChatHandle {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const later = (fn: () => void, ms: number) => {
      const id = this.scheduler.setTimeout(() => {
        if (!cancelled) fn();
      }, ms);
      timers.push(id);
    };

    later(() => onChunk({ type: 'thinking' }), 60);

    // 先按字符切成小块，模拟文本流
    const full = this.composeReply(req);
    const pieces: string[] = [];
    for (let i = 0; i < full.length; i += 6) pieces.push(full.slice(i, i + 6));

    let t = this.thinkMs;
    pieces.forEach((piece) => {
      t += this.tickMs;
      later(() => onChunk({ type: 'delta', delta: piece }), t);
    });

    later(() => onChunk({ type: 'done' }), t + this.tickMs);

    return {
      cancel: () => {
        cancelled = true;
        for (const id of timers) this.scheduler.clearTimeout(id);
        timers.length = 0;
      },
    };
  }
}