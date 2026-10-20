'use strict';

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Luma 阁楼书房服务 (StudyService)
 * 
 * 核心机制（工单硬规矩）：
 * 1. 独立文件存储：存储于 userData/xiaowu-data/study/{bookId}.json 及 settings.json，不污染主数据；
 * 2. 心跳轻量去处：心跳醒来时“只问一句能不能写，去了才读正文”，绝不把整本书塞给所有人；
 * 3. 参与者识别：按运行时成员配置与已登记执行器识别，不预设团队人数；
 * 4. 握笔锁 (Pen Lock)：
 *    - 去写的人先拿笔，别人看到「X 正在写」；
 *    - 笔 10 分钟自动超时放回，防止断线卡死；
 * 5. 接龙规则：
 *    - 不连写：刚写完的人下一段不能是他，至少隔一个人；
 *    - 使用者优先：使用者动笔时所有人暂停接写；
 *    - 字数限制：每段 800–2000 字，每人每本 10000 字封顶；
 *    - 结尾归使用者：成员可在段落中表达「可以收了」，但合上书必须使用者亲自操作；
 * 6. 墨迹未干（审稿机制）：
 *    - 新段写完进入「墨迹未干」状态，期间他人不能接；
 *    - 使用者划线批注，叫醒作者改二稿，原稿保留；
 *    - 默认 30 分钟墨干自动放行（或审稿模式开启下必须使用者点「墨干了」放行）；
 * 7. 开关与隔离：
 *    - 书房总开关、每本书「暂时搁笔」开关；
 *    - 失败绝不拿模板兜底冒充，失败即本次未写。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STUDY_DIR_NAME = 'study';
const SETTINGS_FILE = 'settings.json';
const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟握笔超时
const DEFAULT_INK_DRY_MS = 30 * 60 * 1000; // 30 分钟墨水自然干
const MAX_WORDS_PER_AUTHOR = 30000; // 单人单本字数封顶（工单放宽至 30000 字）
const MIN_SECTION_WORDS = 1500; // 每段下限 1500 字（工单放宽至 1500–3000）
const MAX_SECTION_WORDS = 3000; // 每段上限 3000 字
const LONG_BOOK_THRESHOLD_WORDS = 12000; // 超过 12000 字转为前情提要模式

class StudyService {
  constructor({ userDataDir, getData, startChat, stopChat, isBusy = () => false, now = () => Date.now() }) {
    if (!userDataDir || typeof userDataDir !== 'string') {
      throw new Error('userDataDir 必须是非空字符串');
    }
    this.userDataDir = userDataDir;
    this.getData = typeof getData === 'function' ? getData : () => null;
    this.startChat = startChat;
    this.stopChat = stopChat;
    this.isBusy = isBusy;
    this.now = now;

    this.studyDir = path.join(this.userDataDir, 'xiaowu-data', STUDY_DIR_NAME);
    this._ensureDir(this.studyDir);

    this.settingsPath = path.join(this.studyDir, SETTINGS_FILE);
    this.activeLock = null; // { bookId, authorId, executorId, acquiredAt, expiresAt, isOwner }
    this.activeGeneration = null; // 当前正在进行的后台续写任务
  }

