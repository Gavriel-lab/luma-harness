import fs from 'node:fs';
import path from 'node:path';
import {
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition
} from '@earendil-works/pi-coding-agent';

/**
 * 敏感文件模式黑名单
 */
const SECRET_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /credentials/i,
  /token/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.age$/i
];

const PROTECTED_DIRS_LOWER = new Set([
  '.git',
  '.kiro',
  '.opencode',
  '.pi',
  'node_modules',
  'xiaowu-data'
]);

// Windows 特殊设备名与保留名
const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

function normalizeWindowsDrive(p) {
  const resolved = path.resolve(p);
  if (/^[a-zA-Z]:/.test(resolved)) {
    return resolved[0].toUpperCase() + resolved.slice(1);
  }
  return resolved;
}

/**
 * 校验相对于批准根目录的路径片段是否合法（防越界、受保护目录、系统保留名与敏感文件名）
 * @param {string} relativeToRoot 相对于 realRoot 的相对路径
 * @param {string} [checkFileName] 需要额外检查的最终目标文件名（可选）
 * @returns {{ safe: boolean, reason?: string }}
 */
function inspectRelativeSecurity(relativeToRoot, checkFileName) {
  if (typeof relativeToRoot !== 'string') {
    return { safe: false, reason: '相对路径格式无效' };
  }
  const normalizedRel = path.normalize(relativeToRoot);
  if (normalizedRel.startsWith('..') || path.isAbsolute(normalizedRel)) {
    return { safe: false, reason: '[安全拦截] 越界拒绝：目标路径位于批准工作目录之外' };
  }

  // 拆分路径片段并进行大小写不敏感检查
  const parts = normalizedRel.split(/[\\/]/).filter((p) => p && p !== '.');
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (PROTECTED_DIRS_LOWER.has(lower)) {
      return { safe: false, reason: `[安全拦截] 禁止访问受保护目录: ${part}` };
    }
    const nameWithoutExt = lower.split('.')[0];
    if (WINDOWS_RESERVED_NAMES.has(nameWithoutExt)) {
      return { safe: false, reason: `[安全拦截] 非法系统保留名称: ${part}` };
    }
  }

  // 检查敏感文件名（包含末尾片段以及显式传入的 checkFileName）
  const candidates = [];
  if (parts.length > 0) {
    candidates.push(parts[parts.length - 1]);
  }
  if (checkFileName && typeof checkFileName === 'string') {
    candidates.push(path.basename(checkFileName));
  }
  for (const fn of candidates) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(fn)) {
        return { safe: false, reason: `[安全拦截] 敏感保护：该文件属于受保护的密钥或配置文件 (${fn})` };
      }
    }
  }

  return { safe: true };
}

/**
 * 严格校验文件路径是否在批准的受控工作目录内
 * @param {string} approvedWorkspace 批准工作目录绝对路径
 * @param {string} targetPath 目标文件路径（绝对或相对）
 * @param {object} [options]
 * @param {'read'|'write'|'edit'|'mkdir'} [options.mode='read'] 操作模式
 * @returns {{ allowed: boolean, realPath?: string, relativePath?: string, reason?: string }}
 */
