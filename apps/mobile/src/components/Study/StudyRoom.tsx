/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * 手机端书房 · 沉浸式手稿案台
 */

import { useEffect, useState, useRef } from 'react';
import { ArrowLeft, BookPlus, Feather, Check, Edit3, Lock, X, Eye, EyeOff, RotateCcw, ChevronLeft, ChevronRight, BookOpen } from 'lucide-react';
import {
  fetchStudyBooks,
  fetchStudyBook,
  appendStudySection,
  createStudyBook,
  addStudyAnnotation,
  markStudyInkDry,
  submitStudyRevision,
  setStudySectionHidden,
  requestStudySectionRewrite,
  cancelStudySectionRewrite,
  type StudyBook,
  type StudyBookSummary,
  type StudySection,
} from '../../utils/studyApi';
import './study.css';
import '../Diary/diary.css';
import { studyReading } from '../../utils/diaryReading';
import { DiaryReadingControls } from '../Diary/DiaryReadingControls';

// 已配置成员专属墨水颜色
const INK_COLORS: Record<string, { color: string; label: string }> = {
  agent_owner: { color: '#8a4b38', label: '玫瑰赭石' },
  agent_coordinator: { color: '#385268', label: '沉静黛蓝' },
  agent_research: { color: '#4a6350', label: '松针苔绿' },
  agent_editor: { color: '#82593d', label: '暖杏焦糖' },
  agent_worker: { color: '#8c5068', label: '丁香暮紫' },
  agent_reviewer: { color: '#564d66', label: '云母深灰' },
};

