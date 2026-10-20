'use strict';

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Luma 小屋朋友圈（Fils d’Instants）权威持久化与管理服务
 * 
 * 核心设计：
 * 1. 物理原子写盘：存储于 userData/luma-moments/state.json
 * 2. 权威实体结构：动态 (posts)、点赞 (likes)、评论 (comments)
 * 3. 幂等与防并发：requestId 幂等语义，重复提交不重复加赞或发重复帖
 * 4. 真实删除状态：持久化软删除，刷新、重启、重试绝不复活
 * 5. 附件安全隔离：复用 attachmentsStore 存储图片二进制与缩略图
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function imageUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

class MomentsService {
  constructor({ userDataDir, getData, attachmentsStore, onMomentsChanged }) {
    if (!userDataDir || typeof userDataDir !== 'string') {
      throw new Error('userDataDir 必须是非空字符串');
    }
    this.userDataDir = userDataDir;
    this.getData = typeof getData === 'function' ? getData : () => null;
    this.attachmentsStore = attachmentsStore;
    this.onMomentsChanged = typeof onMomentsChanged === 'function' ? onMomentsChanged : null;

    this.momentsDir = path.join(this.userDataDir, 'luma-moments');
    this.stateFile = path.join(this.momentsDir, 'state.json');
    this._ensureDir(this.momentsDir);

    this.state = this._loadState();
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const raw = fs.readFileSync(this.stateFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return {
            schema: 1,
            posts: Array.isArray(parsed.posts) ? parsed.posts : [],
            likes: Array.isArray(parsed.likes) ? parsed.likes : [],
            comments: Array.isArray(parsed.comments) ? parsed.comments : []
          };
        }
      }
    } catch (e) {
      console.warn('[MomentsService] 读取 state.json 失败，保留备份后初始化:', e.message);
      try {
        if (fs.existsSync(this.stateFile)) {
          fs.copyFileSync(this.stateFile, `${this.stateFile}.${Date.now()}.bak`);
        }
      } catch {}
    }
    const initial = { schema: 1, posts: [], likes: [], comments: [] };
    this._saveState(initial);
    return initial;
  }

  _saveState(stateToSave = this.state) {
    const tmp = `${this.stateFile}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(stateToSave, null, 2), 'utf8');
    fs.renameSync(tmp, this.stateFile);
  }

  _flush() {
    this._saveState(this.state);
    if (this.onMomentsChanged) {
      try {
        this.onMomentsChanged();
      } catch (e) {
        console.warn('[MomentsService] onMomentsChanged 回调异常:', e.message);
      }
    }
  }

  /**
   * 游标分页获取有效动态
   * @param {Object} options
   * @param {number|string} [options.cursor] 分页游标 (时间戳)
   * @param {number} [options.limit=20] 单次请求最大数
   * @param {string} [options.viewerId='agent_owner'] 当前查看者 ID
   */
  list({ cursor, limit = 20, viewerId = 'agent_owner' } = {}) {
    const maxLimit = Math.max(1, Math.min(50, Number(limit) || 20));
    const cursorTime = cursor ? Number(cursor) : Infinity;

    // 过滤未删除动态并倒序排
    const activePosts = this.state.posts
      .filter(p => !p.isDeleted && (p.createdAt < cursorTime))
      .sort((a, b) => b.createdAt - a.createdAt);

    const slice = activePosts.slice(0, maxLimit);
    const hasMore = activePosts.length > maxLimit;
    const nextCursor = slice.length > 0 ? slice[slice.length - 1].createdAt : null;

    // Recover selected photos for earlier shares whose attachment download failed.
    // Join by activity, post and author; listing never rewrites the user's records.
    let history = [];
    if (slice.some(p => p.activityId && !p.imageUrl && !p.attachments?.length)) {
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(this.userDataDir, 'luma-autonomy', 'state.json'), 'utf8'));
        if (Array.isArray(saved.history)) history = saved.history;
      } catch {}
    }

    // 补齐点赞与评论
    const resultPosts = slice.map(post => {
      const activity = history.find(row => row.id === post.activityId && row.momentPostId === post.id && row.agentId === post.authorId && row.status === 'shared');
      const selectedImage = activity?.sources?.some(source => source.images?.includes(activity.imageUrl)) ? activity.imageUrl : null;
      const postLikes = this.state.likes.filter(l => l.postId === post.id);
      const postComments = this.state.comments
        .filter(c => c.postId === post.id && !c.isDeleted)
        .sort((a, b) => a.createdAt - b.createdAt);

      // 处理附件缩略图预览
      const attachments = (post.attachments || []).map(att => {
        let previewDataUrl = null;
        if (this.attachmentsStore && att.kind === 'image') {
          try {
            const prev = this.attachmentsStore.preview(att.id, false);
            if (prev?.kind === 'image') {
              previewDataUrl = prev.dataUrl;
            }
          } catch {}
        }
        return {
          id: att.id,
          name: att.name,
          kind: att.kind,
          mimeType: att.mimeType,
          size: att.size,
          previewDataUrl
        };
      });

      return {
        id: post.id,
        authorId: post.authorId,
        createdAt: post.createdAt,
        updatedAt: post.updatedAt || post.createdAt,
        text: post.text,
        attachments,
        imageUrl: imageUrl(post.imageUrl) || imageUrl(selectedImage),
        location: post.location || null,
        type: post.type || 'post',
        activityId: post.activityId || null,
        sourceLinks: post.sourceLinks || [],
        likesCount: postLikes.length,
        likedByViewer: postLikes.some(l => l.actorId === viewerId),
        likes: postLikes.map(l => ({ actorId: l.actorId, createdAt: l.createdAt })),
        comments: postComments.map(c => ({
          id: c.id,
          postId: c.postId,
          authorId: c.authorId,
          text: c.text,
          createdAt: c.createdAt,
          replyToCommentId: c.replyToCommentId || null,
          replyToAuthorId: c.replyToAuthorId || null
        }))
      };
    });

    return {
      schema: 'moments/1',
      posts: resultPosts,
      nextCursor,
      hasMore
    };
  }

  /**
   * 发布新动态
   */
  post({ requestId, authorId, text = '', attachments = [], location = null, type = 'post', activityId = null, sourceLinks = [], imageUrl: selectedImage = null }) {
    if (!authorId || typeof authorId !== 'string') {
      throw new Error('authorId 不能为空');
    }
    const cleanText = String(text || '').trim();
    if (!cleanText && (!Array.isArray(attachments) || attachments.length === 0)) {
      throw new Error('动态内容与图片不能同时为空');
    }

    // 幂等处理
    if (requestId && typeof requestId === 'string') {
      const existing = this.state.posts.find(p => p.requestId === requestId);
      if (existing) {
        const postLikes = this.state.likes.filter(l => l.postId === existing.id);
        const postComments = this.state.comments.filter(c => c.postId === existing.id && !c.isDeleted);
        return {
          ok: true,
          post: {
            ...existing,
            likesCount: postLikes.length,
            likedByViewer: postLikes.some(l => l.actorId === authorId),
            likes: postLikes.map(l => ({ actorId: l.actorId, createdAt: l.createdAt })),
            comments: postComments
          },
          duplicate: true
        };
      }
    }

    const postId = 'moment_' + crypto.randomBytes(12).toString('hex');
    const now = Date.now();

    const newPost = {
      id: postId,
      requestId: requestId || null,
      authorId,
      createdAt: now,
      updatedAt: now,
      text: cleanText,
      attachments: Array.isArray(attachments) ? attachments.slice(0, 9) : [],
        imageUrl: imageUrl(selectedImage),
      location: location && typeof location === 'string' ? location.trim().slice(0, 100) : null,
      type: ['post', 'daily', 'outing'].includes(type) ? type : 'post',
      activityId: activityId || null,
      sourceLinks: Array.isArray(sourceLinks) ? sourceLinks.slice(0, 10) : [],
      isDeleted: false
    };

    this.state.posts.unshift(newPost);
    this._flush();

    return {
      ok: true,
      post: {
        ...newPost,
        likesCount: 0,
        likedByViewer: false,
        likes: [],
        comments: []
      }
    };
  }

  /**
   * 点赞 / 取消点赞切换
   */
  toggleLike({ postId, actorId }) {
    if (!postId || !actorId) throw new Error('postId 和 actorId 不能为空');
    const post = this.state.posts.find(p => p.id === postId && !p.isDeleted);
    if (!post) throw new Error('动态不存在或已被删除');

    const index = this.state.likes.findIndex(l => l.postId === postId && l.actorId === actorId);
    let liked = false;
    if (index >= 0) {
      // 取消点赞
      this.state.likes.splice(index, 1);
      liked = false;
    } else {
      // 点赞
      this.state.likes.push({
        postId,
        actorId,
        createdAt: Date.now()
      });
      liked = true;
    }

    this._flush();
    const count = this.state.likes.filter(l => l.postId === postId).length;
    return { ok: true, liked, count, postId };
  }

  /**
   * 发表评论 / 回复
   */
  comment({ requestId, postId, authorId, text, replyToCommentId = null, replyToAuthorId = null }) {
    if (!postId || !authorId) throw new Error('postId 和 authorId 不能为空');
    const post = this.state.posts.find(p => p.id === postId && !p.isDeleted);
    if (!post) throw new Error('动态不存在或已被删除');

    const cleanText = String(text || '').trim();
    if (!cleanText) throw new Error('评论内容不能为空');

    // 幂等处理
    if (requestId && typeof requestId === 'string') {
      const existing = this.state.comments.find(c => c.requestId === requestId);
      if (existing) {
        return { ok: true, comment: existing, duplicate: true };
      }
    }

    if (replyToCommentId) {
      const parent = this.state.comments.find(c => c.id === replyToCommentId && !c.isDeleted);
      if (!parent) throw new Error('回复的评论不存在或已被删除');
      if (!replyToAuthorId) replyToAuthorId = parent.authorId;
    }

    const commentId = 'comment_' + crypto.randomBytes(12).toString('hex');
    const newComment = {
      id: commentId,
      requestId: requestId || null,
      postId,
      authorId,
      text: cleanText.slice(0, 1000),
      createdAt: Date.now(),
      replyToCommentId: replyToCommentId || null,
      replyToAuthorId: replyToAuthorId || null,
      isDeleted: false
    };

    this.state.comments.push(newComment);
    this._flush();

    return { ok: true, comment: newComment };
  }

  /**
   * 删除动态 (支持作者本人删除)
   */
  deletePost({ postId, actorId }) {
    if (!postId || !actorId) throw new Error('缺少删除参数');
    const post = this.state.posts.find(p => p.id === postId);
    if (!post) return { ok: true, saved: true, note: '已不存在' };

    // 权限检查：只有作者本人或者使用者本人有权删除
    if (post.authorId !== actorId && actorId !== 'agent_owner') {
      throw new Error('只有发布者本人可以删除此动态');
    }

    post.isDeleted = true;
    post.deletedAt = Date.now();

    // 关联软删除所有该帖评论
    for (const c of this.state.comments) {
      if (c.postId === postId) {
        c.isDeleted = true;
        c.deletedAt = Date.now();
      }
    }

    this._flush();
    return { ok: true, saved: true };
  }

  /**
   * 删除评论
   */
  deleteComment({ commentId, actorId }) {
    if (!commentId || !actorId) throw new Error('缺少删除参数');
    const comment = this.state.comments.find(c => c.id === commentId);
    if (!comment) return { ok: true, saved: true, note: '已不存在' };

    if (comment.authorId !== actorId && actorId !== 'agent_owner') {
      throw new Error('只有发布者本人可以删除此评论');
    }

    comment.isDeleted = true;
    comment.deletedAt = Date.now();
    this._flush();
    return { ok: true, saved: true };
  }

  /**
   * 获取单张附件的大图或缩略图数据 (dataUrl)
   */
  getAttachmentPreview(attachmentId, full = true) {
    if (!this.attachmentsStore) throw new Error('附件库服务未就绪');
    return this.attachmentsStore.preview(attachmentId, full);
  }

  /**
   * 获取最近的公共动态简报（供 AutonomyService 在家人心跳唤醒时感知家里动态）
   */
  getRecentContextForAutonomy(maxCount = 5) {
    const activePosts = this.state.posts
      .filter(p => !p.isDeleted)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, maxCount);

    return activePosts.map(p => {
      const comments = this.state.comments
        .filter(c => c.postId === p.id && !c.isDeleted)
        .slice(-3)
        .map(c => ({ authorId: c.authorId, text: c.text }));
      return {
        id: p.id,
        authorId: p.authorId,
        text: p.text.slice(0, 140),
        location: p.location,
        hasImage: !!(p.attachments && p.attachments.length > 0),
        comments
      };
    });
  }

  /**
   * 获取用于 ExternalMemory 记忆摄取/投影的朋友圈公共原文
   * 包含未删除的动态和有实质内容的评论
   */
  getProjectionItems() {
    const purgedPosts = new Set(this.state.posts.filter(p => p.isDeleted).map(p => p.id));
    const items = [];

    for (const post of this.state.posts) {
      if (post.isDeleted) continue;
      // 动态作为一条公共频道消息
      items.push({
        id: post.id,
        authorId: post.authorId,
        text: post.text + (post.location ? ` [地点：${post.location}]` : '') + (post.sourceLinks?.length ? '\n来源：' + post.sourceLinks.map(s => s.title).join('、') : ''),
        createdAt: post.createdAt,
        type: 'moment_post'
      });
    }

    for (const comment of this.state.comments) {
      if (comment.isDeleted || purgedPosts.has(comment.postId)) continue;
      if (!comment.text || comment.text.trim().length < 2) continue;
      items.push({
        id: comment.id,
        authorId: comment.authorId,
        text: comment.text,
        createdAt: comment.createdAt,
        type: 'moment_comment',
        postId: comment.postId
      });
    }

    return items;
  }
}

module.exports = { MomentsService };
