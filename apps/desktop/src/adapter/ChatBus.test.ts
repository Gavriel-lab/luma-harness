import { describe, expect, it, vi } from 'vitest';
import { ChatBus } from './ChatBus';
import { DemoAdapter } from './DemoAdapter';
import type { ChatAdapter, ChatChunk } from './ChatAdapter';

/** 手动推进的假定时器，保证测试不依赖真实时间 */
function fakeScheduler() {
  let seq = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  let now = 0;
  return {
    scheduler: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = ++seq;
        queue.set(id, { at: now + ms, fn });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (id: ReturnType<typeof setTimeout>) => {
        queue.delete(id as unknown as number);
      },
    },
    advance(ms: number) {
      const target = now + ms;
      let guard = 0;
      for (;;) {
        const due = [...queue.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0 || guard++ > 5000) break;
        const [id, entry] = due[0]!;
        queue.delete(id);
        now = entry.at;
        entry.fn();
      }
      now = target;
    },
  };
}

function harness(adapter: DemoAdapter, isCurrent: (conversationId: string) => boolean = () => true) {
  const deltas: { conversationId: string; requestId: string; delta: string }[] = [];
  const dones: string[] = [];
  const cancels: { conversationId: string; reason: string }[] = [];
  const bus = new ChatBus(adapter, {
    onStart: () => undefined,
    onThinking: () => undefined,
    onDelta: (i) => {
      // 模拟 UI：只接受当前会话的流
      if (isCurrent(i.conversationId)) deltas.push({ conversationId: i.conversationId, requestId: i.requestId, delta: i.delta });
    },
    onDone: (i) => dones.push(i.requestId),
    onError: () => undefined,
    onCancelled: (i) => cancels.push({ conversationId: i.conversationId, reason: i.reason }),
  });
  return { bus, deltas, dones, cancels };
}

const REQ = {
  conversationId: 'conv_a',
  speakerId: 'agent_owner',
  toAgentId: null,
} as const;

describe('ChatBus · 取消与迟到回调', () => {
  it.each(['done', 'error'] as const)('收到 %s 后请求结束，后续异常回调全部丢弃', (type) => {
    let emit: (chunk: ChatChunk) => void = () => undefined;
    const adapter: ChatAdapter = {
      id: 'bad-remote', label: '测试', demo: false,
      send: (_req, onChunk) => { emit = onChunk; return { cancel: () => undefined }; },
    };
    const delta = vi.fn();
    const bus = new ChatBus(adapter, { onStart: vi.fn(), onThinking: vi.fn(), onDelta: delta, onDone: vi.fn(), onError: vi.fn(), onCancelled: vi.fn() });
    bus.start({ ...REQ, requestId: 'r', messageId: 'm', text: '测试' });
    emit({ type });
    emit({ type: 'delta', delta: '不应写入' });
    expect(bus.active).toBeNull();
    expect(delta).not.toHaveBeenCalled();
  });

  it('用户停止后不再写入任何回复', () => {
    const { scheduler, advance } = fakeScheduler();
    const adapter = new DemoAdapter({ scheduler, thinkMs: 100, tickMs: 50 });
    const { bus, deltas, cancels } = harness(adapter);

    bus.start({ ...REQ, requestId: 'req_1', messageId: 'msg_1', text: '你好' });
    advance(200);
    expect(deltas.length).toBeGreaterThan(0);
    const before = deltas.length;

    bus.cancel('user');
    advance(5000);

    expect(deltas.length).toBe(before);
    expect(cancels).toEqual([{ conversationId: 'conv_a', reason: 'user' }]);
    expect(bus.active).toBeNull();
  });

  it('切换会话后上一会话的迟到回复不会写进新会话', () => {
    const { scheduler, advance } = fakeScheduler();
    const adapter = new DemoAdapter({ scheduler, thinkMs: 100, tickMs: 50 });
    let current = 'conv_a';
    const { bus, deltas } = harness(adapter, (c) => c === current);

    bus.start({ ...REQ, requestId: 'req_1', messageId: 'msg_1', text: '在吗' });
    advance(150);
    const seenInA = deltas.length;
    expect(seenInA).toBeGreaterThan(0);

    current = 'conv_b'; // 用户切到了另一个会话
    advance(5000);

    expect(deltas.every((d) => d.conversationId === 'conv_a')).toBe(true);
    expect(deltas.length).toBe(seenInA);
    expect(bus.isStreaming('conv_a')).toBe(false);
    expect(bus.isStreaming('conv_b')).toBe(false);
  });

  it('同一会话的新请求取代旧请求，旧请求回调全部失效', () => {
    const { scheduler, advance } = fakeScheduler();
    const adapter = new DemoAdapter({ scheduler, thinkMs: 100, tickMs: 50 });
    const { bus, deltas } = harness(adapter);

    bus.start({ ...REQ, requestId: 'req_1', messageId: 'm1', text: '第一句' });
    advance(120);
    bus.start({ ...REQ, requestId: 'req_2', messageId: 'm2', text: '第二句' });
    const afterStart = deltas.filter((d) => d.requestId === 'req_1').length;
    advance(5000);

    expect(deltas.filter((d) => d.requestId === 'req_1').length).toBe(afterStart);
    expect(deltas.some((d) => d.requestId === 'req_2')).toBe(true);
    expect(bus.active).toBeNull();
  });

  it('cancel 在没有进行中的请求时是安全的空操作', () => {
    const { scheduler } = fakeScheduler();
    const adapter = new DemoAdapter({ scheduler });
    const { bus } = harness(adapter);
    expect(() => bus.cancel('user')).not.toThrow();
    expect(bus.active).toBeNull();
  });

  it('start 方法完整透传 messages、profileSnapshot 与 isDemo 字段到 adapter', () => {
    let capturedReq: any = null;
    const adapter: ChatAdapter = {
      id: 'mock',
      label: 'Mock',
      demo: false,
      send: (req) => {
        capturedReq = req;
        return { cancel: () => {} };
      },
    };
    const bus = new ChatBus(adapter, {
      onStart: () => {},
      onThinking: () => {},
      onDelta: () => {},
      onDone: () => {},
      onError: () => {},
      onCancelled: () => {},
    });

    const fullReq = {
      conversationId: 'conv_test',
      requestId: 'req_123',
      messageId: 'msg_123',
      speakerId: 'agent_owner',
      toAgentId: 'agent_coordinator',
      text: '你好',
      messages: [
        { role: 'system' as const, content: '你是协调者' },
        { role: 'user' as const, content: '你好' },
      ],
      profileSnapshot: {
        id: 'profile_coordinator',
        name: '协调者配置',
        providerType: 'openai-compatible' as const,
        baseUrl: 'https://api.test',
        model: 'test-model',
        credentialRef: 'cred_coordinator',
      },
      isDemo: false,
    };

    bus.start(fullReq);
    expect(capturedReq).not.toBeNull();
    expect(capturedReq.messages).toEqual(fullReq.messages);
    expect(capturedReq.profileSnapshot).toEqual(fullReq.profileSnapshot);
    expect(capturedReq.isDemo).toBe(false);
  });
});
