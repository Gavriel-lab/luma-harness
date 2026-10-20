export interface CodexModelItem {
  id: string;
  displayName: string;
  isDefault?: boolean;
}

export declare class CodexService {
  constructor(options?: {
    customSpawn?: (cmd: string, args: string[], opts: any) => any;
    defaultCwd?: string;
  });

  isAvailable(): Promise<{ ok: boolean; path?: string; reason?: string }>;
  startProcess(): Promise<void>;
  listModels(): Promise<{ ok: boolean; models?: CodexModelItem[]; reason?: string }>;
  getOrCreateThread(conversationId: string, savedThreadId?: string, cwd?: string): Promise<{ ok: boolean; threadId?: string; isNew?: boolean; reason?: string }>;
  startTurn(options: {
    conversationId: string;
    threadId: string;
    input: string;
    model?: string;
    onDelta?: (delta: string) => void;
  }): Promise<{ ok: boolean; text?: string; finishReason?: string; reason?: string }>;
  interruptTurn(conversationId: string): Promise<{ ok: boolean; reason?: string }>;
  dispose(): Promise<void>;
}
