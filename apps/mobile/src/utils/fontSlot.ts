import { useEffect, useSyncExternalStore } from 'react';

/**
 * 自定义字体"插槽"：本地上传（TTF/OTF/WOFF/WOFF2）或粘贴字体 CSS。
 * 每个插槽各存各的（IndexedDB），各挂各的 CSS 变量，聊天和日记互不影响。
 */
export type FontRecord = { kind: 'local'; name: string; buffer: ArrayBuffer } | { kind: 'css'; css: string };
export type FontState = { record: FontRecord | null; family: string; busy: boolean; error: string };

export interface FontSlotOptions {
  /** IndexedDB 库名 */
  db: string;
  /** 挂到 <html> 上的 CSS 变量，例如 --chat-bubble-font */
  cssVar: string;
  /** <html data-xxx="custom"> 的 dataset 键 */
  dataKey: string;
  /** FontFace 别名前缀 */
  aliasPrefix: string;
  /** 自定义字体后面跟的兜底字体 */
  fallback: string;
  /** 检查网络字体能不能显示中文用的样字 */
  sample: string;
}

const STORE = 'fonts';

function sourceUrl(value: string, base: string) {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' && !(url.origin === location.origin && url.protocol === 'http:') && !/^data:font\//i.test(value)) throw new Error('字体链接请使用 HTTPS 地址。');
  return url.href;
}
const unquote = (text: string) => text.trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
type Definition = { family: string; source: string; descriptors: FontFaceDescriptors };

async function readCss(css: string, base = location.href, seen = new Set<string>(), depth = 0): Promise<{ definitions: Definition[]; requested: string }> {
  if (depth > 3 || seen.size > 12 || css.length > 1024 * 1024) throw new Error('字体 CSS 太大或重复引用过多，请使用单个字体的引入代码。');
  const imports: string[] = [];
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import\s+(?:url\(\s*(['"]?)(.*?)\1\s*\)|(['"])(.*?)\3)[^;]*;/gi, (_all, _q, url, _q2, plain) => { imports.push(sourceUrl(url || plain, base)); return ''; });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(cleaned);
  const definitions: Definition[] = [];
  let requested = '';
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule.type === CSSRule.FONT_FACE_RULE) {
        const style = (rule as CSSFontFaceRule).style;
        const family = unquote(style.getPropertyValue('font-family'));
        const source = style.getPropertyValue('src').replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_all, _q, url) => `url(${JSON.stringify(sourceUrl(url, base))})`);
        if (family && source) definitions.push({ family, source, descriptors: {
          style: style.getPropertyValue('font-style') || 'normal', weight: style.getPropertyValue('font-weight') || 'normal',
          stretch: style.getPropertyValue('font-stretch') || 'normal', unicodeRange: style.getPropertyValue('unicode-range') || 'U+0-10FFFF', display: 'swap',
        } });
      } else if (rule.type === CSSRule.STYLE_RULE) {
        requested ||= unquote((rule as CSSStyleRule).style.getPropertyValue('font-family').split(',')[0] || '');
      } else if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules);
    }
  };
  walk(sheet.cssRules);
  for (const url of imports) {
    if (seen.has(url)) continue;
    seen.add(url);
    let response: Response;
    try { response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error('字体 CSS 没有下载成功，请检查链接、网络或网站是否允许跨域访问。'); }
    if (!response.ok) throw new Error(`字体 CSS 下载失败（${response.status}），请检查链接。`);
    const nested = await readCss(await response.text(), response.url || url, seen, depth + 1);
    definitions.push(...nested.definitions); requested ||= nested.requested;
  }
  return { definitions, requested };
}

