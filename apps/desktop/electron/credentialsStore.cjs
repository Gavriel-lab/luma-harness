'use strict';

/**
 * 小屋 · 凭据安全存储管理器（主进程）
 *
 * 核心安全设计与事务保证：
 * 1. 物理隔离：存储于 userData/xiaowu-data/credentials.enc，与普通数据 data.v1.json 物理隔离；
 * 2. Windows DPAPI：使用 Electron safeStorage 加密；若不可用绝不以明文或伪加密落盘；
 * 3. 严格窄桥：渲染进程仅允许 set/delete/has/isAvailable，绝不暴露 getKey 明文读取接口；
 * 4. 事务与失败一致性：写盘前构造新镜像，物理原子替换成功后才更新内存；落盘失败保留旧内存旧文件；
 * 5. 损坏现场保护：既有凭据若损坏或不可读，严禁以空表静默覆写；
 * 6. 操作串行化：所有写盘与修改排入 Promise 链，彻底避免并发竞争；
 * 7. 全局动态脱敏：支持静态特征与运行时动态敏感词列表，杜绝假 Key 或特定供应商格式泄露。
 */
let electronSafeStorage = null;
if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
  try {
    const electron = require('electron');
    electronSafeStorage = electron && electron.safeStorage ? electron.safeStorage : null;
  } catch {
    electronSafeStorage = null;
  }
}

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const CREDENTIALS_DIR_NAME = 'xiaowu-data';
const CREDENTIALS_FILE = 'credentials.enc';
const TEMP_FILE = 'credentials.tmp.enc';

class CredentialsStore {
  constructor(userDataDir, options = {}) {
    if (!userDataDir || typeof userDataDir !== 'string') {
      throw new Error('userDataDir 必须是非空字符串');
    }
    this.safeStorage = options.safeStorage !== undefined ? options.safeStorage : electronSafeStorage;
    this.dir = path.join(userDataDir, CREDENTIALS_DIR_NAME);
    this.filePath = path.join(this.dir, CREDENTIALS_FILE);
    this.tempPath = path.join(this.dir, TEMP_FILE);
    /** 内存中缓存的密文 map: { [ref: string]: string (base64) } */
    this.encryptedMap = new Map();
    this.isLoaded = false;
    this.corrupt = false;
    this.corruptReason = null;
    /** 串行任务队列 */
    this.chain = Promise.resolve();
  }

  isAvailable() {
    try {
      return typeof this.safeStorage?.isEncryptionAvailable === 'function' && this.safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /** 初始化加载既有凭据文件 */
  load() {
    if (this.isLoaded) return;
    try {
      if (!fs.existsSync(this.dir)) {
        fs.mkdirSync(this.dir, { recursive: true });
      }
      if (fs.existsSync(this.filePath)) {
        let raw = '';
        try {
          raw = fs.readFileSync(this.filePath, 'utf8');
        } catch (e) {
          this.corrupt = true;
          this.corruptReason = `既有凭据文件存在但不可读: ${e.message}`;
          console.error('[CredentialsStore]', this.corruptReason);
          this.isLoaded = true;
          return;
        }

        if (raw.trim()) {
          try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error('凭据文件结构不合法');
            }
            for (const [ref, encB64] of Object.entries(parsed)) {
              if (typeof encB64 === 'string') {
                this.encryptedMap.set(ref, encB64);
              }
            }
          } catch (e) {
            this.corrupt = true;
            this.corruptReason = `既有凭据文件损坏解析失败: ${e.message}`;
            console.error('[CredentialsStore]', this.corruptReason);
            this.isLoaded = true;
            return;
          }
        }
      }
    } catch (e) {
      console.error('[CredentialsStore] 初始化异常:', this.sanitizeError(e.message));
    }
    this.isLoaded = true;
  }

  /**
   * 物理原子写盘：写入临时文件并重命名替换目标文件
   * @param {Map<string, string>} mapToPersist
   */
  async _atomicPersist(mapToPersist) {
    await fsp.mkdir(this.dir, { recursive: true });
    const obj = {};
    for (const [k, v] of mapToPersist.entries()) {
      obj[k] = v;
    }
    const jsonStr = JSON.stringify(obj, null, 2);
    try {
      await fsp.writeFile(this.tempPath, jsonStr, 'utf8');
      await fsp.rename(this.tempPath, this.filePath);
    } catch (err) {
      try { await fsp.rm(this.tempPath, { force: true }); } catch {}
      throw err;
    }
  }