  _ensureDir(dir) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.warn(`[StudyService] 创建目录失败: ${dir}`, err.message);
    }
  }

  _readJson(filePath, fallback = null) {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      console.warn(`[StudyService] 读取 JSON 失败: ${filePath}`, e.message);
      return fallback;
    }
  }

  _writeJson(filePath, data) {
    try {
      const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tempPath, filePath);
      return true;
    } catch (e) {
      console.error(`[StudyService] 写入 JSON 失败: ${filePath}`, e.message);
      return false;
    }
  }

  // --- 设置管理 ---

  getSettings() {
    const defaults = {
      enabled: true,
      reviewMode: false, // 审稿模式：为 true 时每段必须使用者点「墨干了」才能接
      inkDryMinutes: 30, // 默认 30 分钟
    };
    const saved = this._readJson(this.settingsPath, {});
    return { ...defaults, ...saved };
  }

  updateSettings(patch = {}) {
    const current = this.getSettings();
    const updated = {
      ...current,
      ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
      ...(typeof patch.reviewMode === 'boolean' ? { reviewMode: patch.reviewMode } : {}),
      ...(typeof patch.inkDryMinutes === 'number' && patch.inkDryMinutes > 0 ? { inkDryMinutes: patch.inkDryMinutes } : {}),
    };
    this._writeJson(this.settingsPath, updated);
    return updated;
  }

  // --- 书籍列表与读取 ---

  _bookPath(bookId) {
    const safeId = String(bookId).replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.studyDir, `${safeId}.json`);
  }

  getBooks() {
    const list = [];
    try {
      const files = fs.readdirSync(this.studyDir);
      for (const file of files) {
        if (!file.endsWith('.json') || file === SETTINGS_FILE) continue;
        const b = this._readJson(path.join(this.studyDir, file));
        if (b && b.id && b.title) {
          list.push({
            id: b.id,
            title: b.title,
            motif: b.motif || '', // 题签
            status: b.status || 'writing', // 'writing' | 'paused' | 'closed'
            sectionCount: Array.isArray(b.sections) ? b.sections.length : 0,
            wordCount: Array.isArray(b.sections) ? b.sections.reduce((sum, s) => sum + (s.text?.length || 0), 0) : 0,
            lastAuthorId: b.sections?.at(-1)?.authorId || null,
            lastAuthorName: b.sections?.at(-1)?.authorName || null,
            updatedAt: b.updatedAt || b.createdAt || 0,
            createdAt: b.createdAt || 0,
          });
        }
      }
    } catch (err) {
      console.warn('[StudyService] 读取书单失败:', err.message);
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  }

  getBook(bookId) {
    this._cleanExpiredLock();
    const b = this._readJson(this._bookPath(bookId));
    if (!b) return null;

    // 检查并更新当前书籍段落的墨干状态
    this._updateInkDryState(b);

    const lock = this.activeLock?.bookId === bookId ? this.activeLock : null;
    return {
      ...b,
      currentLock: lock ? {
        authorId: lock.authorId,
        authorName: lock.authorName,
        isOwner: lock.isOwner,
        acquiredAt: lock.acquiredAt,
        expiresInSeconds: Math.max(0, Math.round((lock.expiresAt - this.now()) / 1000)),
      } : null,
    };
  }

  // --- 握笔锁 (Pen Lock) ---

  _cleanExpiredLock() {
    if (!this.activeLock) return;
    if (this.now() >= this.activeLock.expiresAt) {
      console.log(`[StudyService] 握笔锁自动过期释放: ${this.activeLock.authorName || this.activeLock.authorId}`);
      this.activeLock = null;
    }
  }

  acquireLock({ bookId, authorId, authorName, executorId, isOwner = false }) {
    this._cleanExpiredLock();
    const settings = this.getSettings();
    if (!settings.enabled) return { ok: false, reason: '书房当前已歇笔（开关已关闭）' };

    const book = this._readJson(this._bookPath(bookId));
    if (!book) return { ok: false, reason: '未找到这本书' };
    if (book.status === 'paused') return { ok: false, reason: '本书已暂时搁笔' };
    if (book.status === 'closed') return { ok: false, reason: '此书已合上结卷' };

    // 检查是否有被驳回重写的段落
    this._updateInkDryState(book);
    const rewriteSec = book.sections?.find(s => s.needsRewrite);
    if (rewriteSec) {
      if (!isOwner && rewriteSec.authorId !== authorId) {
        return { ok: false, reason: `《${book.title}》正在等待${rewriteSec.authorName}按批注重写改稿` };
      }
    } else {
      // 无驳回时，基于可见段落检查墨迹未干与不连写
      const visibleSections = book.sections?.filter(s => !s.hidden) || [];
      const lastSection = visibleSections.at(-1);
      if (lastSection && lastSection.inkWet && !isOwner) {
        return { ok: false, reason: '上一段墨迹未干，稍后再来接' };
      }
      if (!isOwner && lastSection && lastSection.authorId === authorId) {
        return { ok: false, reason: '你刚写完上一段，至少隔一位家人才能续写哦' };
      }
    }

    // 检查字数封顶规则
    if (!isOwner) {
      const authoredWords = (book.sections || [])
        .filter(s => s.authorId === authorId)
        .reduce((sum, s) => sum + (s.text?.length || 0), 0);
      if (authoredWords >= MAX_WORDS_PER_AUTHOR) {
        return { ok: false, reason: `你在本书已写满 ${authoredWords} 字（上限 ${MAX_WORDS_PER_AUTHOR} 字），请等使用者开新卷` };
      }
    }

    // 握笔锁冲突判断
    if (this.activeLock && this.activeLock.bookId === bookId) {
      if (this.activeLock.authorId === authorId) {
        // 同一人续期
        this.activeLock.expiresAt = this.now() + LOCK_TIMEOUT_MS;
        return { ok: true, lock: this.activeLock };
      }
      if (isOwner) {
        // 使用者优先：使用者动笔打断他人握笔锁
        console.log(`[StudyService] 使用者动笔，优先接管握笔锁（原持有者: ${this.activeLock.authorName}）`);
      } else {
        return {
          ok: false,
          reason: `${this.activeLock.authorName || '有人'}正在握笔撰写中，请稍候`,
          holder: this.activeLock.authorName,
          expiresInSeconds: Math.max(0, Math.round((this.activeLock.expiresAt - this.now()) / 1000)),
        };
      }
    }

    const lock = {
      bookId,
      authorId,
      authorName: authorName || authorId,
      executorId: executorId || null,
      isOwner,
      acquiredAt: this.now(),
      expiresAt: this.now() + LOCK_TIMEOUT_MS,
    };
    this.activeLock = lock;
    return { ok: true, lock };
  }

  releaseLock({ bookId, authorId, force = false }) {
    if (!this.activeLock) return { ok: true };
    if (this.activeLock.bookId === bookId && (this.activeLock.authorId === authorId || force)) {
      this.activeLock = null;
      return { ok: true };
    }
    return { ok: false, reason: '非握笔者无权释放锁' };
  }

  // --- 墨水与审稿状态维护 ---

  _updateInkDryState(book) {
    if (!book || !Array.isArray(book.sections)) return;
    const settings = this.getSettings();
    const dryTimeMs = (settings.inkDryMinutes || 30) * 60 * 1000;
    const nowMs = this.now();
    let dirty = false;

    for (const sec of book.sections) {
      if (sec.inkWet) {
        if (!settings.reviewMode && (nowMs - sec.createdAt >= dryTimeMs)) {
          sec.inkWet = false;
          sec.inkDriedAt = nowMs;
          dirty = true;
        }
      }
    }
    if (dirty) {
      this._writeJson(this._bookPath(book.id), book);
    }
  }

  // --- 使用者操作：开新书、合上、搁笔、放行墨干 ---

  createBook({ title, motif, firstSectionText = '', authorName = '使用者' }) {
    if (!title || !title.trim()) throw new Error('书名不能为空');
    const bookId = 'book_' + crypto.randomUUID().slice(0, 8);
    const nowMs = this.now();
    const sections = [];

    if (firstSectionText && firstSectionText.trim()) {
      sections.push({
        id: 'sec_' + crypto.randomUUID().slice(0, 8),
        authorId: 'agent_owner',
        authorName,
        text: firstSectionText.trim(),
        createdAt: nowMs,
        inkWet: false, // 使用者亲笔第一段默认墨干
        revisions: [],
        notes: [],
      });
    }

    const newBook = {
      id: bookId,
      title: title.trim(),
      motif: (motif || '').trim(), // 题签
      status: 'writing',
      createdAt: nowMs,
      updatedAt: nowMs,
      sections,
    };

    this._writeJson(this._bookPath(bookId), newBook);
    return newBook;
  }

  setBookStatus({ bookId, status }) {
    if (!['writing', 'paused', 'closed'].includes(status)) throw new Error('非法书籍状态');
    const book = this._readJson(this._bookPath(bookId));
    if (!book) throw new Error('未找到该书籍');
    book.status = status;
    book.updatedAt = this.now();
    this._writeJson(this._bookPath(bookId), book);
    return book;
  }

  markInkDry({ bookId, sectionId }) {
    const book = this._readJson(this._bookPath(bookId));
    if (!book) throw new Error('未找到该书籍');
    const sec = book.sections?.find(s => s.id === sectionId);
    if (!sec) throw new Error('未找到指定段落');
    sec.inkWet = false;
    sec.inkDriedAt = this.now();
    book.updatedAt = this.now();
    this._writeJson(this._bookPath(bookId), book);
    return { ok: true, section: sec };
  }

  // --- 隐藏、打回重写、批注与改稿 ---

  setSectionHidden({ bookId, sectionId, hidden = true }) {
    const book = this._readJson(this._bookPath(bookId));
    if (!book) throw new Error('未找到该书籍');
    const sec = book.sections?.find(s => s.id === sectionId);
    if (!sec) throw new Error('未找到指定段落');
    sec.hidden = Boolean(hidden);
    book.updatedAt = this.now();
    this._writeJson(this._bookPath(bookId), book);
    return { ok: true, section: sec, book };
  }

  requestSectionRewrite({ bookId, sectionId, reason = '' }) {
    const book = this._readJson(this._bookPath(bookId));
    if (!book) throw new Error('未找到该书籍');
    const sec = book.sections?.find(s => s.id === sectionId);
    if (!sec) throw new Error('未找到指定段落');
    if (sec.authorId === 'agent_owner') {
      throw new Error('使用者亲笔段落无需打回重写，可在手稿上直接编辑修改');
    }
    sec.needsRewrite = true;
    sec.rewriteReason = String(reason || '').trim();
    sec.rewriteRequestedAt = this.now();
    sec.inkWet = false;
    if (sec.rewriteReason) {
      if (!Array.isArray(sec.notes)) sec.notes = [];
      sec.notes.push({
        id: 'note_' + crypto.randomUUID().slice(0, 8),
        quote: '【掌柜打回修改意见】',
        comment: sec.rewriteReason,
        createdAt: this.now(),
      });
    }
    book.updatedAt = this.now();
    this._writeJson(this._bookPath(bookId), book);
    return { ok: true, section: sec, book };
  }

  cancelSectionRewrite({ bookId, sectionId }) {
    const book = this._readJson(this._bookPath(bookId));
    if (!book) throw new Error('未找到该书籍');
    const sec = book.sections?.find(s => s.id === sectionId);
    if (!sec) throw new Error('未找到指定段落');
    sec.needsRewrite = false;
    delete sec.rewriteReason;
    delete sec.rewriteRequestedAt;
    book.updatedAt = this.now();
    this._writeJson(this._bookPath(bookId), book);
    return { ok: true, section: sec, book };
  }

  addAnnotation({ bookId, sectionId, quote, comment }) {
    const book = this._readJson(this._bookPath(bookId));
    if (!book) throw new Error('未找到该书籍');
    const sec = book.sections?.find(s => s.id === sectionId);
    if (!sec) throw new Error('未找到指定段落');

    const note = {
      id: 'note_' + crypto.randomUUID().slice(0, 8),
      quote: String(quote || '').trim(),
      comment: String(comment || '').trim(),
      createdAt: this.now(),
    };
    if (!Array.isArray(sec.notes)) sec.notes = [];
    sec.notes.push(note);
    book.updatedAt = this.now();
    this._writeJson(this._bookPath(bookId), book);
    return { ok: true, note, section: sec };
  }

  submitRevision({ bookId, sectionId, revisedText, authorId, isOwner = false }) {
    const book = this._readJson(this._bookPath(bookId));
    if (!book) throw new Error('未找到该书籍');
    const sec = book.sections?.find(s => s.id === sectionId);
    if (!sec) throw new Error('未找到指定段落');

    if (sec.authorId !== authorId && !isOwner) {
      throw new Error('字只能作者本人修改，原稿与署名受保护');
    }

    if (!Array.isArray(sec.revisions)) sec.revisions = [];
    // 将现存稿存入 revision 历史
    sec.revisions.push({
      text: sec.text,
      savedAt: this.now(),
    });

    sec.text = revisedText.trim();
    sec.updatedAt = this.now();
    if (sec.needsRewrite) {
      sec.needsRewrite = false;
      delete sec.rewriteReason;
      delete sec.rewriteRequestedAt;
    }
    // 使用者修改开篇或自己的段落时，保持干墨，不阻碍其他人接写
    if (sec.authorId === 'agent_owner' || isOwner) {
      sec.inkWet = false;
    } else {
      sec.inkWet = true;
    }
    book.updatedAt = this.now();
    this._writeJson(this._bookPath(bookId), book);
    const sectionIndex = book.sections.findIndex(s => s.id === sectionId) + 1;
    return { ok: true, section: sec, sectionIndex };
  }

  // --- 心跳醒来问询口（轻量） ---

  canHeartbeatWrite(authorId) {
    this._cleanExpiredLock();
    const settings = this.getSettings();
    if (!settings.enabled) return { canWrite: false, statusText: '书房已暂时歇笔' };

    // 找最近一本正在撰写的书
    const books = this.getBooks().filter(b => b.status === 'writing');
    if (!books.length) return { canWrite: false, statusText: '书房暂无正在接力的书' };

    const currentBook = books[0];
    const fullBook = this._readJson(this._bookPath(currentBook.id));
    this._updateInkDryState(fullBook);

    // 握笔锁检查
    if (this.activeLock && this.activeLock.bookId === currentBook.id) {
      return {
        canWrite: false,
        statusText: `书房：《${currentBook.title}》${this.activeLock.authorName}正在写`,
        bookId: currentBook.id,
      };
    }

    // 检查是否有被驳回重写的段落（重写优先于接龙）
    const rewriteSec = fullBook.sections?.find(s => s.needsRewrite);
    if (rewriteSec) {
      const rewriteIndex = fullBook.sections.findIndex(s => s.id === rewriteSec.id) + 1;
      if (rewriteSec.authorId === authorId) {
        return {
          canWrite: true,
          isRewrite: true,
          rewriteSectionId: rewriteSec.id,
          rewriteSectionIndex: rewriteIndex,
          statusText: `书房：《${currentBook.title}》第${rewriteIndex}折被掌柜打回，等待按批注重写`,
          bookId: currentBook.id,
          title: currentBook.title,
        };
      } else {
        return {
          canWrite: false,
          statusText: `书房：《${currentBook.title}》正在等待${rewriteSec.authorName}按批注重写改稿`,
          bookId: currentBook.id,
        };
      }
    }

    const visibleSections = fullBook.sections?.filter(s => !s.hidden) || [];
    const lastSec = visibleSections.at(-1);
    if (lastSec && lastSec.inkWet) {
      return {
        canWrite: false,
        statusText: `书房：《${currentBook.title}》墨迹未干，静待字干`,
        bookId: currentBook.id,
      };
    }

    if (lastSec && lastSec.authorId === authorId) {
      return {
        canWrite: false,
        statusText: `书房：《${currentBook.title}》刚由你写完，等待他人接力`,
        bookId: currentBook.id,
      };
    }

    const words = (fullBook.sections || [])
      .filter(s => s.authorId === authorId)
      .reduce((sum, s) => sum + (s.text?.length || 0), 0);
    if (words >= MAX_WORDS_PER_AUTHOR) {
      return {
        canWrite: false,
        statusText: `书房：《${currentBook.title}》字数已写满，等待新卷`,
        bookId: currentBook.id,
      };
    }

    return {
      canWrite: true,
      statusText: `书房：《${currentBook.title}》墨已干，可以接`,
      bookId: currentBook.id,
      title: currentBook.title,
    };
  }

  // --- 为「去了才读」准备手稿材料与前情 ---

  prepareStudyContext({ bookId, authorId }) {
    const book = this._readJson(this._bookPath(bookId));
    if (!book) throw new Error('书籍不存在');

    const sections = Array.isArray(book.sections) ? book.sections : [];
    // 检查此人是否有被打回重写的段落
    const rewriteSec = sections.find(s => s.authorId === authorId && s.needsRewrite);
    const rewriteIndex = rewriteSec ? sections.findIndex(s => s.id === rewriteSec.id) + 1 : 0;

    // 续写本人与后续作者都看不到被隐藏的段落（不影响上下文理解）
    const visibleSections = sections.filter(s => !s.hidden);

    const authoredWords = visibleSections
      .filter(s => s.authorId === authorId)
      .reduce((sum, s) => sum + (s.text?.length || 0), 0);
    const totalWords = visibleSections.reduce((sum, s) => sum + (s.text?.length || 0), 0);

    // 使用者的开篇段（第一折）
    const firstSec = visibleSections[0] || sections[0];
    const opening = firstSec ? {
      authorName: firstSec.authorName,
      text: firstSec.text,
      createdAt: firstSec.createdAt,
    } : null;

    // 收集批注（包含被打回段落的所有批注，以及未湿墨段落的批注）
    const notes = [];
    visibleSections.forEach((sec, idx) => {
      if ((!sec.inkWet || sec.id === rewriteSec?.id) && Array.isArray(sec.notes)) {
        sec.notes.forEach(n => {
          notes.push({
            sectionIndex: idx + 1,
            authorName: sec.authorName,
            quote: n.quote,
            comment: n.comment,
          });
        });
      }
    });

    // 正文上下文：基于可见段落
    let historyContent = '';
    if (totalWords <= LONG_BOOK_THRESHOLD_WORDS || visibleSections.length <= 3) {
      historyContent = visibleSections.map((s, i) => `【第 ${i + 1} 折 · ${s.authorName}】\n${s.text}`).join('\n\n');
    } else {
      // 超过 12000 字：前面的段落抽取前情提要，最近 2 段完整呈现
      const earlierSections = visibleSections.slice(0, -2);
      const recentSections = visibleSections.slice(-2);
      const summaryLines = earlierSections.map((s, i) => {
        const snippet = s.text.length > 200 ? `${s.text.slice(0, 120)}……${s.text.slice(-60)}` : s.text;
        return `第 ${i + 1} 折（${s.authorName}）：${snippet.replace(/\n+/g, ' ')}`;
      });
      const recentText = recentSections.map((s, i) => `【第 ${earlierSections.length + i + 1} 折 · ${s.authorName}】\n${s.text}`).join('\n\n');
      historyContent = `【前情提要（第 1 ~ ${earlierSections.length} 折概要）】\n${summaryLines.join('\n')}\n\n【最近两折手稿全文】\n${recentText}`;
    }

    return {
      bookId: book.id,
      title: book.title,
      motif: book.motif || '暂无题签',
      totalSections: visibleSections.length,
      nextSectionIndex: visibleSections.length + 1,
      totalWords,
      authoredWords,
      maxWordsPerAuthor: MAX_WORDS_PER_AUTHOR,
      remainingQuota: Math.max(0, MAX_WORDS_PER_AUTHOR - authoredWords),
      wordRange: `${MIN_SECTION_WORDS}–${MAX_SECTION_WORDS} 字`,
      openingSection: opening,
      notes,
      historyContent,
      isRewrite: Boolean(rewriteSec),
      rewriteSectionId: rewriteSec?.id || null,
      rewriteSectionIndex: rewriteIndex || 0,
      originalDraft: rewriteSec?.text || '',
      rewriteReason: rewriteSec?.rewriteReason || '',
    };
  }

  // --- 提交新段落 ---

  appendSection({ bookId, authorId, authorName, text, isOwner = false }) {
    if (!text || !text.trim()) throw new Error('段落正文不能为空');
    const cleanText = text.trim();
    if (!isOwner && (cleanText.length < MIN_SECTION_WORDS || cleanText.length > MAX_SECTION_WORDS)) {
      throw new Error(`段落字数须在 ${MIN_SECTION_WORDS}–${MAX_SECTION_WORDS} 字之间，当前字数: ${cleanText.length}`);
    }

    const lockRes = this.acquireLock({ bookId, authorId, authorName, isOwner });
    if (!lockRes.ok) throw new Error(lockRes.reason);

    const book = this._readJson(this._bookPath(bookId));
    if (!book) throw new Error('书籍不存在');

    const secId = 'sec_' + crypto.randomUUID().slice(0, 8);
    const newSection = {
      id: secId,
      authorId,
      authorName,
      text: cleanText,
      createdAt: this.now(),
      inkWet: true, // 初始湿墨
      revisions: [],
      notes: [],
    };

    if (!Array.isArray(book.sections)) book.sections = [];
    book.sections.push(newSection);
    book.updatedAt = this.now();

    this._writeJson(this._bookPath(bookId), book);
    // 释放锁
    this.releaseLock({ bookId, authorId, force: true });
    return { ok: true, section: newSection, sectionIndex: book.sections.length };
  }
}

module.exports = {
  StudyService,
  LOCK_TIMEOUT_MS,
  DEFAULT_INK_DRY_MS,
  MAX_WORDS_PER_AUTHOR,
  MIN_SECTION_WORDS,
  MAX_SECTION_WORDS,
  LONG_BOOK_THRESHOLD_WORDS,
};