export function StudyRoom({ onBackToHome }: { onBackToHome: () => void }) {
  const [books, setBooks] = useState<StudyBookSummary[]>([]);
  const [activeBook, setActiveBook] = useState<StudyBook | null>(null);
  const [loading, setLoading] = useState(true);

  // 动笔写稿抽屉
  const [writingOpen, setWritingOpen] = useState(false);
  const [writeText, setWriteText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 批注弹窗
  const [selectedQuote, setSelectedQuote] = useState('');
  const [targetSectionId, setTargetSectionId] = useState('');
  const [commentText, setCommentText] = useState('');
  const [annotating, setAnnotating] = useState(false);

  // 使用者修改手稿
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // 驳回重写弹窗
  const [rewritingSectionId, setRewritingSectionId] = useState<string | null>(null);
  const [rewriteAuthorName, setRewriteAuthorName] = useState('');
  const [rewriteReasonInput, setRewriteReasonInput] = useState('');
  const [submittingRewrite, setSubmittingRewrite] = useState(false);

  // 新建书卷弹窗
  const [creatingBook, setCreatingBook] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newMotif, setNewMotif] = useState('');
  const [newFirstSection, setNewFirstSection] = useState('');

  // 字体和字号：只存在这台手机上，跟日记分开
  const [readingOpen, setReadingOpen] = useState(false);
  const { style: readingStyle } = studyReading.useReading();

  // 翻页与单折阅读状态
  const [currentSectionIndex, setCurrentSectionIndex] = useState(0);
  const [slideDirection, setSlideDirection] = useState<'next' | 'prev' | 'none'>('none');
  const [tocOpen, setTocOpen] = useState(false);
  const viewportRef = useRef<HTMLElement | null>(null);
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);

  // 当切换书稿或初次加载书卷时，默认定位到最后一折（最新接力）：
  const prevBookIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeBook && activeBook.id !== prevBookIdRef.current) {
      prevBookIdRef.current = activeBook.id;
      const count = activeBook.sections?.length || 0;
      setCurrentSectionIndex(count > 0 ? count - 1 : 0);
    }
  }, [activeBook?.id]);

  const totalSections = activeBook?.sections?.length || 0;
  const safeIndex = Math.min(Math.max(0, currentSectionIndex), Math.max(0, totalSections - 1));

  const goToPrevSection = () => {
    if (safeIndex > 0) {
      setSlideDirection('prev');
      setCurrentSectionIndex(safeIndex - 1);
      if (viewportRef.current) {
        viewportRef.current.scrollTo({ top: 0, behavior: 'instant' });
      }
    }
  };

  const goToNextSection = () => {
    if (safeIndex < totalSections - 1) {
      setSlideDirection('next');
      setCurrentSectionIndex(safeIndex + 1);
      if (viewportRef.current) {
        viewportRef.current.scrollTo({ top: 0, behavior: 'instant' });
      }
    }
  };

  const jumpToSection = (idx: number) => {
    if (idx >= 0 && idx < totalSections) {
      setSlideDirection(idx > safeIndex ? 'next' : 'prev');
      setCurrentSectionIndex(idx);
      setTocOpen(false);
      if (viewportRef.current) {
        viewportRef.current.scrollTo({ top: 0, behavior: 'instant' });
      }
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      touchStartRef.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        time: Date.now(),
      };
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStartRef.current) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;
    const dt = Date.now() - touchStartRef.current.time;
    touchStartRef.current = null;

    // 严谨判定：水平滑动手势（dx > 42px，且水平位移明显大于纵向位移的 1.3 倍，时间在 800ms 以内）
    if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.3 && dt < 800) {
      if (dx < 0) {
        goToNextSection();
      } else {
        goToPrevSection();
      }
    }
  };

  const loadBooks = async () => {
    try {
      const list = await fetchStudyBooks();
      setBooks(list || []);
      if (list && list.length > 0 && !activeBook) {
        const full = await fetchStudyBook(list[0].id);
        setActiveBook(full);
      }
    } catch (e) {
      console.warn('读取手稿列表失败', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBooks();
    const timer = setInterval(() => {
      if (activeBook?.id) {
        fetchStudyBook(activeBook.id).then((b) => {
          if (b) setActiveBook(b);
        }).catch(() => {});
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [activeBook?.id]);

  // 划选文字触发批注
  const handleSelection = (sectionId: string) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      const text = sel.toString().trim();
      if (text.length > 0 && text.length < 300) {
        setSelectedQuote(text);
        setTargetSectionId(sectionId);
        setAnnotating(true);
      }
    }
  };

  const submitAnnotation = async () => {
    if (!activeBook || !targetSectionId || !commentText.trim()) return;
    try {
      await addStudyAnnotation({
        bookId: activeBook.id,
        sectionId: targetSectionId,
        quote: selectedQuote,
        comment: commentText.trim(),
      });
      setAnnotating(false);
      setSelectedQuote('');
      setCommentText('');
      const updated = await fetchStudyBook(activeBook.id);
      setActiveBook(updated);
      if (updated?.sections?.length) {
        setSlideDirection('next');
        setCurrentSectionIndex(updated.sections.length - 1);
        if (viewportRef.current) {
          viewportRef.current.scrollTo({ top: 0, behavior: 'instant' });
        }
      }
    } catch (e: any) {
      alert(e.message || '批注保存失败');
    }
  };

  const handleStartEdit = (sec: StudySection) => {
    setEditingSectionId(sec.id);
    setEditingText(sec.text);
  };

  const handleSaveEdit = async () => {
    if (!activeBook || !editingSectionId || !editingText.trim()) return;
    setSavingEdit(true);
    try {
      await submitStudyRevision({
        bookId: activeBook.id,
        sectionId: editingSectionId,
        revisedText: editingText.trim(),
      });
      setEditingSectionId(null);
      setEditingText('');
      const updated = await fetchStudyBook(activeBook.id);
      setActiveBook(updated);
      if (updated?.sections?.length) {
        setSlideDirection('next');
        setCurrentSectionIndex(updated.sections.length - 1);
        if (viewportRef.current) {
          viewportRef.current.scrollTo({ top: 0, behavior: 'instant' });
        }
      }
    } catch (e: any) {
      alert(e.message || '修改手稿失败');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleToggleHidden = async (sec: StudySection) => {
    if (!activeBook) return;
    try {
      await setStudySectionHidden({
        bookId: activeBook.id,
        sectionId: sec.id,
        hidden: !sec.hidden,
      });
      const updated = await fetchStudyBook(activeBook.id);
      setActiveBook(updated);
      if (updated?.sections?.length) {
        setSlideDirection('next');
        setCurrentSectionIndex(updated.sections.length - 1);
        if (viewportRef.current) {
          viewportRef.current.scrollTo({ top: 0, behavior: 'instant' });
        }
      }
    } catch (e: any) {
      alert(e.message || '操作隐藏失败');
    }
  };

  const handleStartRewrite = (sec: StudySection) => {
    setRewritingSectionId(sec.id);
    setRewriteAuthorName(sec.authorName);
    setRewriteReasonInput(sec.rewriteReason || '');
  };

  const handleConfirmRewrite = async () => {
    if (!activeBook || !rewritingSectionId) return;
    setSubmittingRewrite(true);
    try {
      await requestStudySectionRewrite({
        bookId: activeBook.id,
        sectionId: rewritingSectionId,
        reason: rewriteReasonInput.trim(),
      });
      setRewritingSectionId(null);
      setRewriteReasonInput('');
      const updated = await fetchStudyBook(activeBook.id);
      setActiveBook(updated);
      if (updated?.sections?.length) {
        setSlideDirection('next');
        setCurrentSectionIndex(updated.sections.length - 1);
        if (viewportRef.current) {
          viewportRef.current.scrollTo({ top: 0, behavior: 'instant' });
        }
      }
    } catch (e: any) {
      alert(e.message || '驳回重写失败');
    } finally {
      setSubmittingRewrite(false);
    }
  };

  const handleCancelRewrite = async (sec: StudySection) => {
    if (!activeBook) return;
    try {
      await cancelStudySectionRewrite({
        bookId: activeBook.id,
        sectionId: sec.id,
      });
      const updated = await fetchStudyBook(activeBook.id);
      setActiveBook(updated);
      if (updated?.sections?.length) {
        setSlideDirection('next');
        setCurrentSectionIndex(updated.sections.length - 1);
        if (viewportRef.current) {
          viewportRef.current.scrollTo({ top: 0, behavior: 'instant' });
        }
      }
    } catch (e: any) {
      alert(e.message || '取消驳回失败');
    }
  };

  const handleMarkDry = async (sectionId: string) => {
    if (!activeBook) return;
    try {
      await markStudyInkDry({ bookId: activeBook.id, sectionId });
      const updated = await fetchStudyBook(activeBook.id);
      setActiveBook(updated);
      if (updated?.sections?.length) {
        setSlideDirection('next');
        setCurrentSectionIndex(updated.sections.length - 1);
        if (viewportRef.current) {
          viewportRef.current.scrollTo({ top: 0, behavior: 'instant' });
        }
      }
    } catch (e: any) {
      alert(e.message || '操作失败');
    }
  };

  const submitSection = async () => {
    if (!activeBook || !writeText.trim()) return;
    setSubmitting(true);
    try {
      await appendStudySection({
        bookId: activeBook.id,
        text: writeText.trim(),
      });
      setWriteText('');
      setWritingOpen(false);
      const updated = await fetchStudyBook(activeBook.id);
      setActiveBook(updated);
      if (updated?.sections?.length) {
        setSlideDirection('next');
        setCurrentSectionIndex(updated.sections.length - 1);
        if (viewportRef.current) {
          viewportRef.current.scrollTo({ top: 0, behavior: 'instant' });
        }
      }
    } catch (e: any) {
      alert(e.message || '动笔提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateBook = async () => {
    if (!newTitle.trim()) {
      alert('请先填写书名');
      return;
    }
    try {
      const book = await createStudyBook({
        title: newTitle.trim(),
        motif: newMotif.trim(),
        firstSectionText: newFirstSection.trim(),
      });
      setCreatingBook(false);
      setNewTitle('');
      setNewMotif('');
      setNewFirstSection('');
      setActiveBook(book);
      loadBooks();
    } catch (e: any) {
      alert(e.message || '开新书失败');
    }
  };

  return (
    <div className="study-mobile-container">
      {/* 顶部案台导航栏 */}
      <header className="study-mobile-topbar">
        <button
          type="button"
          className="study-mobile-back-btn"
          onClick={onBackToHome}
          aria-label="返回首页"
        >
          <ArrowLeft size={18} />
        </button>

        <div className="study-mobile-title-block">
          <div className="study-mobile-title-row">
            {books.length > 1 && activeBook ? (
              <select
                aria-label="选择手稿"
                value={activeBook.id}
                onChange={async (e) => {
                  const b = await fetchStudyBook(e.target.value);
                  if (b) setActiveBook(b);
                }}
                style={{
                  background: 'rgba(255,255,255,0.7)',
                  border: '1px solid rgba(138, 75, 56, 0.25)',
                  borderRadius: 12,
                  padding: '2px 6px',
                  fontWeight: 600,
                  color: '#44382e',
                  fontSize: 13,
                  outline: 'none',
                  maxWidth: 150,
                }}
              >
                {books.map((b) => (
                  <option key={b.id} value={b.id}>
                    《{b.title}》
                  </option>
                ))}
              </select>
            ) : (
              <span className="study-mobile-book-title">
                {loading ? '翻阅手稿匣...' : activeBook ? `《${activeBook.title}》` : '暂无手稿'}
              </span>
            )}
            
            {activeBook?.currentLock ? (
              <span className="study-mobile-status-badge study-mobile-status-badge--lock">
                <Lock size={10} /> {activeBook.currentLock.authorName} ({activeBook.currentLock.expiresInSeconds}s)
              </span>
            ) : (
              <span className="study-mobile-status-badge">可接力</span>
            )}
          </div>
        </div>

        <div className="study-mobile-actions">
          <button
            type="button"
            className="study-mobile-btn-icon study-mobile-btn-aa"
            onClick={() => setReadingOpen(true)}
            aria-label="字体和字号"
            title="字体和字号"
          >
            <span>Aa</span>
          </button>
          <button
            type="button"
            className="study-mobile-btn-icon"
            onClick={() => setCreatingBook(true)}
          >
            <BookPlus size={13} />
            <span>新书</span>
          </button>
        </div>
      </header>

      {/* 手稿纸流式内容区（单人单页，独立上下滑动阅读） */}
      <main
        ref={viewportRef}
        className="study-mobile-viewport"
        style={readingStyle}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {activeBook && totalSections > 0 ? (
          (() => {
            const sec = activeBook.sections[safeIndex];
            if (!sec) return null;
            const ink = INK_COLORS[sec.authorId] || { color: '#44382e', label: '古墨' };
            const animClass = slideDirection === 'next' ? 'study-page-enter-next' : slideDirection === 'prev' ? 'study-page-enter-prev' : '';
            return (
              <article
                key={sec.id}
                className={`study-mobile-sheet ${sec.inkWet ? 'study-mobile-sheet--wet' : ''} ${animClass}`}
                data-sheet={(safeIndex % 3) + 1}
                onMouseUp={() => handleSelection(sec.id)}
                onTouchEnd={() => handleSelection(sec.id)}
              >
                <div className="study-mobile-sheet__header">
                  <div className="study-mobile-sheet__author" style={{ color: ink.color }}>
                    <Feather size={13} />
                    <span>{sec.authorName}</span>
                    <small style={{ color: '#9c8774', fontWeight: 400 }}>（{ink.label}）</small>
                  </div>
                  <div className="study-mobile-sheet__meta" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>第 {safeIndex + 1} 折</span>
                    {sec.authorId === 'agent_owner' ? (
                      <button
                        type="button"
                        title="修润修改自己写的段落"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStartEdit(sec);
                        }}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 2,
                          background: 'rgba(138, 75, 56, 0.08)',
                          border: '1px solid rgba(138, 75, 56, 0.25)',
                          borderRadius: 10,
                          padding: '1px 6px',
                          fontSize: 10,
                          color: '#8a4b38',
                          cursor: 'pointer',
                          fontWeight: 600,
                        }}
                      >
                        <Edit3 size={10} /> 编辑
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          title={sec.hidden ? "取消隐藏（作者与后续接写重新可读）" : "隐藏此折（仅掌柜可见，作者与后续接写不读）"}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleHidden(sec);
                          }}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 2,
                            background: sec.hidden ? 'rgba(74, 99, 80, 0.12)' : 'rgba(100, 90, 80, 0.08)',
                            border: sec.hidden ? '1px solid rgba(74, 99, 80, 0.35)' : '1px solid rgba(100, 90, 80, 0.25)',
                            borderRadius: 10,
                            padding: '1px 6px',
                            fontSize: 10,
                            color: sec.hidden ? '#3d5942' : '#68594e',
                            cursor: 'pointer',
                            fontWeight: 600,
                          }}
                        >
                          {sec.hidden ? <Eye size={10} /> : <EyeOff size={10} />}
                          {sec.hidden ? '已隐藏' : '隐藏'}
                        </button>

                        {sec.needsRewrite ? (
                          <button
                            type="button"
                            title="取消驳回重写状态"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCancelRewrite(sec);
                            }}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 2,
                              background: 'rgba(184, 134, 11, 0.15)',
                              border: '1px solid rgba(184, 134, 11, 0.4)',
                              borderRadius: 10,
                              padding: '1px 6px',
                              fontSize: 10,
                              color: '#946900',
                              cursor: 'pointer',
                              fontWeight: 600,
                            }}
                          >
                            <RotateCcw size={10} /> 取消重写
                          </button>
                        ) : (
                          <button
                            type="button"
                            title="驳回此折，要求作者按批注重写"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStartRewrite(sec);
                            }}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 2,
                              background: 'rgba(138, 75, 56, 0.08)',
                              border: '1px solid rgba(138, 75, 56, 0.25)',
                              borderRadius: 10,
                              padding: '1px 6px',
                              fontSize: 10,
                              color: '#8a4b38',
                              cursor: 'pointer',
                              fontWeight: 600,
                            }}
                          >
                            <RotateCcw size={10} /> 重写
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {sec.hidden && (
                  <div style={{
                    fontSize: 11,
                    color: '#4a6350',
                    background: 'rgba(74, 99, 80, 0.1)',
                    border: '1px dashed rgba(74, 99, 80, 0.3)',
                    padding: '4px 8px',
                    borderRadius: 6,
                    marginBottom: 8,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4
                  }}>
                    <EyeOff size={12} />
                    <span>【已隐藏】仅掌柜可见，作者与后续接写不读此段，不影响上下文理解</span>
                  </div>
                )}

                {sec.needsRewrite && (
                  <div style={{
                    fontSize: 11,
                    color: '#8a4b38',
                    background: 'rgba(138, 75, 56, 0.1)',
                    border: '1px dashed rgba(138, 75, 56, 0.3)',
                    padding: '4px 8px',
                    borderRadius: 6,
                    marginBottom: 8,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 600 }}>
                      <RotateCcw size={12} />
                      <span>【已打回重写】等待作者（{sec.authorName}）按修改意见与批注重写</span>
                    </div>
                    {sec.rewriteReason && (
                      <div style={{ fontSize: 10.5, color: '#684033', paddingLeft: 16 }}>
                        修改要求：{sec.rewriteReason}
                      </div>
                    )}
                  </div>
                )}

                <div
                  className="study-mobile-sheet__text"
                  style={{ color: ink.color, opacity: sec.hidden ? 0.75 : 1 }}
                >
                  {sec.text}
                </div>

                {/* 墨迹未干浮条与放行按钮 */}
                {sec.inkWet && (
                  <div className="study-mobile-wet-bar">
                    <span>✨ 墨迹未干 · 使用者可划词批注</span>
                    <button
                      type="button"
                      className="study-mobile-wet-dry-btn"
                      onClick={() => handleMarkDry(sec.id)}
                    >
                      放行风干
                    </button>
                  </div>
                )}

                {/* 批注便签 */}
                {sec.notes && sec.notes.length > 0 && (
                  <div className="study-mobile-annotations">
                    {sec.notes.map((n) => (
                      <div key={n.id} className="study-mobile-annotation-item">
                        <div className="study-mobile-annotation-quote">“{n.quote}”</div>
                        <div>使用者批注：{n.comment}</div>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            );
          })()
        ) : (
          <div style={{ textAlign: 'center', marginTop: 40, color: '#8c7361' }}>
            {loading ? '正在翻阅手稿...' : '案头暂无打开的书卷，点右上角「新书」开篇吧'}
          </div>
        )}
      </main>

      {/* 底部翻页控制器与动笔案台 */}
      {activeBook && totalSections > 0 && (
        <div className="study-mobile-bottom-bar">
          <div className="study-mobile-pager">
            <button
              type="button"
              className="study-mobile-pager__btn"
              disabled={safeIndex <= 0}
              onClick={goToPrevSection}
              aria-label="上一折"
            >
              <ChevronLeft size={16} />
              <span>上一折</span>
            </button>

            <button
              type="button"
              className="study-mobile-pager__indicator"
              onClick={() => setTocOpen(true)}
              title="点击展开全书手稿折数目录"
            >
              <span className="study-mobile-pager__index">第 {safeIndex + 1} / {totalSections} 折</span>
              <span className="study-mobile-pager__dot">·</span>
              <span className="study-mobile-pager__author" style={{ color: (INK_COLORS[activeBook.sections[safeIndex]?.authorId] || {}).color || '#8a4b38' }}>
                {activeBook.sections[safeIndex]?.authorName}
              </span>
            </button>

            <button
              type="button"
              className="study-mobile-pager__btn"
              disabled={safeIndex >= totalSections - 1}
              onClick={goToNextSection}
              aria-label="下一折"
            >
              <span>下一折</span>
              <ChevronRight size={16} />
            </button>
          </div>

          <button
            type="button"
            className="study-mobile-fab-write"
            onClick={() => setWritingOpen(true)}
            aria-label="动笔接力"
          >
            <Feather size={14} />
            <span>动笔</span>
          </button>
        </div>
      )}

      {/* 手稿全折目录抽屉 */}
      {tocOpen && (
        <div className="study-mobile-modal-overlay" onClick={() => setTocOpen(false)}>
          <div className="study-mobile-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="study-mobile-drawer__head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#3e3228' }}>
                <BookOpen size={16} color="#8a4b38" />
                <span>《{activeBook?.title}》手稿折卷目录</span>
              </div>
              <button
                type="button"
                className="study-mobile-back-btn"
                onClick={() => setTocOpen(false)}
              >
                <X size={16} />
              </button>
            </div>

            <div className="study-mobile-toc-list">
              {activeBook?.sections?.map((item, idx) => {
                const itemInk = INK_COLORS[item.authorId] || { color: '#44382e', label: '古墨' };
                const isCurrent = idx === safeIndex;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`study-mobile-toc-item ${isCurrent ? 'study-mobile-toc-item--active' : ''}`}
                    onClick={() => jumpToSection(idx)}
                  >
                    <div className="study-mobile-toc-item__left">
                      <span className="study-mobile-toc-num">第 {idx + 1} 折</span>
                      <span className="study-mobile-toc-author" style={{ color: itemInk.color }}>
                        {item.authorName}
                      </span>
                      {item.hidden && <span className="study-mobile-toc-tag">已隐藏</span>}
                      {item.needsRewrite && <span className="study-mobile-toc-tag study-mobile-toc-tag--rewrite">重写中</span>}
                      {item.inkWet && <span className="study-mobile-toc-tag study-mobile-toc-tag--wet">晾墨中</span>}
                    </div>
                    <div className="study-mobile-toc-snippet">
                      {item.text.slice(0, 32)}…
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* 使用者动笔输入抽屉 */}
      {writingOpen && (
        <div className="study-mobile-modal-overlay" onClick={() => setWritingOpen(false)}>
          <div className="study-mobile-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="study-mobile-drawer__head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#8a4b38' }}>
                <Edit3 size={15} />
                <span>使用者动笔 · 掌柜优先</span>
              </div>
              <button
                type="button"
                className="study-mobile-back-btn"
                onClick={() => setWritingOpen(false)}
              >
                <X size={16} />
              </button>
            </div>

            <textarea
              className="study-mobile-textarea"
              rows={5}
              placeholder="落笔写下一折...（使用者动笔可随时接管砚台）"
              value={writeText}
              onChange={(e) => setWriteText(e.target.value)}
              autoFocus
            />

            <div className="study-mobile-drawer__footer">
              <span style={{ fontSize: 12, color: '#9c8774' }}>{writeText.length} 字</span>
              <button
                type="button"
                className="study-mobile-fab-write"
                style={{ position: 'static', padding: '6px 16px', fontSize: 13 }}
                disabled={submitting || !writeText.trim()}
                onClick={submitSection}
              >
                {submitting ? '落笔中...' : '落墨入匣'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 字体 / 字号（跟日记同一块面板，但分开存） */}
      {readingOpen && (
        <div className="study-mobile-modal-overlay" onClick={() => setReadingOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="字体和字号" className="study-mobile-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="study-mobile-drawer__head">
              <span>阅读</span>
              <button
                type="button"
                className="study-mobile-back-btn"
                onClick={() => setReadingOpen(false)}
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </div>
            <div className="text-xs font-serif" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
              <DiaryReadingControls store={studyReading} />
            </div>
          </div>
        </div>
      )}

      {/* 划词批注抽屉 */}
      {annotating && (
        <div className="study-mobile-modal-overlay" onClick={() => setAnnotating(false)}>
          <div className="study-mobile-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="study-mobile-drawer__head">
              <span>给原文批注</span>
              <button
                type="button"
                className="study-mobile-back-btn"
                onClick={() => setAnnotating(false)}
              >
                <X size={16} />
              </button>
            </div>

            <div className="study-mobile-annotation-quote">“{selectedQuote}”</div>

            <textarea
              className="study-mobile-textarea"
              rows={3}
              placeholder="写下使用者的批注或建议..."
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              autoFocus
            />

            <div className="study-mobile-drawer__footer">
              <span />
              <button
                type="button"
                className="study-mobile-fab-write"
                style={{ position: 'static', padding: '6px 16px', fontSize: 13 }}
                disabled={!commentText.trim()}
                onClick={submitAnnotation}
              >
                贴上批注
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 新建书卷弹窗 */}
      {creatingBook && (
        <div className="study-mobile-modal-overlay" onClick={() => setCreatingBook(false)}>
          <div className="study-mobile-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="study-mobile-drawer__head">
              <span>题签开新卷</span>
              <button
                type="button"
                className="study-mobile-back-btn"
                onClick={() => setCreatingBook(false)}
              >
                <X size={16} />
              </button>
            </div>

            <input
              type="text"
              className="study-mobile-textarea"
              style={{ padding: '8px 12px' }}
              placeholder="书名（如《莫奈花园的夏日秘语》）"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
            />

            <input
              type="text"
              className="study-mobile-textarea"
              style={{ padding: '8px 12px' }}
              placeholder="主旨 / 气味 / 风格意象（选填）"
              value={newMotif}
              onChange={(e) => setNewMotif(e.target.value)}
            />

            <textarea
              className="study-mobile-textarea"
              rows={3}
              placeholder="第一折起笔正文（选填，不填则由大家自荐接龙）"
              value={newFirstSection}
              onChange={(e) => setNewFirstSection(e.target.value)}
            />

            <div className="study-mobile-drawer__footer">
              <span />
              <button
                type="button"
                className="study-mobile-fab-write"
                style={{ position: 'static', padding: '6px 16px', fontSize: 13 }}
                disabled={!newTitle.trim()}
                onClick={handleCreateBook}
              >
                <Check size={14} /> 开卷立案
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 掌柜驳回重写弹窗 */}
      {rewritingSectionId && (
        <div className="study-mobile-modal-overlay" onClick={() => setRewritingSectionId(null)}>
          <div className="study-mobile-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="study-mobile-drawer__head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#8a4b38' }}>
                <RotateCcw size={15} />
                <span>驳回重写 · 要求作者（{rewriteAuthorName}）修改</span>
              </div>
              <button
                type="button"
                className="study-mobile-back-btn"
                onClick={() => setRewritingSectionId(null)}
              >
                <X size={16} />
              </button>
            </div>

            <p style={{ margin: '0 0 10px 0', fontSize: 12, color: '#88705c', lineHeight: 1.6 }}>
              打回后，该作者醒来将优先接单重写此折，后台已强制约束其遵循题材气韵与连贯大段叙事（严禁频繁碎行分行）。
            </p>

            <textarea
              className="study-mobile-textarea"
              rows={4}
              placeholder="填写打回修改意见（选填，如：文风要古言，不要太文绉绉，避免频繁分行碎行。留空则默认按已有划线批注修改）"
              value={rewriteReasonInput}
              onChange={(e) => setRewriteReasonInput(e.target.value)}
              autoFocus
            />

            <div className="study-mobile-drawer__footer" style={{ marginTop: 8 }}>
              <span />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  style={{
                    background: 'transparent',
                    border: '1px solid rgba(138, 75, 56, 0.3)',
                    borderRadius: 18,
                    padding: '6px 14px',
                    fontSize: 13,
                    color: '#634b35',
                    cursor: 'pointer',
                  }}
                  onClick={() => setRewritingSectionId(null)}
                  disabled={submittingRewrite}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="study-mobile-fab-write"
                  style={{ position: 'static', padding: '6px 16px', fontSize: 13 }}
                  onClick={handleConfirmRewrite}
                  disabled={submittingRewrite}
                >
                  {submittingRewrite ? '打回中...' : '确认驳回重写'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 使用者修改手稿弹窗 */}
      {editingSectionId && (
        <div className="study-mobile-modal-overlay" onClick={() => setEditingSectionId(null)}>
          <div className="study-mobile-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="study-mobile-drawer__head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#8a4b38' }}>
                <Edit3 size={15} />
                <span>修改手稿（使用者）</span>
              </div>
              <button
                type="button"
                className="study-mobile-back-btn"
                onClick={() => setEditingSectionId(null)}
              >
                <X size={16} />
              </button>
            </div>

            <p style={{ margin: '0 0 10px 0', fontSize: 12, color: '#88705c' }}>
              在他人提笔接龙之前，你可以随心修润这一折的字句与题引。
            </p>

            <textarea
              className="study-mobile-textarea"
              rows={8}
              placeholder="修改手稿正文..."
              value={editingText}
              onChange={(e) => setEditingText(e.target.value)}
              autoFocus
            />

            <div className="study-mobile-drawer__footer" style={{ marginTop: 8 }}>
              <span style={{ fontSize: 12, color: '#9c8774' }}>{editingText.length} 字</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  style={{
                    background: 'transparent',
                    border: '1px solid rgba(138, 75, 56, 0.3)',
                    borderRadius: 18,
                    padding: '6px 14px',
                    fontSize: 13,
                    color: '#634b35',
                    cursor: 'pointer',
                  }}
                  onClick={() => setEditingSectionId(null)}
                  disabled={savingEdit}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="study-mobile-fab-write"
                  style={{ position: 'static', padding: '6px 16px', fontSize: 13 }}
                  onClick={handleSaveEdit}
                  disabled={savingEdit || !editingText.trim()}
                >
                  {savingEdit ? '保存中...' : '保存手稿'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
