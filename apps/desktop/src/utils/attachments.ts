import type { MessageAttachment } from '../types';
export const ATTACHMENT_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.yaml,.yml,.log,.js,.jsx,.ts,.tsx,.py,.css,.html,.xml,.sql,.sh,.ps1,.ini,.toml,.c,.cpp,.h,.rs,.go,.java';
export function validAttachments(value: unknown): value is MessageAttachment[] {
  return Array.isArray(value) && value.length <= 4 && value.every(a => !!a && typeof a === 'object' && /^att_[a-f0-9]{32}$/.test(a.id) && typeof a.name === 'string' && a.name.length <= 160 && ['image', 'text'].includes(a.kind) && typeof a.mimeType === 'string' && Number.isInteger(a.size) && a.size > 0 && a.size <= 10 * 1024 * 1024) && new Set(value.map(a => a.id)).size === value.length;
}
export async function importAttachment(file: File): Promise<MessageAttachment> {
  if (file.size > 10 * 1024 * 1024) throw Error('照片不能超过 10 MB，文字文件不能超过 512 KB');
  const bridge = window.xiaowuDesktop?.attachments;
  if (!bridge) throw Error('请在桌面试聊版中添加附件');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = ''; for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  const r = await bridge.importFile({ name: file.name, dataBase64: btoa(binary) });
  if (!r.ok || !r.attachment) throw Error(r.reason || '附件保存失败');
  return r.attachment;
}
