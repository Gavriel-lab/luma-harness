import type { ChatAdapter, ChatChunk, ChatHandle, ChatRequest } from './ChatAdapter';
import '../store/backend'; // 引入 DesktopBridge global 声明

export class RemoteDesktopAdapter implements ChatAdapter {
  readonly id = 'remote-desktop';
  readonly label = '真实模型接口';
  readonly demo = false;

  send(req: ChatRequest, onChunk: (chunk: ChatChunk) => void): ChatHandle {
    const desktop = typeof window !== 'undefined' ? window.xiaowuDesktop : undefined;

    if (!desktop || !desktop.isDesktop || !desktop.chat) {
      setTimeout(() => {
        onChunk({
          type: 'error',
          message: '当前非桌面端运行环境，无法调用本地主进程安全网络传输',
        });
      }, 0);
      return { cancel: () => {} };
    }

    if (!req.profileSnapshot) {
      setTimeout(() => {
        onChunk({
          type: 'error',
          message: '成员未配置真实模型接口，请在成员连接设置中进行配置',
        });
      }, 0);
      return { cancel: () => {} };
    }

    let active = true;
    const cleanups: Array<() => void> = [];

    const cleanupAll = () => {
      active = false;
      while (cleanups.length > 0) {
        try {
          const fn = cleanups.pop();
          if (fn) fn();
        } catch { /* 忽略 */ }
      }
    };

    // 注册监听器
    const unChunk = desktop.chat.onStreamChunk((data) => {
      if (!active || data.requestId !== req.requestId || data.conversationId !== req.conversationId) return;
      onChunk({
        type: 'delta',
        delta: data.delta,
      });
    });
    cleanups.push(unChunk);

    // 工单 08-R2：主进程权威来源收据（含失败收据与派生检查点）只在此通道展示
    if (desktop.chat.onMemoryReceipt && req.onMemoryReceipt) {
      const onReceipt = req.onMemoryReceipt;
      const unReceipt = desktop.chat.onMemoryReceipt((data) => {
        if (!active || data.requestId !== req.requestId || data.conversationId !== req.conversationId) return;
        onReceipt(data);
      });
      cleanups.push(unReceipt);
    }

    const unDone = desktop.chat.onStreamDone((data) => {
      if (!active || data.requestId !== req.requestId || data.conversationId !== req.conversationId) return;
      cleanupAll();
      onChunk({ type: 'done' });
    });
    cleanups.push(unDone);

    const unError = desktop.chat.onStreamError((data) => {
      if (!active || data.requestId !== req.requestId || data.conversationId !== req.conversationId) return;
      cleanupAll();
      onChunk({
        type: 'error',
        message: data.error || '请求失败',
      });
    });
    cleanups.push(unError);

    const unStopped = desktop.chat.onStreamStopped((data) => {
      if (!active || data.requestId !== req.requestId || data.conversationId !== req.conversationId) return;
      if (data.unconfirmed || data.error) {
        // 中断未确认：向外分发错误，但绝对不能 cleanupAll()！
        // 保留 active 与监听器，保留重试与等待迟到终态的能力
        onChunk({
          type: 'error',
          message: data.error || data.reason || '中断未能确认，后台进程可能仍在运行',
        });
        return;
      }
      cleanupAll();
      // 用户主动停止并经后端确认
      onChunk({ type: 'done' });
    });
    cleanups.push(unStopped);

    // 异步拉起主进程传输
    // 工单 08-R2：渲染端只提交本轮文本、目标成员、会话与请求/重试边界；
    // 系统历史、来源表与收据由主进程从权威存储组装，messages 不再由渲染端提交。
    desktop.chat.startStream({
      requestId: req.requestId,
      conversationId: req.conversationId,
      targetAgentId: req.toAgentId,
      profile: req.profileSnapshot,
      messages: [],
      mode: req.mode,
      targetAgentName: req.targetAgentName,
      participants: req.participants,
      publicRecentMessages: req.publicRecentMessages,
      currentText: req.text,
      cutoffTime: req.cutoffTime,
      excludeMessageIds: req.excludeMessageIds,
    }).then((res) => {
      if (res && res.ok === false) {
        if (active) {
          cleanupAll();
          onChunk({
            type: 'error',
            message: res.reason || '发起流式请求失败',
          });
        }
      }
    }).catch((e) => {
      if (active) {
        cleanupAll();
        onChunk({
          type: 'error',
          message: e?.message || '发起请求异常',
        });
      }
    });

    return {
      cancel: () => {
        if (!active) return Promise.resolve();
        if (desktop.chat) {
          return desktop.chat.stopStream(req.requestId).then((res) => {
            if (res && (res.ok === false || res.unconfirmed || res.error)) {
              if (active) {
                // 中断未确认：向外分发错误，但不清理监听，保留重试与等待迟到终态的能力
                onChunk({
                  type: 'error',
                  message: res.error || res.reason || '中断未能确认，后台进程状态未知',
                });
              }
            }
          }).catch((err) => {
            if (active) {
              onChunk({
                type: 'error',
                message: `中断异常: ${err?.message || err}`,
              });
            }
          });
        } else {
          cleanupAll();
          return Promise.resolve();
        }
      },
    };
  }
}
