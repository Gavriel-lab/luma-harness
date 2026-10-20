/** Font CSS is reduced to font faces and a global family; layout rules never enter the page. */
const MAX_CSS = 2_000_000;
const FACE_PROPS = ['font-family', 'src', 'font-weight', 'font-style', 'font-stretch', 'font-display', 'unicode-range', 'font-feature-settings', 'font-variation-settings'];
const IMPORT = /@import\s+(?:url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)|"([^"]+)"|'([^']+)')\s*[^;]*;/gi;

function fontUrl(value: string, base?: string) {
  if (/^data:(?:font\/|application\/(?:font|x-font|octet-stream))[^,]*;base64,/i.test(value)) return value;
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('字体链接需要使用 HTTPS。');
  return url.href;
}

function parse(css: string, base?: string) {
  if (css.length > MAX_CSS) throw new Error('字体 CSS 太长，请换用网站提供的常规 CSS。');
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  const faces: string[] = [];
  let family = '';
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSFontFaceRule) {
        const declarations: string[] = [];
        for (const prop of FACE_PROPS) {
          let value = rule.style.getPropertyValue(prop);
          if (!value) continue;
          if (prop === 'src') {
            value = value.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (_match, a, b, c) => {
              return `url(${JSON.stringify(fontUrl((a ?? b ?? c).trim(), base))})`;
            });
          }
          declarations.push(`${prop}: ${value};`);
        }
        if (rule.style.fontFamily && rule.style.getPropertyValue('src')) faces.push(`@font-face { ${declarations.join(' ')} }`);
      } else if (rule instanceof CSSStyleRule && rule.style.fontFamily) {
        family = rule.style.fontFamily;
      } else if ('cssRules' in rule) {
        visit((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  visit(sheet.cssRules);
  if (!family && faces.length) {
    const first = Array.from(sheet.cssRules).find(rule => rule instanceof CSSFontFaceRule) as CSSFontFaceRule | undefined;
    family = first?.style.fontFamily || '';
  }
  return { faces, family };
}

function globalStyle(faces: string[], family: string) {
  if (!family) throw new Error('没有找到 font-family，请一起复制网站上的 body 字体代码。');
  return `${faces.join('\n')}\n:root { --custom-font-family: ${family}; --font-body: ${family}; --font-title: ${family}; }\nbody, button, input, textarea, select { font-family: ${family}; }`;
}

/** Revalidate persisted CSS as font-only before installing it after restart. */
export function sanitizeFontStyle(css: string) {
  if (!css.trim()) return '';
  const { faces, family } = parse(css);
  return globalStyle(faces, family);
}

export async function compileFontCss(input: string, signal?: AbortSignal) {
  if (!input.trim()) return '';
  if (input.length > 20000) throw new Error('粘贴的 CSS 太长，请使用网站的常规 CSS 代码。');
  const visited = new Set<string>();
  const load = async (css: string, base?: string, depth = 0): Promise<{ faces: string[]; family: string }> => {
    if (depth > 3 || css.length > MAX_CSS) throw new Error('字体引用过多，请换用简单的常规 CSS。');
    const urls: string[] = [];
    const withoutImports = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(IMPORT, (_match, ...parts) => {
      urls.push(fontUrl(parts.slice(0, 5).find(value => typeof value === 'string' && value) as string, base));
      return '';
    });
    const allFaces: string[] = [];
    let inheritedFamily = '';
    for (const url of urls) {
      if (visited.has(url)) continue;
      if (visited.size >= 8) throw new Error('字体引用过多，请换用简单的常规 CSS。');
      visited.add(url);
      const response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error(`字体 CSS 下载失败（${response.status}），请检查链接。`);
      const child = await load(await response.text(), response.url || url, depth + 1);
      allFaces.push(...child.faces);
      inheritedFamily = child.family || inheritedFamily;
    }
    const current = parse(withoutImports, base);
    return { faces: [...allFaces, ...current.faces], family: current.family || inheritedFamily };
  };
  const { faces, family } = await load(input);
  const style = globalStyle(faces, family);
  if (style.length > MAX_CSS) throw new Error('字体 CSS 太长，请换用较小的版本。');
  return style;
}
