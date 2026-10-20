/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { MomentPicture, MomentText } from './MomentPicture';
import { 
  Heart, 
  MessageCircle, 
  Camera, 
  X, 
  MapPin, 
  Sparkles, 
  Trash2, 
  Send, 
  Image as ImageIcon,
  ExternalLink,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { 
  MomentPost, 
  MomentComment, 
  MemberDto, 
  SendChatAttachment 
} from '../types';
import { 
  fetchMoments, 
  postMoment, 
  toggleMomentLike, 
  commentMoment, 
  deleteMomentItem,
  fetchMembers,
  fetchMomentImage
} from '../utils/apiClient';

/**
 * 客户端图片压缩，兼顾高清与体积 (<= 1200px, JPEG 0.78)
 */
async function compressImage(file: File): Promise<{ dataUrl: string; dataBase64: string; size: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const maxDim = 1200;
        let width = img.width;
        let height = img.height;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          const rawB64 = (reader.result as string).split(',')[1] || '';
          resolve({ dataUrl: reader.result as string, dataBase64: rawB64, size: file.size });
          return;
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
        const dataBase64 = dataUrl.split(',')[1] || '';
        const size = Math.round((dataBase64.length * 3) / 4);
        resolve({ dataUrl, dataBase64, size });
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffHour < 24) return `${diffHour} 小时前`;
  if (diffDay === 1) return '昨天';
  if (diffDay < 7) return `${diffDay} 天前`;

  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export const ChatMomentsView: React.FC = () => {
  const [posts, setPosts] = useState<MomentPost[]>([]);
  const [members, setMembers] = useState<Record<string, MemberDto>>({});
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [nextCursor, setNextCursor] = useState<number | null>(null);

  // 发布浮层
  const [isPublishOpen, setIsPublishOpen] = useState<boolean>(false);
  const [publishText, setPublishText] = useState<string>('');
  const [publishLocation, setPublishLocation] = useState<string>('');
  const [publishImages, setPublishImages] = useState<{ name: string; dataUrl: string; dataBase64: string }[]>([]);
  const [isPublishing, setIsPublishing] = useState<boolean>(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  // 评论交互
  const [expandedComments, setExpandedComments] = useState<Record<string, boolean>>({});
  const [activeReplyPostId, setActiveReplyPostId] = useState<string | null>(null);
  const [replyInputText, setReplyInputText] = useState<string>('');
  const [replyTarget, setReplyTarget] = useState<{ commentId: string; authorName: string; authorId: string } | null>(null);
  const [isSubmittingReply, setIsSubmittingReply] = useState<boolean>(false);

  // 全屏看大图
  const [lightboxImageUrl, setLightboxImageUrl] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 加载成员信息以映射真实头像与法文身份
  useEffect(() => {
    fetchMembers()
      .then((membersList) => {
        const map: Record<string, MemberDto> = {};
        if (Array.isArray(membersList)) {
          for (const m of membersList) {
            map[m.agentId] = m;
          }
        }
        setMembers(map);
      })
      .catch((e) => console.warn('获取家庭成员信息失败:', e));
  }, []);

  // 加载动态
  const loadPosts = async (cursor?: number) => {
    try {
      setIsLoading(true);
      const res = await fetchMoments(cursor, 20);
      if (cursor) {
        setPosts((prev) => [...prev, ...res.posts]);
      } else {
        setPosts(res.posts);
      }
      setHasMore(res.hasMore);
      setNextCursor(res.nextCursor || null);
    } catch (e: any) {
      console.error('加载朋友圈动态失败:', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadPosts();
  }, []);

  // 点赞/取消点赞
  const handleToggleLike = async (postId: string) => {
    const target = posts.find((p) => p.id === postId);
    if (!target) return;

    const previousLiked = target.likedByViewer;
    const previousCount = target.likesCount;

    // 乐观更新
    setPosts((prev) =>
      prev.map((p) => {
        if (p.id !== postId) return p;
        const nextLiked = !previousLiked;
        return {
          ...p,
          likedByViewer: nextLiked,
          likesCount: nextLiked ? previousCount + 1 : Math.max(0, previousCount - 1),
          likes: nextLiked
            ? [...p.likes, { actorId: 'agent_owner', createdAt: Date.now() }]
            : p.likes.filter((l) => l.actorId !== 'agent_owner')
        };
      })
    );

    try {
      const res = await toggleMomentLike(postId);
      // 与后端对齐权威值
      setPosts((prev) =>
        prev.map((p) =>
          p.id === postId
            ? { ...p, likedByViewer: res.liked, likesCount: res.count }
            : p
        )
      );
    } catch (e) {
      console.error('点赞请求失败，正在回滚:', e);
      // 回滚
      setPosts((prev) =>
        prev.map((p) =>
          p.id === postId
            ? { ...p, likedByViewer: previousLiked, likesCount: previousCount }
            : p
        )
      );
    }
  };

  // 选择图片
  const handleSelectFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const remainingSlots = 9 - publishImages.length;
    const selected = Array.from(files).slice(0, remainingSlots);

    for (const file of selected) {
      try {
        const compressed = await compressImage(file);
        setPublishImages((prev) => [
          ...prev,
          { name: file.name, dataUrl: compressed.dataUrl, dataBase64: compressed.dataBase64 }
        ]);
      } catch (err) {
        console.error('图片压缩失败:', err);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // 移除选中的待发图
  const handleRemovePublishImage = (index: number) => {
    setPublishImages((prev) => prev.filter((_, i) => i !== index));
  };

  // 提交发布
  const handlePublish = async () => {
    if (!publishText.trim() && publishImages.length === 0) {
      setPublishError('写点什么，或者选一张图吧');
      return;
    }

    try {
      setIsPublishing(true);
      setPublishError(null);

      const attachmentsToSend: SendChatAttachment[] = publishImages.map((img, idx) => ({
        name: img.name || 'moment.jpg',
        mimeType: img.dataUrl.match(/^data:([^;,]+)/)?.[1] || 'image/jpeg',
        size: Math.round((img.dataBase64.length * 3) / 4),
        dataBase64: img.dataBase64
      }));

      const requestId = `post_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const res = await postMoment({
        requestId,
        text: publishText.trim(),
        attachments: attachmentsToSend,
        location: publishLocation.trim() || undefined
      });

      if (res.ok && res.post) {
        setPosts((prev) => [res.post, ...prev]);
        setIsPublishOpen(false);
        setPublishText('');
        setPublishLocation('');
        setPublishImages([]);
      } else {
        setPublishError('发布未被确认，请重试');
      }
    } catch (e: any) {
      console.error('发布动态失败:', e);
      setPublishError(e.message || '发布失败，请检查网络');
    } finally {
      setIsPublishing(false);
    }
  };

  // 提交评论或回复
  const handleSendComment = async (postId: string) => {
    if (!replyInputText.trim() || isSubmittingReply) return;

    try {
      setIsSubmittingReply(true);
      const reqId = `comment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const res = await commentMoment({
        requestId: reqId,
        postId,
        text: replyInputText.trim(),
        replyToCommentId: replyTarget?.commentId || null,
        replyToAuthorId: replyTarget?.authorId || null
      });

      if (res.ok && res.comment) {
        setPosts((prev) =>
          prev.map((p) =>
            p.id === postId
              ? { ...p, comments: [...p.comments, res.comment] }
              : p
          )
        );
        setReplyInputText('');
        setReplyTarget(null);
        setActiveReplyPostId(null);
        // 自动展开该帖评论
        setExpandedComments((prev) => ({ ...prev, [postId]: true }));
      }
    } catch (e) {
      console.error('发表评论失败:', e);
    } finally {
      setIsSubmittingReply(false);
    }
  };

  // 删除动态
  const handleDeletePost = async (postId: string) => {
    if (!window.confirm('确认删除这条动态吗？')) return;
    try {
      await deleteMomentItem('post', postId);
      setPosts((prev) => prev.filter((p) => p.id !== postId));
    } catch (e: any) {
      alert(e.message || '删除失败');
    }
  };

  // 删除单条评论
  const handleDeleteComment = async (postId: string, commentId: string) => {
    if (!window.confirm('确认删除这条评论吗？')) return;
    try {
      await deleteMomentItem('comment', commentId);
      setPosts((prev) =>
        prev.map((p) =>
          p.id === postId
            ? { ...p, comments: p.comments.filter((c) => c.id !== commentId) }
            : p
        )
      );
    } catch (e: any) {
      alert(e.message || '删除评论失败');
    }
  };

  // 查看大图
  const handleOpenImage = async (attId: string, previewDataUrl?: string | null) => {
    if (previewDataUrl) {
      setLightboxImageUrl(previewDataUrl);
    }
    try {
      const fullUrl = await fetchMomentImage(attId);
      if (fullUrl) {
        setLightboxImageUrl(fullUrl);
      }
    } catch {
      // 降级使用已有缩略预览
    }
  };

  // 成员显示名与头像解析
  const getAuthorInfo = (authorId: string) => {
    if (authorId === 'agent_owner') {
      return {
        name: '使用者',
        role: 'Artiste Résidente',
        avatarBg: 'rgba(198, 147, 144, 0.75)',
        initial: 'U',
        avatarUrl: undefined
      };
    }
    const m = members[authorId];
    if (m) {
      return {
        name: m.displayName,
        role: authorId === 'agent_coordinator' ? 'Coordinator' : authorId === 'agent_worker' ? 'Researcher' : m.kind,
        avatarBg: m.accent || 'rgba(180, 160, 140, 0.6)',
        initial: m.displayName.slice(0, 1),
        avatarUrl: m.avatarDataUrl
      };
    }
    return {
      name: authorId === 'agent_coordinator' ? '协调者' : authorId === 'agent_worker' ? '编辑助手' : authorId,
      role: 'Compagnon',
      avatarBg: 'rgba(180, 160, 140, 0.6)',
      initial: authorId.slice(0, 1),
      avatarUrl: undefined
    };
  };

  return (
    <div className="relative w-full h-full flex flex-col overflow-y-auto no-scrollbar select-none pb-28 text-stone-900 px-3">
      {/* 顶部标题栏：保留原有优雅法文手写体与右上角相机按钮 */}
      <header
        className="relative z-10 pb-3 pt-safe-salon-header flex items-center justify-between"
        style={{ paddingTop: 'calc(max(env(safe-area-inset-top, 0px), 16px) + 1rem)' }}
      >
        <div>
          <h1 className="font-calligraphy text-3xl sm:text-4xl text-stone-900 script-shadow tracking-wide leading-tight">
            Fils d'Instants
          </h1>
          <p className="font-calligraphy text-base sm:text-lg text-stone-700/90 italic -mt-0.5">
            Chroniques Poétiques & Moments Partagés
          </p>
        </div>

        {/* 右上角发布相机按钮 */}
        <button
          onClick={() => setIsPublishOpen(true)}
          className="p-2.5 rounded-full bg-white/40 border border-white/60 shadow-xs hover:bg-white/60 active:scale-95 transition-all text-stone-700 hover:text-stone-900 cursor-pointer"
          title="发布我的动态"
        >
          <Camera className="w-5 h-5" />
        </button>
      </header>

      {/* 动态流列表 */}
      <div className="space-y-4 pt-1">
        {isLoading && posts.length === 0 ? (
          <div className="py-16 text-center space-y-2">
            <Sparkles className="w-6 h-6 mx-auto text-amber-700/60 animate-pulse" />
            <p className="font-calligraphy text-base text-stone-600 italic">
              « Chargement des doux moments... »
            </p>
          </div>
        ) : posts.length === 0 ? (
          /* 诗意空态展示：无假赞、无假数据 */
          <div className="fr-chat-glass-card rounded-3xl p-8 text-center space-y-3 my-6">
            <Sparkles className="w-8 h-8 mx-auto text-amber-700/50" />
            <p className="font-calligraphy text-xl text-stone-800">
              Silence Poétique dans l'Atelier
            </p>
            <p className="font-serif text-xs text-stone-600 leading-relaxed max-w-xs mx-auto">
              院子里晨露未晞，尚未有新的光景。轻触右上角的相机，记录今天落在宣纸上的第一抹天光吧。
            </p>
            <button
              onClick={() => setIsPublishOpen(true)}
              className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-stone-900/10 hover:bg-stone-900/15 text-stone-800 font-serif text-xs transition-colors"
            >
              <Camera className="w-4 h-4" />
              <span>记下一瞬</span>
            </button>
          </div>
        ) : (
          posts.map((post) => {
            const author = getAuthorInfo(post.authorId);
            const isAuthorZhao = post.authorId === 'agent_owner';
            const isCommentsExpanded = expandedComments[post.id] ?? true;

            return (
              <article
                key={post.id}
                className="fr-chat-glass-card rounded-3xl p-4 space-y-3 transition-all"
              >
                {/* 顶部：发布人信息与删除选项 */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    {author.avatarUrl ? (
                      <img
                        src={author.avatarUrl}
                        alt={author.name}
                        className="w-9 h-9 rounded-full object-cover border border-white/70 shadow-xs"
                      />
                    ) : (
                      <div
                        className="w-9 h-9 rounded-full flex items-center justify-center font-serif text-xs font-bold text-stone-900 border border-white/70 shadow-xs"
                        style={{ backgroundColor: author.avatarBg }}
                      >
                        {author.initial}
                      </div>
                    )}
                    <div>
                      <div className="flex items-baseline gap-1.5">
                        <span className="font-serif font-bold text-xs text-stone-900">
                          {author.name}
                        </span>
                        <span className="font-calligraphy text-xs text-stone-600">
                          {author.role}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[9px] text-stone-500 font-mono">
                        <span>{formatRelativeTime(post.createdAt)}</span>
                        {post.location && (
                          <>
                            <span>·</span>
                            <span className="flex items-center gap-0.5 text-stone-600 font-serif italic">
                              <MapPin className="w-2.5 h-2.5" />
                              {post.location}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    {isAuthorZhao && (
                      <button
                        onClick={() => handleDeletePost(post.id)}
                        className="p-1.5 rounded-full text-stone-400 hover:text-rose-700/80 transition-colors"
                        title="删除我的动态"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <div className="p-1 rounded-full text-stone-400">
                      <Sparkles className="w-3.5 h-3.5 text-amber-700/60" />
                    </div>
                  </div>
                </div>

                {/* 动态正文 */}
                {post.text && (
                  <MomentText text={post.text} onOpen={setLightboxImageUrl} />
                )}

                {!post.attachments?.length && post.imageUrl && (
                  <MomentPicture src={post.imageUrl} alt="见闻配图" onOpen={setLightboxImageUrl} />
                )}

                {/* 真实图片展示 */}
                {post.attachments && post.attachments.length > 0 && (
                  <div
                    className={`grid gap-2 pt-1 ${
                      post.attachments.length === 1
                        ? 'grid-cols-1'
                        : post.attachments.length === 2
                        ? 'grid-cols-2'
                        : 'grid-cols-3'
                    }`}
                  >
                    {post.attachments.map((att, idx) => (
                      <div
                        key={att.id || idx}
                        onClick={() => handleOpenImage(att.id, att.previewDataUrl)}
                        className="relative rounded-2xl overflow-hidden bg-stone-200/50 aspect-square border border-white/40 shadow-xs cursor-pointer group"
                      >
                        {att.previewDataUrl ? (
                          <img
                            src={att.previewDataUrl}
                            alt={att.name || 'Moment'}
                            className="w-full h-full object-cover group-hover:scale-102 transition-transform duration-300"
                            loading="lazy"
                          />
                        ) : (
                          <div className="w-full h-full flex flex-col items-center justify-center text-stone-400 p-2">
                            <ImageIcon className="w-6 h-6 mb-1 opacity-60" />
                            <span className="text-[9px] font-mono truncate max-w-[80px]">
                              {att.name}
                            </span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* 来源链接 (针对出门漫游见闻) */}
                {post.sourceLinks && post.sourceLinks.length > 0 && (
                  <div className="p-2 rounded-xl bg-white/25 border border-white/35 flex flex-wrap gap-2 text-[10px] font-serif text-stone-600">
                    <span className="text-stone-500 italic">见闻来源：</span>
                    {post.sourceLinks.map((link, idx) => (
                      <a
                        key={idx}
                        href={link.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-0.5 text-stone-700 underline underline-offset-2 hover:text-stone-900"
                      >
                        <span>{link.title || link.url}</span>
                        <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                      </a>
                    ))}
                  </div>
                )}

                {/* 底部互动栏：点赞与评论统计 */}
                <div className="flex items-center justify-between pt-1 border-t border-stone-800/10 text-xs text-stone-600">
                  <button
                    onClick={() => handleToggleLike(post.id)}
                    className={`flex items-center gap-1.5 transition-colors cursor-pointer ${
                      post.likedByViewer
                        ? 'text-rose-700 font-medium'
                        : 'text-stone-500 hover:text-rose-600'
                    }`}
                  >
                    <Heart
                      className={`w-3.5 h-3.5 transition-transform active:scale-125 ${
                        post.likedByViewer ? 'fill-rose-500 text-rose-600' : 'text-stone-400'
                      }`}
                    />
                    <span className="text-[11px] font-mono">
                      {post.likesCount > 0 ? post.likesCount : '赞'}
                    </span>
                  </button>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={() =>
                        setActiveReplyPostId((prev) => (prev === post.id ? null : post.id))
                      }
                      className="flex items-center gap-1 text-stone-500 hover:text-stone-800 text-[11px] font-serif cursor-pointer"
                    >
                      <MessageCircle className="w-3.5 h-3.5" />
                      <span>{(post.comments || []).length} 评论</span>
                    </button>

                    {(post.comments || []).length > 0 && (
                      <button
                        onClick={() =>
                          setExpandedComments((prev) => ({
                            ...prev,
                            [post.id]: !isCommentsExpanded
                          }))
                        }
                        className="text-stone-400 hover:text-stone-600"
                      >
                        {isCommentsExpanded ? (
                          <ChevronUp className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </div>

                {/* 点赞名单轻量展示 */}
                {post.likes && post.likes.length > 0 && (
                  <div className="px-2 py-1 rounded-xl bg-white/20 text-[10px] font-serif text-stone-600 flex items-center gap-1">
                    <Heart className="w-2.5 h-2.5 text-rose-500 fill-rose-500/40 inline-block shrink-0" />
                    <span className="truncate">
                      {post.likes
                        .map((l) => getAuthorInfo(l.actorId).name)
                        .join('、')}{' '}
                      赞过
                    </span>
                  </div>
                )}

                {/* 评论列表区域 */}
                {(post.comments || []).length > 0 && isCommentsExpanded && (
                  <div className="bg-white/30 rounded-2xl p-2.5 space-y-2 text-[11px] font-serif text-stone-700 border border-white/35">
                    {(post.comments || []).map((comment) => {
                      const cAuthor = getAuthorInfo(comment.authorId);
                      const isMyComment = comment.authorId === 'agent_owner';
                      const replyToAuthorName = comment.replyToAuthorId
                        ? getAuthorInfo(comment.replyToAuthorId).name
                        : null;

                      return (
                        <div
                          key={comment.id}
                          className="flex items-start justify-between group/comment leading-snug"
                        >
                          <div className="flex-1 min-w-0 pr-1">
                            <strong
                              onClick={() => {
                                setActiveReplyPostId(post.id);
                                setReplyTarget({
                                  commentId: comment.id,
                                  authorName: cAuthor.name,
                                  authorId: comment.authorId
                                });
                              }}
                              className="text-stone-900 font-semibold cursor-pointer hover:underline"
                            >
                              {cAuthor.name}
                            </strong>
                            {replyToAuthorName && (
                              <span className="text-stone-500 mx-1">
                                回复 @{replyToAuthorName}
                              </span>
                            )}
                            <span className="text-stone-900 font-normal mr-1">：</span>
                            <span className="text-stone-800 break-words">{comment.text}</span>
                          </div>

                          <div className="flex items-center gap-1.5 opacity-0 group-hover/comment:opacity-100 transition-opacity">
                            <button
                              onClick={() => {
                                setActiveReplyPostId(post.id);
                                setReplyTarget({
                                  commentId: comment.id,
                                  authorName: cAuthor.name,
                                  authorId: comment.authorId
                                });
                              }}
                              className="text-[10px] text-stone-400 hover:text-stone-700"
                            >
                              回复
                            </button>
                            {isMyComment && (
                              <button
                                onClick={() => handleDeleteComment(post.id, comment.id)}
                                className="text-[10px] text-stone-400 hover:text-rose-600"
                                title="删除评论"
                              >
                                <Trash2 className="w-2.5 h-2.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* 快捷评论输入栏 */}
                {activeReplyPostId === post.id && (
                  <div className="pt-1.5 space-y-1 animate-fadeIn">
                    {replyTarget && (
                      <div className="flex items-center justify-between px-2 py-0.5 bg-white/40 rounded-lg text-[10px] font-serif text-stone-600">
                        <span>回复 @{replyTarget.authorName}</span>
                        <button
                          onClick={() => setReplyTarget(null)}
                          className="text-stone-400 hover:text-stone-700"
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    )}
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={replyInputText}
                        onChange={(e) => setReplyInputText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSendComment(post.id);
                          }
                        }}
                        placeholder={
                          replyTarget
                            ? `回复 @${replyTarget.authorName}...`
                            : '轻言细语，留下一笔...'
                        }
                        className="flex-1 bg-white/50 border border-white/60 rounded-xl px-2.5 py-1.5 text-xs font-serif text-stone-900 placeholder:text-stone-400 focus:outline-none focus:bg-white/80"
                        autoFocus
                      />
                      <button
                        onClick={() => handleSendComment(post.id)}
                        disabled={!replyInputText.trim() || isSubmittingReply}
                        className="p-1.5 rounded-xl bg-stone-900/10 hover:bg-stone-900/20 disabled:opacity-30 text-stone-800 transition-colors cursor-pointer"
                      >
                        <Send className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })
        )}

        {/* 分页加载更多按钮 */}
        {hasMore && (
          <div className="pt-2 pb-6 text-center">
            <button
              onClick={() => nextCursor && loadPosts(nextCursor)}
              disabled={isLoading}
              className="px-4 py-1.5 rounded-full bg-white/30 border border-white/50 text-xs font-serif text-stone-700 hover:bg-white/50 disabled:opacity-50 transition-colors"
            >
              {isLoading ? '加载中...' : '加载更多岁月痕迹'}
            </button>
          </div>
        )}
      </div>

      {/* 发布动态浮层 (Modal) - Portal 挂载到 body 最顶层 */}
      {isPublishOpen && typeof document !== 'undefined' && createPortal(
        <div
          onClick={() => setIsPublishOpen(false)}
          className="fixed inset-0 z-[9999] flex items-end justify-center bg-stone-900/60 backdrop-blur-xs animate-[fadeIn_0.2s_ease-out]"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-full sm:max-w-md bg-[#f9f5ee] rounded-t-3xl sm:rounded-3xl p-5 pb-8 sm:pb-5 space-y-4 shadow-2xl border-t border-x sm:border border-white/60 max-h-[90dvh] flex flex-col overflow-y-auto"
          >
            {/* 浮层头部 */}
            <div className="flex items-center justify-between pb-1 border-b border-stone-800/10">
              <span className="font-calligraphy text-2xl text-stone-900">
                Partager un Instant
              </span>
              <button
                type="button"
                onClick={() => setIsPublishOpen(false)}
                className="p-1.5 rounded-full text-stone-400 hover:text-stone-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 文字正文输入 */}
            <textarea
              value={publishText}
              onChange={(e) => setPublishText(e.target.value)}
              placeholder="落花水面皆文章，此刻有什么想分享的心情或见闻？"
              className="w-full min-h-[96px] bg-white/40 border border-stone-800/10 rounded-2xl p-3 text-xs font-serif text-stone-900 placeholder:text-stone-400 focus:outline-none focus:bg-white/80 resize-none leading-relaxed"
              rows={4}
            />

            {/* 图片预览列表 */}
            {publishImages.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {publishImages.map((img, i) => (
                  <div
                    key={i}
                    className="relative aspect-square rounded-xl overflow-hidden border border-white/60 bg-stone-200"
                  >
                    <img src={img.dataUrl} alt="preview" className="w-full h-full object-cover" />
                    <button
                      type="button"
                      onClick={() => handleRemovePublishImage(i)}
                      className="absolute top-1 right-1 p-1 rounded-full bg-stone-900/60 text-white hover:bg-stone-900 cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* 地点输入 */}
            <div className="flex items-center gap-2 px-3 py-2 bg-white/30 border border-stone-800/10 rounded-xl">
              <MapPin className="w-4 h-4 text-stone-400 shrink-0" />
              <input
                type="text"
                value={publishLocation}
                onChange={(e) => setPublishLocation(e.target.value)}
                placeholder="所在地点（可选，如：巴黎莫奈花园、书房窗前）"
                className="w-full bg-transparent text-xs font-serif text-stone-900 placeholder:text-stone-400 focus:outline-none"
              />
            </div>

            {/* 错误提示 */}
            {publishError && (
              <p className="text-[11px] font-serif text-rose-700 bg-rose-50/80 p-2 rounded-xl">
                {publishError}
              </p>
            )}

            {/* 底部按钮栏 */}
            <div className="flex items-center justify-between pt-2">
              <div className="flex items-center gap-2">
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  ref={fileInputRef}
                  onChange={handleSelectFiles}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={publishImages.length >= 9}
                  className="p-2 rounded-xl bg-white/50 border border-white/60 text-stone-700 hover:bg-white/80 transition-colors disabled:opacity-40 cursor-pointer"
                  title="添加图片"
                >
                  <ImageIcon className="w-4 h-4" />
                </button>
                <span className="text-[10px] font-mono text-stone-500">
                  {publishImages.length}/9
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsPublishOpen(false)}
                  className="px-4 py-1.5 rounded-xl text-xs font-serif text-stone-600 hover:bg-stone-900/5 transition-colors cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handlePublish}
                  disabled={isPublishing || (!publishText.trim() && publishImages.length === 0)}
                  className="px-5 py-1.5 rounded-xl bg-stone-900 text-white font-serif text-xs hover:bg-stone-800 disabled:opacity-40 transition-all shadow-xs cursor-pointer"
                >
                  {isPublishing ? '发布中...' : '发布'}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 全屏大图浏览 Modal - Portal 挂载到 body 最顶层 */}
      {lightboxImageUrl && typeof document !== 'undefined' && createPortal(
        <div
          onClick={() => setLightboxImageUrl(null)}
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/85 backdrop-blur-md p-4 cursor-zoom-out animate-fadeIn"
        >
          <button
            type="button"
            onClick={() => setLightboxImageUrl(null)}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/20 text-white hover:bg-white/30 cursor-pointer"
          >
            <X className="w-6 h-6" />
          </button>
          <img
            src={lightboxImageUrl}
            alt="Agrandissement"
            className="max-w-full max-h-[90vh] object-contain rounded-xl shadow-2xl"
            referrerPolicy="no-referrer"
          />
        </div>,
        document.body
      )}
    </div>
  );
};
