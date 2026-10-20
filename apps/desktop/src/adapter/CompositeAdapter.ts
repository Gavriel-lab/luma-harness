import type { ChatAdapter, ChatChunk, ChatHandle, ChatRequest } from './ChatAdapter';
import { DemoAdapter } from './DemoAdapter';
import { RemoteDesktopAdapter } from './RemoteDesktopAdapter';

export class CompositeAdapter implements ChatAdapter {
  readonly id = 'composite';
  readonly label = '小屋传输总线';
  readonly demo = false;

  private demoAdapter = new DemoAdapter();
  private remoteAdapter = new RemoteDesktopAdapter();

  send(req: ChatRequest, onChunk: (chunk: ChatChunk) => void): ChatHandle {
    const isDesktop = typeof window !== 'undefined' && !!window.xiaowuDesktop?.isDesktop;

    if (!isDesktop) {
      if (req.isDemo || req.profileSnapshot?.providerType === 'demo') {
        return this.demoAdapter.send(req, onChunk);
      }
      setTimeout(() => {
        onChunk({
          type: 'error',
          message: '当前处于浏览器预览环境，真实模型接口仅在桌面客户端可用',
        });
      }, 0);
      return { cancel: () => {} };
    }

    if (req.isDemo || req.profileSnapshot?.providerType === 'demo') {
      return this.demoAdapter.send(req, onChunk);
    }

    // 否则走真实桌面原生传输
    return this.remoteAdapter.send(req, onChunk);
  }
}
