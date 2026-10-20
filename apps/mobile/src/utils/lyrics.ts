/** LRC 歌词解析：[mm:ss.xx] 文本 → 按时间排好的行，翻译按时间对上 */
export interface LyricLine { time: number; text: string; translation?: string }

const TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
// 网易云歌词开头常带「作词 : xxx」这类信息行，不算正文
const CREDIT = /^\s*(作词|作曲|编曲|制作人|词|曲|混音|母带|录音|和声|吉他|贝斯|鼓|弦乐|监制|出品|发行|OP|SP|Lyricist|Composer|Arranger|Producer)\s*[:：]/i;

function parse(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const times: number[] = [];
    let m: RegExpExecArray | null;
    TAG.lastIndex = 0;
    while ((m = TAG.exec(raw))) {
      const frac = m[3] ? Number(m[3].padEnd(3, '0')) / 1000 : 0;
      times.push(Number(m[1]) * 60 + Number(m[2]) + frac);
    }
    const text = raw.replace(TAG, '').trim();
    if (!times.length || !text) continue;
    times.forEach((time) => lines.push({ time, text }));
  }
  return lines.sort((a, b) => a.time - b.time);
}

export function parseLyrics(lrc: string, tlyric = ''): LyricLine[] {
  const main = parse(lrc).filter((l) => !CREDIT.test(l.text));
  if (tlyric) {
    const map = new Map(parse(tlyric).map((l) => [l.time.toFixed(2), l.text]));
    main.forEach((l) => {
      const tr = map.get(l.time.toFixed(2));
      if (tr && tr !== l.text) l.translation = tr;
    });
  }
  return main;
}

/** 当前该亮哪一行 */
export function activeLineIndex(lines: LyricLine[], t: number): number {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t + 0.2) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