export function validateControlledPath(approvedWorkspace, targetPath, options = {}) {
  const mode = options.mode || 'read';

  if (!approvedWorkspace || typeof approvedWorkspace !== 'string') {
    return { allowed: false, reason: '未配置批准工作目录' };
  }
  if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
    return { allowed: false, reason: '未指定目标文件路径' };
  }

  let realRoot;
  try {
    realRoot = normalizeWindowsDrive(fs.realpathSync(approvedWorkspace));
  } catch {
    return { allowed: false, reason: `批准工作目录不存在或无法解析: ${approvedWorkspace}` };
  }

  // 1. 防御 NTFS 额外数据流 (Alternate Data Streams) 与异常冒号（排除 Windows 盘符如 C:）
  const strippedDrive = targetPath.replace(/^[a-zA-Z]:[\\/]/, '');
  if (strippedDrive.includes(':')) {
    return { allowed: false, reason: `[安全拦截] 非法路径格式：禁止使用包含数据流冒号的路径 (${targetPath})` };
  }

  // 2. 解析逻辑目标路径
  const normalizedTarget = path.normalize(targetPath);
  const resolved = normalizeWindowsDrive(
    path.isAbsolute(normalizedTarget)
      ? normalizedTarget
      : path.resolve(realRoot, normalizedTarget)
  );

  // 3. 逻辑越界与安全检查（包含受保护目录、系统保留名与敏感文件正则）
  const relative = path.relative(realRoot, resolved);
  const logicCheck = inspectRelativeSecurity(relative, path.basename(resolved));
  if (!logicCheck.safe) {
    return { allowed: false, reason: logicCheck.reason };
  }

  // 4. 分模式严格校验物理落点与别名跳出
  if (mode === 'write') {
    const fileName = path.basename(resolved);

    // 检查最近存在祖先目录的真实物理路径，防御软链接跳出或别名注入受保护目录
    let curr = path.dirname(resolved);
    while (!fs.existsSync(curr) && curr !== path.dirname(curr)) {
      curr = path.dirname(curr);
    }

    let realCurr;
    try {
      realCurr = normalizeWindowsDrive(fs.realpathSync(curr));
    } catch (err) {
      return { allowed: false, reason: `无法解析父级物理路径: ${err.message}` };
    }

    const remainder = path.relative(curr, resolved);
    const projectedRealFile = normalizeWindowsDrive(path.resolve(realCurr, remainder));
    const projectedRealRel = path.relative(realRoot, projectedRealFile);

    // 物理真实预期路径的安全与越界检查
    const physicalCheck = inspectRelativeSecurity(projectedRealRel, fileName);
    if (!physicalCheck.safe) {
      return { allowed: false, reason: physicalCheck.reason };
    }

    // 新建文件模式：目标已存在必须明确拒绝覆盖，强制提示使用 edit
    if (fs.existsSync(resolved) || fs.existsSync(projectedRealFile)) {
      return {
        allowed: false,
        reason: `[安全拦截] 目标文件已存在 (${fileName})：write 工具仅用于创建新文件，禁止覆盖已有文件。若需修改既有文件请使用 edit 工具。`
      };
    }

    return { allowed: true, realPath: resolved, relativePath: relative, projectedRealFile };
  }

  if (mode === 'mkdir') {
    let curr = resolved;
    while (!fs.existsSync(curr) && curr !== path.dirname(curr)) {
      curr = path.dirname(curr);
    }
    let realCurr;
    try {
      realCurr = normalizeWindowsDrive(fs.realpathSync(curr));
    } catch (err) {
      return { allowed: false, reason: `无法解析父级目录: ${err.message}` };
    }
    const remainder = path.relative(curr, resolved);
    const projectedRealDir = normalizeWindowsDrive(path.resolve(realCurr, remainder));
    const projectedRealRel = path.relative(realRoot, projectedRealDir);

    const physicalCheck = inspectRelativeSecurity(projectedRealRel, path.basename(resolved));
    if (!physicalCheck.safe) {
      return { allowed: false, reason: physicalCheck.reason };
    }
    return { allowed: true, realPath: resolved, relativePath: relative, projectedRealDir };
  }

  // read 与 edit 模式：文件必须切实存在且为常规文件
  if (!fs.existsSync(resolved)) {
    return { allowed: false, reason: `文件不存在: ${targetPath}` };
  }

  let realFile;
  try {
    realFile = normalizeWindowsDrive(fs.realpathSync(resolved));
  } catch (err) {
    return { allowed: false, reason: `路径解析失败: ${err.message}` };
  }

  try {
    const stat = fs.statSync(realFile);
    if (!stat.isFile()) {
      return { allowed: false, reason: '受控操作仅允许常规文件，禁止读取/修改目录或特殊设备' };
    }
  } catch (err) {
    return { allowed: false, reason: `读取文件元信息失败: ${err.message}` };
  }

  const realRel = path.relative(realRoot, realFile);
  const physicalCheck = inspectRelativeSecurity(realRel, path.basename(realFile));
  if (!physicalCheck.safe) {
    return { allowed: false, reason: physicalCheck.reason };
  }

  return { allowed: true, realPath: realFile, relativePath: realRel };
}

