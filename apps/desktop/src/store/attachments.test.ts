import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEmpty } from './seed';
import { reducer } from './reducer';
import { validateData } from './storage';
const { AttachmentsStore, prepareAttachmentContext, applyAttachmentWire } = require(path.resolve(__dirname, '../../electron/attachmentsStore.cjs'));
const { looksLikeValidAppData } = require(path.resolve(__dirname, '../../electron/dataStore.cjs'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const nativeImage = { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), resize: () => ({ toJPEG: () => Buffer.from([255, 216, 255, 217]) }) }) };
describe('photo and text attachments', () => {
  let dir: string, store: any;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaowu-att-unit-')); store = new AttachmentsStore(dir, nativeImage); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  it('stores an independent original, verifies its bytes, bounds text, and reads it after a restart', async () => {
    const bytes = Buffer.from('灵感与证据\n' + '猫'.repeat(13000));
    const a = await store.importFile({ name: '../灵感.md', dataBase64: bytes.toString('base64') });
    expect(a.name).toBe('灵感.md'); expect(a.truncated).toBe(true);
    const restored = new AttachmentsStore(dir, nativeImage).resolve(a.id);
    expect(restored.bytes.equals(bytes)).toBe(true); expect(restored.text.length).toBe(12000);
    fs.writeFileSync(path.join(store.dir, a.id + '.bin'), 'tampered'); expect(() => store.resolve(a.id)).toThrow('校验失败');
  });
  it('rejects unsupported formats, binary disguised as text, invalid encoding, oversized files and arbitrary paths', async () => {
    for (const [name, bytes] of [['demo.pdf', Buffer.from('%PDF-1.4')], ['fake.txt', Buffer.from([0, 1, 2])], ['gb.txt', Buffer.from([255, 255])], ['big.txt', Buffer.alloc(512 * 1024 + 1, 65)]] as const) await expect(store.importFile({ name, dataBase64: bytes.toString('base64') })).rejects.toThrow();
    expect(() => store.resolve('../../credentials.enc')).toThrow('标识无效');
    await expect(store.importFile({ name: 'bad.txt', dataBase64: 'aaaa!' })).rejects.toThrow();
  });
  it('keeps per-conversation drafts and removes only a chosen reference, across serialization', async () => {
    const a = await store.importFile({ name: '计划.txt', dataBase64: Buffer.from('准备开会').toString('base64') });
    const d = buildEmpty();
    const one = reducer(d, { type: 'addAttachmentDraft', conversationId: 'conv_dm_brother', attachment: a });
    const two = reducer(one, { type: 'addAttachmentDraft', conversationId: 'conv_living_room', attachment: a });
    const raw = JSON.stringify(two); const loaded = validateData(JSON.parse(raw));
    expect(loaded.ok).toBe(true); expect(looksLikeValidAppData(raw)).toBe(true);
    if (loaded.ok) expect(loaded.data.attachmentDrafts).toEqual(two.attachmentDrafts);
    const removed = reducer(two, { type: 'removeAttachmentDraft', conversationId: 'conv_dm_brother', attachmentId: a.id });
    expect(removed.attachmentDrafts?.conv_living_room).toEqual([a]); expect(removed.attachmentDrafts?.conv_dm_brother).toEqual([]);
    expect(store.resolve(a.id).text).toBe('准备开会');
  });
  it('both storage validators reject malformed attachment references instead of silently clearing chats', () => {
    for (const bad of [{ id: '../secret', name: 'file', kind: 'text', size: 3, mimeType: 'text/plain' }, null]) {
      const d = buildEmpty(); (d as any).attachmentDrafts = { conv_living_room: [bad] };
      expect(validateData(d).ok).toBe(false); expect(looksLikeValidAppData(JSON.stringify(d))).toBe(false);
    }
    expect(() => validateData({ messages: {} })).not.toThrow();
  });
  it('builds current text only from the saved same-conversation human message', async () => {
    const a = await store.importFile({ name: '计划.txt', dataBase64: Buffer.from('SECRET_PLAN').toString('base64') });
    const d = buildEmpty(); d.messages = [{ id: 'current', conversationId: 'conv_dm_brother', agentId: 'agent_owner', text: '看看', createdAt: 1000, status: 'sent', demo: false, requestId: null, attachments: [a] }];
    const params = { conversationId: 'conv_dm_brother', currentText: '看看', excludeMessageIds: ['current'] };
    expect(prepareAttachmentContext(d, params, store).currentText).toContain('SECRET_PLAN');
    expect(prepareAttachmentContext(d, { ...params, conversationId: 'conv_dm_worker' }, store).currentText).not.toContain('SECRET_PLAN');
    expect(prepareAttachmentContext(d, { ...params, currentText: '换成另一条' }, store).currentFiles).toHaveLength(0);
  });
  it('sends actual image bytes to API and validated localImage inputs to Codex; other private photos stay excluded', async () => {
    const a = await store.importFile({ name: '照片.png', dataBase64: png.toString('base64') });
    const d = buildEmpty(); d.messages = ['current', 'private'].map((id, i) => ({ id, conversationId: i ? 'conv_dm_worker' : 'conv_dm_brother', agentId: 'agent_owner', text: '照片', createdAt: 1000, status: 'sent' as const, demo: false, requestId: null, attachments: [a] }));
    const prepared = prepareAttachmentContext(d, { conversationId: 'conv_dm_brother', currentText: '照片', excludeMessageIds: ['current'] }, store);
    const wire = applyAttachmentWire({ apiMessages: [{ role: 'user', content: prepared.currentText }], receipt: { preparedSources: [] } }, d, prepared, store);
    expect(wire.apiMessages[0].content.some((p: any) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/jpeg;base64,'))).toBe(true);
    expect(wire.imageInputs.filter((p: any) => p.type === 'localImage')).toHaveLength(1);
    expect(wire.imageInputs.find((p: any) => p.type === 'localImage').path).toBe(path.join(store.dir, a.id + '.jpg'));
    expect(wire.attachmentSources.map((a: any) => a.sourceMessageId)).toEqual(['current']);
  });
  it('reattaches only authorized injected history and respects the four-image bound', async () => {
    const a = await store.importFile({ name: '照片.png', dataBase64: png.toString('base64') });
    const d = buildEmpty(); d.messages = Array.from({ length: 8 }, (_, i) => ({ id: 'm' + i, conversationId: 'conv_living_room', agentId: 'agent_owner', text: '图片', createdAt: i, status: 'sent' as const, demo: false, requestId: null, attachments: [a] }));
    const prepared = prepareAttachmentContext(d, { currentText: '继续', excludeMessageIds: [] }, store);
    const wire = applyAttachmentWire({ apiMessages: [{ role: 'user', content: '继续' }], receipt: { preparedSources: d.messages.map((m, i) => ({ id: m.id, injected: i > 1 })) } }, d, prepared, store);
    expect(wire.imageInputs.filter((a: any) => a.type === 'localImage')).toHaveLength(4);
    expect(wire.attachmentSources.map((a: any) => a.sourceMessageId)).toEqual(['m4', 'm5', 'm6', 'm7']);
  });
});