export function createFontSlot(opts: FontSlotOptions) {
  let state: FontState = { record: null, family: '', busy: false, error: '' };
  let activeFaces: FontFace[] = [], serial = 0, initialization: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const notify = (patch: Partial<FontState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };

  // 字体文件放 IndexedDB，localStorage 那点空间装不下
  function storage(operation: 'get' | 'put' | 'delete', value?: FontRecord): Promise<FontRecord | null> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(opts.db, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onerror = () => reject(new Error('无法打开字体存储，请检查浏览器的存储权限。'));
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(STORE, operation === 'get' ? 'readonly' : 'readwrite');
        const store = transaction.objectStore(STORE);
        let result: IDBRequest;
        try { result = operation === 'get' ? store.get('active') : operation === 'put' ? store.put(value, 'active') : store.delete('active'); }
        catch { transaction.abort(); db.close(); reject(new Error('字体尚未保存，可能是手机空间不足。原字体仍保留。')); return; }
        transaction.oncomplete = () => { db.close(); resolve(operation === 'get' ? result.result || null : null); };
        transaction.onabort = () => { db.close(); reject(new Error('字体尚未保存，可能是手机空间不足。原字体仍保留。')); };
        transaction.onerror = () => {}; // 失败统一交给 onabort
      };
    });
  }

  async function prepare(record: FontRecord, alias: string): Promise<{ faces: FontFace[]; family: string }> {
    let faces: FontFace[] = [], family = record.kind === 'local' ? record.name : '';
    if (record.kind === 'local') {
      faces = [new FontFace(alias, record.buffer)];
    } else {
      const css = /^https:\/\/\S+$/i.test(record.css.trim()) ? `@import url(${JSON.stringify(record.css.trim())});` : record.css;
      const parsed = await readCss(css);
      family = parsed.requested || parsed.definitions[0]?.family || '';
      const definitions = parsed.definitions.filter(definition => definition.family.toLowerCase() === family.toLowerCase());
      if (!definitions.length) throw new Error('没有找到可用字体。请粘贴 @import 与 font-family，或完整的 @font-face 代码。');
      if (definitions.length > 512) throw new Error('一次请选择一个字体。');
      faces = definitions.map(definition => new FontFace(alias, definition.source, definition.descriptors));
    }
    try {
      faces.forEach(face => document.fonts.add(face));
      await Promise.race([
        record.kind === 'local' ? faces[0].load() : document.fonts.load(`16px "${alias}"`, opts.sample).then(loaded => { if (!loaded.length) throw new Error('字体未包含预览中的文字。'); }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('字体加载超时，请检查网络后重试。')), 20000)),
      ]);
      return { faces, family };
    } catch (error) {
      faces.forEach(face => document.fonts.delete(face));
      throw error instanceof Error && /字体/.test(error.message) ? error : new Error('字体无法加载，请检查文件是否完整，或字体网站是否允许跨域访问。');
    }
  }
  function activate(faces: FontFace[], alias: string) {
    activeFaces.forEach(face => document.fonts.delete(face)); activeFaces = faces;
    const root = document.documentElement;
    if (alias) {
      root.style.setProperty(opts.cssVar, `"${alias}", ${opts.fallback}`);
      root.dataset[opts.dataKey] = 'custom';
    } else {
      root.style.removeProperty(opts.cssVar); delete root.dataset[opts.dataKey];
    }
  }
  async function initialize() {
    notify({ busy: true });
    try {
      const record = await storage('get');
      if (record) {
        notify({ record });
        const alias = `${opts.aliasPrefix}${++serial}`, prepared = await prepare(record, alias);
        activate(prepared.faces, alias); notify({ record, family: prepared.family });
      }
    } catch (error) { notify({ error: `字体恢复失败：${(error as Error).message}` }); }
    finally { notify({ busy: false }); }
  }
  async function change(record: FontRecord | null) {
    await (initialization ||= initialize());
    if (state.busy) return false;
    notify({ busy: true, error: '' });
    let faces: FontFace[] = [];
    try {
      const alias = record ? `${opts.aliasPrefix}${++serial}` : '';
      const prepared = record ? await prepare(record, alias) : { faces: [], family: '' };
      faces = prepared.faces;
      await storage(record ? 'put' : 'delete', record || undefined);
      activate(faces, alias); notify({ record, family: prepared.family }); return true;
    } catch (error) { faces.forEach(face => document.fonts.delete(face)); notify({ error: (error as Error).message }); return false; }
    finally { notify({ busy: false }); }
  }

  async function upload(file: File) {
    if (!/\.(woff2?|ttf|otf)$/i.test(file.name)) { notify({ error: '请选择 TTF、OTF、WOFF 或 WOFF2 字体文件。' }); return false; }
    if (!file.size || file.size > 30 * 1024 * 1024) { notify({ error: '请选择完整、30 MB 以内的字体文件。' }); return false; }
    try { return await change({ kind: 'local', name: file.name, buffer: await file.arrayBuffer() }); }
    catch { notify({ error: '无法读取这个文件，请重新选择。' }); return false; }
  }
  const applyCss = (css: string) => change({ kind: 'css', css: css.trim() });
  const reset = () => change(null);
  function useFont() {
    const current = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state);
    useEffect(() => { initialization ||= initialize(); }, []);
    return current;
  }
  return { upload, applyCss, reset, useFont, cssVar: opts.cssVar };
}

export type FontSlot = ReturnType<typeof createFontSlot>;
