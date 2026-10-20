// 路径包含校验（Windows 反斜杠与 POSIX 斜杠统一处理）。用于产物目录边界。

import { resolve, sep, isAbsolute } from "node:path";

export function isPathInside(childPath, parentPath) {
  if (!childPath || !parentPath) return false;
  try {
    const c = resolve(childPath);
    const p = resolve(parentPath);
    if (!isAbsolute(c) || !isAbsolute(p)) return false;
    if (c === p) return true;
    return c.startsWith(p.endsWith(sep) ? p : p + sep);
  } catch {
    return false;
  }
}
