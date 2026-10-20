import { createFontSlot } from './fontSlot';

/** 聊天气泡的自定义字体（库名、变量名沿用原来的，已存的字体不受影响） */
export const chatFontSlot = createFontSlot({
  db: 'luma-chat-fonts-v1',
  cssVar: '--chat-bubble-font',
  dataKey: 'chatFont',
  aliasPrefix: 'LumaChatFont',
  fallback: 'ui-sans-serif, system-ui, sans-serif',
  sample: '今天的小屋，也有你喜欢的颜色。嗯，就把聊天调成这样～ Bonjour 123',
});

export const uploadChatFont = async (file: File) => { await chatFontSlot.upload(file); };
export const applyChatFontCss = chatFontSlot.applyCss;
export const resetChatFont = chatFontSlot.reset;
export const useChatFont = chatFontSlot.useFont;
