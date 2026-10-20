interface ReplyRow {
  id: string; conversationId?: string; requestId?: string | null;
  text?: string; content?: string; isUser?: boolean; role?: string;
  agentId?: string; senderId?: string; sourceChannel?: string;
}
declare const rules: {
  replyInstructions: string;
  replyMedium(text: string): 'voice' | 'text';
  replyText(text: string): string;
  isWorkTopic(text: string, previous?: boolean): boolean;
  replyModes(rows: ReplyRow[]): Map<string, boolean>;
  splitReply(text: string, options?: { work?: boolean; preserve?: boolean; legacy?: boolean | string[] }): string[];
};
export default rules;