/**
 * 创建受控只读工具定义 (供 Pi SDK 注入使用)
 */
export function createSecureReadToolDefinition(approvedWorkspace) {
  const base = createReadToolDefinition(approvedWorkspace);
  const origExecute = base.execute;

  base.name = 'read';
  base.label = 'read';
  base.description = '受控文件读取工具：仅允许读取指定批准工作目录内的常规文件。';
  base.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
    const filePath = params?.path;
    const check = validateControlledPath(approvedWorkspace, filePath, { mode: 'read' });
    if (!check.allowed) {
      throw new Error(check.reason);
    }
    return await origExecute.call(base, toolCallId, { ...params, path: check.realPath }, signal, onUpdate, ctx);
  };

  return base;
}

/**
 * 创建受控新建文件工具定义 (供 Pi SDK 注入使用)
 */
export function createSecureWriteToolDefinition(approvedWorkspace) {
  const base = createWriteToolDefinition(approvedWorkspace, {
    operations: {
      writeFile: async (filePath, content) => {
        const check = validateControlledPath(approvedWorkspace, filePath, { mode: 'write' });
        if (!check.allowed) {
          throw new Error(check.reason);
        }
        const dir = path.dirname(filePath);
        const tmpPath = path.join(dir, `.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
        await fs.promises.writeFile(tmpPath, content, 'utf8');
        try {
          // 原子排他发布：在同一卷上使用 hard link 发布到目标路径
          // 1. 若目标已存在，底层原子拒绝并抛出 EEXIST，绝不覆盖已有文件；
          // 2. 若目标不存在，目录项创建时数据已完整就绪，不会出现 0 字节或部分写入的中间可见态。
          await fs.promises.link(tmpPath, filePath);
        } catch (linkErr) {
          // 提交失败：无论何种错误均清理本次调用的临时文件，并完整保全外部已有文件
          try { await fs.promises.unlink(tmpPath); } catch {}
          if (linkErr.code === 'EEXIST') {
            const fileName = path.basename(filePath);
            throw new Error(`[安全拦截] 目标文件已存在 (${fileName})：write 工具仅用于创建新文件，禁止覆盖已有文件。若需修改既有文件请使用 edit 工具。`);
          }
          throw linkErr;
        }

        // 提交成功后移除临时链接：
        // 目标文件已完整、不可逆地发布成功，若清理临时文件发生异常，不应使成功操作误报为失败
        try {
          await fs.promises.unlink(tmpPath);
        } catch (cleanErr) {
          console.warn(`[Pi Write] 临时文件清理失败 (${tmpPath}): ${cleanErr.message}`);
        }
      },
      mkdir: async (dirPath) => {
        const check = validateControlledPath(approvedWorkspace, dirPath, { mode: 'mkdir' });
        if (!check.allowed) {
          throw new Error(check.reason);
        }
        await fs.promises.mkdir(dirPath, { recursive: true });
      }
    }
  });

  base.name = 'write';
  base.label = 'write';
  base.description = '受控新建文件：仅用于在批准工作目录下创建新的 UTF-8 文本文件及必要子目录。若目标文件已存在将明确拒绝覆盖，修改既有文件必须使用 edit 工具。';
  base.promptSnippet = 'Create new UTF-8 text files';
  base.promptGuidelines = ['Use write only for creating new files. If the file already exists, use edit instead.'];

  return base;
}

/**
 * 创建受控精确编辑工具定义 (供 Pi SDK 注入使用)
 */
export function createSecureEditToolDefinition(approvedWorkspace) {
  const base = createEditToolDefinition(approvedWorkspace, {
    operations: {
      access: async (filePath) => {
        const check = validateControlledPath(approvedWorkspace, filePath, { mode: 'edit' });
        if (!check.allowed) {
          throw new Error(check.reason);
        }
        await fs.promises.access(check.realPath, fs.constants.R_OK | fs.constants.W_OK);
      },
      readFile: async (filePath) => {
        const check = validateControlledPath(approvedWorkspace, filePath, { mode: 'edit' });
        if (!check.allowed) {
          throw new Error(check.reason);
        }
        return await fs.promises.readFile(check.realPath);
      },
      writeFile: async (filePath, content) => {
        const check = validateControlledPath(approvedWorkspace, filePath, { mode: 'edit' });
        if (!check.allowed) {
          throw new Error(check.reason);
        }
        const dir = path.dirname(check.realPath);
        const tmpPath = path.join(dir, `.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
        await fs.promises.writeFile(tmpPath, content, 'utf8');
        try {
          await fs.promises.rename(tmpPath, check.realPath);
        } catch (err) {
          try { await fs.promises.unlink(tmpPath); } catch {}
          throw err;
        }
      }
    }
  });

  base.name = 'edit';
  base.label = 'edit';
  base.description = '受控精准编辑：修改批准工作目录下已存在的文本文件，必须精确匹配 edits[].oldText。若找不到匹配、匹配不唯一或有冲突将失败并保持原文件不变。';
  base.promptSnippet = 'Make precise file edits with exact text replacement';
  base.promptGuidelines = [
    'Use edit for precise changes to existing files (edits[].oldText must match exactly).',
    'Each edits[].oldText must be unique in the original file.',
    'Do not use write to overwrite existing files; use edit instead.'
  ];

  return base;
}

/**
 * 兼容旧测试与独立调用的受控只读工具函数
 */
export function createControlledReadTool(approvedWorkspace, options = {}) {
  const maxBytes = options.maxBytes || 65536;

  return {
    name: 'read_file',
    description: '受控文件读取工具：仅允许读取指定批准测试目录内的常规文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要读取的文件相对路径或绝对路径' }
      },
      required: ['path']
    },
    execute: async (...args) => {
      // 提取 targetPath
      let targetPath = '';
      if (args.length === 1 && typeof args[0] === 'object') {
        targetPath = args[0]?.path;
      } else if (args.length >= 2 && typeof args[1] === 'object') {
        targetPath = args[1]?.path;
      }

      const check = validateControlledPath(approvedWorkspace, targetPath, { mode: 'read' });
      if (!check.allowed) {
        return { ok: false, error: check.reason, content: check.reason };
      }

      try {
        const stat = fs.statSync(check.realPath);
        const readLength = Math.min(stat.size, maxBytes);
        const fd = fs.openSync(check.realPath, 'r');
        const buffer = Buffer.alloc(readLength);
        try {
          fs.readSync(fd, buffer, 0, readLength, 0);
        } finally {
          fs.closeSync(fd);
        }

        const text = buffer.toString('utf8');
        const truncated = stat.size > maxBytes;
        return {
          ok: true,
          path: check.relativePath,
          realPath: check.realPath,
          size: stat.size,
          truncated,
          content: text + (truncated ? `\n...[已截断：文件总大小 ${stat.size} 字节，超出 ${maxBytes} 字节上限]...` : '')
        };
      } catch (err) {
        return { ok: false, error: `读取文件失败: ${err.message}` };
      }
    }
  };
}

/**
 * 兼容测试与调用的受控新建文件工具
 */
export function createControlledWriteTool(approvedWorkspace) {
  const def = createSecureWriteToolDefinition(approvedWorkspace);
  return {
    ...def,
    execute: async (...args) => {
      if (args.length === 1 && typeof args[0] === 'object') {
        const input = args[0];
        const res = await def.execute('tool_direct_write', input);
        return { ok: true, content: res.content?.[0]?.text };
      }
      return def.execute(...args);
    }
  };
}

/**
 * 兼容测试与调用的受控精确编辑工具
 */
export function createControlledEditTool(approvedWorkspace) {
  const def = createSecureEditToolDefinition(approvedWorkspace);
  return {
    ...def,
    execute: async (...args) => {
      if (args.length === 1 && typeof args[0] === 'object') {
        const input = args[0];
        const res = await def.execute('tool_direct_edit', input);
        return { ok: true, content: res.content?.[0]?.text };
      }
      return def.execute(...args);
    }
  };
}

export {
  createSecureRunToolDefinition,
  createControlledRunTool,
  sanitizeOutput
} from './run-tool.mjs';