  /**
   * 保存或更新某个引用的密钥（事务性，串行执行）
   * @param {string} ref 凭据引用标识，如 'cred_coordinator'
   * @param {string} plainKey 明文密钥
   */
  async setKey(ref, plainKey) {
    this.chain = this.chain.then(async () => {
      this.load();
      if (!ref || typeof ref !== 'string') {
        return { ok: false, reason: '凭据引用 ID 不合法' };
      }
      if (!plainKey || typeof plainKey !== 'string' || !plainKey.trim()) {
        return { ok: false, reason: '密钥不能为空' };
      }
      if (!this.isAvailable()) {
        return { ok: false, reason: '当前系统安全存储不可用（Windows DPAPI 不可用），已拒绝保存明文凭据' };
      }
      if (this.corrupt) {
        return { ok: false, reason: `既有凭据文件处于损坏保护状态，拒绝覆写: ${this.corruptReason}` };
      }

      try {
        const trimmed = plainKey.trim();
        const encBuffer = this.safeStorage.encryptString(trimmed);
        const encB64 = encBuffer.toString('base64');

        // 先构造新镜像
        const nextMap = new Map(this.encryptedMap);
        nextMap.set(ref, encB64);

        // 尝试写盘
        await this._atomicPersist(nextMap);

        // 写盘成功后才更新内存缓存
        this.encryptedMap = nextMap;
        return { ok: true, ref, hasKey: true };
      } catch (e) {
        return { ok: false, reason: `凭据保存失败：${this.sanitizeError(e.message, [plainKey])}` };
      }
    });

    return this.chain;
  }

  /**
   * 获取指定引用的明文密钥（主进程内部网络请求使用，不向渲染端暴露）
   * @param {string} ref
   */
  getKey(ref) {
    this.load();
    if (!ref || !this.encryptedMap.has(ref)) return null;
    if (!this.isAvailable()) {
      throw new Error('当前系统安全存储不可用，无法解密凭据');
    }
    const encB64 = this.encryptedMap.get(ref);
    try {
      const buffer = Buffer.from(encB64, 'base64');
      return this.safeStorage.decryptString(buffer);
    } catch (e) {
      throw new Error(`凭据解密失败（可能当前用户发生变更或凭据已损坏）：${this.sanitizeError(e.message)}`);
    }
  }

  hasKey(ref) {
    this.load();
    if (!ref) return false;
    return this.encryptedMap.has(ref);
  }

  /**
   * 删除某个引用的密钥（事务性，串行执行）
   * @param {string} ref
   */
  async deleteKey(ref) {
    this.chain = this.chain.then(async () => {
      this.load();
      if (!ref) return { ok: false, reason: '缺少引用标识' };
      if (!this.encryptedMap.has(ref)) return { ok: true, deleted: false };
      if (this.corrupt) {
        return { ok: false, reason: `既有凭据文件处于损坏保护状态，拒绝修改: ${this.corruptReason}` };
      }

      try {
        const nextMap = new Map(this.encryptedMap);
        nextMap.delete(ref);

        await this._atomicPersist(nextMap);

        this.encryptedMap = nextMap;
        return { ok: true, deleted: true };
      } catch (e) {
        return { ok: false, reason: `删除凭据失败：${this.sanitizeError(e.message)}` };
      }
    });

    return this.chain;
  }

  listRefs() {
    this.load();
    return Array.from(this.encryptedMap.keys());
  }

  /**
   * 清洗错误文本中的敏感凭据信息
   * @param {string} str
   * @param {string[]} [extraTokens] 本轮请求真实使用的特定密钥或敏感词
   */
  sanitizeError(str, extraTokens = []) {
    if (!str || typeof str !== 'string') return '';
    let out = str
      .replace(/Bearer\s+[A-Za-z0-9_\-./+=]+/gi, 'Bearer [REDACTED]')
      .replace(/sk-[A-Za-z0-9_\-]{8,}/gi, 'sk-[REDACTED]')
      .replace(/key=[A-Za-z0-9_\-]{8,}/gi, 'key=[REDACTED]');

    if (Array.isArray(extraTokens)) {
      for (const token of extraTokens) {
        if (typeof token === 'string' && token.trim().length >= 4) {
          const escaped = token.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          out = out.replace(new RegExp(escaped, 'g'), '[REDACTED]');
        }
      }
    }
    return out;
  }
}

module.exports = { CredentialsStore };
