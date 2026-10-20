import { useEffect, useState } from 'react';
import { ArrowLeft, BookPlus, Feather, Check, Edit3, Lock, Eye, EyeOff, RotateCcw } from 'lucide-react';
import './study.css';

// 已配置成员专属墨水颜色
const INK_COLORS: Record<string, { color: string; label: string; ribbon: string }> = {
  agent_owner: { color: '#8a4b38', label: '玫瑰赭石', ribbon: 'warm ivory' },
  agent_coordinator: { color: '#385268', label: '沉静黛蓝', ribbon: 'misty blue' },
  agent_research: { color: '#4a6350', label: '松针苔绿', ribbon: 'moss green' },
  agent_editor: { color: '#82593d', label: '暖杏焦糖', ribbon: 'dusty apricot' },
  agent_worker: { color: '#8c5068', label: '丁香暮紫', ribbon: 'lilac grey' },
  agent_reviewer: { color: '#564d66', label: '云母深灰', ribbon: 'faded rose' },
};

interface StudySection {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  createdAt: number;
  inkWet: boolean;
  inkDriedAt?: number;
  hidden?: boolean;
  needsRewrite?: boolean;
  rewriteReason?: string;
  rewriteRequestedAt?: number;
  revisions: Array<{ text: string; savedAt: number }>;
  notes: Array<{ id: string; quote: string; comment: string; createdAt: number }>;
}

interface StudyBook {
  id: string;
  title: string;
  motif: string;
  status: 'writing' | 'paused' | 'closed';
  createdAt: number;
  updatedAt: number;
  sections: StudySection[];
  currentLock?: {
    authorId: string;
    authorName: string;
    isOwner: boolean;
    expiresInSeconds: number;
  } | null;
}

export function StudyRoom({ onBackToHome }: { onBackToHome: () => void }) {
  const desktop = (window as any).xiaowuDesktop?.study;
  const [books, setBooks] = useState<any[]>([]);
  const [activeBook, setActiveBook] = useState<StudyBook | null>(null);
  const [loading, setLoading] = useState(true);

  // 使用者动笔输入框
  const [writingOpen, setWritingOpen] = useState(false);
  const [writeText, setWriteText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 划线批注弹窗
  const [selectedQuote, setSelectedQuote] = useState('');
  const [targetSectionId, setTargetSectionId] = useState('');
  const [commentText, setCommentText] = useState('');
  const [annotating, setAnnotating] = useState(false);

  // 使用者新建书弹窗
  const [creatingBook, setCreatingBook] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newMotif, setNewMotif] = useState('');
  const [newFirstSection, setNewFirstSection] = useState('');

  // 使用者手稿修改弹窗
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // 驳回重写弹窗
  const [rewritingSectionId, setRewritingSectionId] = useState<string | null>(null);
  const [rewriteAuthorName, setRewriteAuthorName] = useState('');
  const [rewriteReasonInput, setRewriteReasonInput] = useState('');
  const [submittingRewrite, setSubmittingRewrite] = useState(false);

  // 书房总设置（开笔/歇笔）
  const [settings, setSettings] = useState<{ enabled: boolean; reviewMode: boolean; inkDryMinutes: number } | null>(null);

  const handleToggleHidden = async (sec: StudySection) => {
    if (!desktop || !activeBook) return;
    try {
      await desktop.setSectionHidden({
        bookId: activeBook.id,
        sectionId: sec.id,
        hidden: !sec.hidden,
      });
      const updated = await desktop.getBook(activeBook.id);
      if (updated) setActiveBook(updated);
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
    if (!desktop || !activeBook || !rewritingSectionId) return;
    setSubmittingRewrite(true);
    try {
      const res = await desktop.requestSectionRewrite({
        bookId: activeBook.id,
        sectionId: rewritingSectionId,
        reason: rewriteReasonInput.trim(),
      });
      if (res?.ok) {
        setRewritingSectionId(null);
        setRewriteReasonInput('');
        const updated = await desktop.getBook(activeBook.id);
        if (updated) setActiveBook(updated);
      } else {
        alert(res?.error || '驳回重写失败');
      }
    } catch (e: any) {
      alert(e.message || '驳回重写失败');
    } finally {
      setSubmittingRewrite(false);
    }
  };

  const handleCancelRewrite = async (sec: StudySection) => {
    if (!desktop || !activeBook) return;
    try {
      const res = await desktop.cancelSectionRewrite({
        bookId: activeBook.id,
        sectionId: sec.id,
      });
      if (res?.ok) {
        const updated = await desktop.getBook(activeBook.id);
        if (updated) setActiveBook(updated);
      } else {
        alert(res?.error || '取消驳回失败');
      }
    } catch (e: any) {
      alert(e.message || '取消驳回失败');
    }
  };

  const handleStartEdit = (sec: StudySection) => {
    setEditingSectionId(sec.id);
    setEditingText(sec.text);
  };

  const handleSaveEdit = async () => {
    if (!desktop || !activeBook || !editingSectionId || !editingText.trim()) return;
    setSavingEdit(true);
    try {
      const res = await desktop.submitRevision({
        bookId: activeBook.id,
        sectionId: editingSectionId,
        revisedText: editingText.trim(),
        authorId: 'agent_owner',
        isOwner: true,
      });
      if (res?.ok && res.section) {
        setEditingSectionId(null);
        setEditingText('');
        const updated = await desktop.getBook(activeBook.id);
        if (updated) setActiveBook(updated);
      } else {
        alert(res?.error || '修改手稿失败');
      }
    } catch (e: any) {
      alert(e.message || '修改手稿失败');
    } finally {
      setSavingEdit(false);
    }
  };

  const loadBooks = async () => {
    if (!desktop) return;
    try {
      if (desktop.getSettings) {
        desktop.getSettings().then((s: any) => {
          if (s) setSettings(s);
        }).catch(() => {});
      }
      const list = await desktop.getBooks();
      setBooks(list || []);
      if (list && list.length > 0 && !activeBook) {
        const full = await desktop.getBook(list[0].id);
        setActiveBook(full);
      }
    } catch (e) {
      console.warn('读取书单失败', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBooks();
    const timer = setInterval(() => {
      if (activeBook?.id && desktop) {
        desktop.getBook(activeBook.id).then((b: any) => {
          if (b) setActiveBook(b);
        });
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [activeBook?.id]);

  // 划选文字触发批注
  const handleMouseUp = (sectionId: string) => {
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
    if (!desktop || !activeBook || !targetSectionId || !commentText.trim()) return;
    try {
      await desktop.addAnnotation({
        bookId: activeBook.id,
        sectionId: targetSectionId,
        quote: selectedQuote,
        comment: commentText.trim(),
      });
      setAnnotating(false);
      setSelectedQuote('');
      setCommentText('');
      const updated = await desktop.getBook(activeBook.id);
      setActiveBook(updated);
    } catch (e: any) {
      alert(e.message || '批注保存失败');
    }
  };

  const handleMarkDry = async (sectionId: string) => {
    if (!desktop || !activeBook) return;
    try {
      await desktop.markInkDry({ bookId: activeBook.id, sectionId });
      const updated = await desktop.getBook(activeBook.id);
      setActiveBook(updated);
    } catch (e: any) {
      alert(e.message || '操作失败');
    }
  };

  const submitSection = async () => {
    if (!desktop || !activeBook || !writeText.trim()) return;
    setSubmitting(true);
    try {
      await desktop.appendSection({
        bookId: activeBook.id,
        text: writeText.trim(),
      });
      setWriteText('');
      setWritingOpen(false);
      const updated = await desktop.getBook(activeBook.id);
      setActiveBook(updated);
    } catch (e: any) {
      alert(e.message || '动笔提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateBook = async () => {
    if (!desktop || !newTitle.trim()) return;
    try {
      const res = await desktop.createBook({
        title: newTitle.trim(),
        motif: newMotif.trim(),
        firstSectionText: newFirstSection.trim(),
      });
      if (res?.ok && res.book) {
        setCreatingBook(false);
        setNewTitle('');
        setNewMotif('');
        setNewFirstSection('');
        await loadBooks();
        setActiveBook(res.book);
      }
    } catch (e: any) {
      alert(e.message || '开新书失败');
    }
  };

  return (
    <div className="study-room">
      {/* 顶部状态栏 */}
      <header className="study-topbar">
        <button
          type="button"
          className="btn btn--icon"
          title="回到小屋"
          onClick={onBackToHome}
          style={{ background: 'transparent', border: 'none' }}
        >
          <ArrowLeft size={18} />
        </button>

        <span className="study-topbar__title">Bibliothèque</span>

        {loading ? (
          <span style={{ fontSize: 13, color: '#88705c' }}>正在翻阅手稿匣...</span>
        ) : activeBook ? (
          <div className="study-topbar__status">
            {books.length > 1 ? (
              <select
                aria-label="选择手稿"
                value={activeBook.id}
                onChange={async (e) => {
                  const b = await desktop?.getBook(e.target.value);
                  if (b) setActiveBook(b);
                }}
                style={{
                  background: 'rgba(255,255,255,0.7)',
                  border: '1px solid rgba(138, 75, 56, 0.25)',
                  borderRadius: 14,
                  padding: '2px 8px',
                  fontWeight: 600,
                  color: '#44382e',
                  fontSize: 13,
                  outline: 'none',
                }}
              >
                {books.map((b) => (
                  <option key={b.id} value={b.id}>
                    《{b.title}》
                  </option>
                ))}
              </select>
            ) : (
              <strong>《{activeBook.title}》</strong>
            )}
            {activeBook.motif && <span style={{ color: '#88705c' }}>· “{activeBook.motif}”</span>}
            
            {settings && settings.enabled === false ? (
              <span className="study-badge study-badge--lock" style={{ background: 'rgba(138, 75, 56, 0.15)', color: '#8a4b38' }}>
                书房暂时歇笔
              </span>
            ) : activeBook.currentLock ? (
              <span className="study-badge study-badge--lock">
                <Lock size={12} /> {activeBook.currentLock.authorName}正在握笔 ({activeBook.currentLock.expiresInSeconds}s)
              </span>
            ) : (
              <span className="study-badge">笔正搁在砚边 · 可接力</span>
            )}
          </div>
        ) : (
          <span>暂无打开的手稿</span>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
          <button
            type="button"
            className="btn"
            style={{
              borderRadius: 18,
              fontSize: 13,
              background: settings?.enabled === false ? 'rgba(138, 75, 56, 0.15)' : undefined,
              color: settings?.enabled === false ? '#8a4b38' : undefined,
            }}
            title={settings?.enabled === false ? '开笔：允许家人心跳来书房写稿' : '暂时歇笔：暂停家人心跳来写，使用者仍可写'}
            onClick={async () => {
              if (!desktop?.setSettings) return;
              const nextEnabled = settings?.enabled === false;
              const updated = await desktop.setSettings({ enabled: nextEnabled });
              if (updated) setSettings(updated);
            }}
          >
            {settings?.enabled === false ? '开笔' : '暂时歇笔'}
          </button>

          <button
            type="button"
            className="btn"
            style={{ borderRadius: 18, fontSize: 13 }}
            onClick={() => setCreatingBook(true)}
          >
            <BookPlus size={15} style={{ marginRight: 4 }} /> 开新书
          </button>
        </div>
      </header>

      {/* 手稿纸展示区 */}
      <main className="study-viewport">
        {activeBook ? (
          <div className="study-desk">
            {activeBook.sections?.map((sec, idx) => {
              const ink = INK_COLORS[sec.authorId] || { color: '#44382e', label: '古墨', ribbon: '' };
              return (
                <article
                  key={sec.id}
                  className={`study-sheet ${sec.inkWet ? 'study-sheet--wet' : ''}`}
                  data-sheet={(idx % 3) + 1}
                  onMouseUp={() => handleMouseUp(sec.id)}
                >
                  <div className="study-sheet__header">
                    <div className="study-sheet__author" style={{ color: ink.color }}>
                      <Feather size={14} />
                      <span>{sec.authorName}</span>
                      <small style={{ color: '#9c8774', fontWeight: 400 }}>（{ink.label}墨水）</small>
                    </div>
                    <div className="study-sheet__meta" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span>第 {idx + 1} 折 · {new Date(sec.createdAt).toLocaleDateString('zh-CN')}</span>
                      {sec.authorId === 'agent_owner' ? (
                        <button
                          type="button"
                          className="btn btn--icon"
                          title="修润修改自己写的段落"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStartEdit(sec);
                          }}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 3,
                            background: 'rgba(138, 75, 56, 0.08)',
                            border: '1px solid rgba(138, 75, 56, 0.25)',
                            borderRadius: 12,
                            padding: '2px 8px',
                            fontSize: 11,
                            color: '#8a4b38',
                            cursor: 'pointer',
                            fontWeight: 600,
                          }}
                        >
                          <Edit3 size={11} /> 编辑
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn btn--icon"
                            title={sec.hidden ? "取消隐藏（作者与后续接写重新可读）" : "隐藏此折（仅掌柜可见，作者与后续接写不读）"}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleToggleHidden(sec);
                            }}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 3,
                              background: sec.hidden ? 'rgba(74, 99, 80, 0.12)' : 'rgba(100, 90, 80, 0.08)',
                              border: sec.hidden ? '1px solid rgba(74, 99, 80, 0.35)' : '1px solid rgba(100, 90, 80, 0.25)',
                              borderRadius: 12,
                              padding: '2px 8px',
                              fontSize: 11,
                              color: sec.hidden ? '#3d5942' : '#68594e',
                              cursor: 'pointer',
                              fontWeight: 600,
                            }}
                          >
                            {sec.hidden ? <Eye size={11} /> : <EyeOff size={11} />}
                            {sec.hidden ? '已隐藏' : '隐藏'}
                          </button>

                          {sec.needsRewrite ? (
                            <button
                              type="button"
                              className="btn btn--icon"
                              title="取消驳回重写状态"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCancelRewrite(sec);
                              }}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 3,
                                background: 'rgba(184, 134, 11, 0.15)',
                                border: '1px solid rgba(184, 134, 11, 0.4)',
                                borderRadius: 12,
                                padding: '2px 8px',
                                fontSize: 11,
                                color: '#946900',
                                cursor: 'pointer',
                                fontWeight: 600,
                              }}
                            >
                              <RotateCcw size={11} /> 取消重写
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn btn--icon"
                              title="驳回此折，要求作者按批注重写"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleStartRewrite(sec);
                              }}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 3,
                                background: 'rgba(138, 75, 56, 0.08)',
                                border: '1px solid rgba(138, 75, 56, 0.25)',
                                borderRadius: 12,
                                padding: '2px 8px',
                                fontSize: 11,
                                color: '#8a4b38',
                                cursor: 'pointer',
                                fontWeight: 600,
                              }}
                            >
                              <RotateCcw size={11} /> 重写
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {sec.hidden && (
                    <div style={{
                      fontSize: 12,
                      color: '#4a6350',
                      background: 'rgba(74, 99, 80, 0.1)',
                      border: '1px dashed rgba(74, 99, 80, 0.3)',
                      padding: '6px 12px',
                      borderRadius: 6,
                      marginBottom: 12,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6
                    }}>
                      <EyeOff size={14} />
                      <span>【已隐藏】仅掌柜可见，作者本人与后续接写者均不读此段，不影响上下文理解</span>
                    </div>
                  )}

                  {sec.needsRewrite && (
                    <div style={{
                      fontSize: 12,
                      color: '#8a4b38',
                      background: 'rgba(138, 75, 56, 0.1)',
                      border: '1px dashed rgba(138, 75, 56, 0.3)',
                      padding: '6px 12px',
                      borderRadius: 6,
                      marginBottom: 12,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
                        <RotateCcw size={14} />
                        <span>【已打回重写】等待作者（{sec.authorName}）按修改意见与批注重写</span>
                      </div>
                      {sec.rewriteReason && (
                        <div style={{ fontSize: 11.5, color: '#684033', paddingLeft: 20 }}>
                          修改要求：{sec.rewriteReason}
                        </div>
                      )}
                    </div>
                  )}

                  <div
                    className="study-sheet__text"
                    style={{ color: ink.color, opacity: sec.hidden ? 0.75 : 1 }}
                  >
                    {sec.text}
                  </div>

                  {/* 批注展示区 */}
                  {sec.notes && sec.notes.length > 0 && (
                    <div className="study-annotations">
                      {sec.notes.map((n) => (
                        <div key={n.id} className="study-annotation-item">
                          <div className="study-annotation-item__quote">“{n.quote}”</div>
                          <div>使用者批注：{n.comment}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 尾部落款小署名 */}
                  <div className="study-sheet__signature">
                    <span>—— 录于阁楼 · {sec.authorName}</span>
                    {sec.inkWet && (
                      <button
                        type="button"
                        className="btn btn--sm"
                        style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10 }}
                        onClick={() => handleMarkDry(sec.id)}
                      >
                        <Check size={12} style={{ marginRight: 2 }} /> 墨干了（放行）
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div style={{ marginTop: 100, textAlign: 'center', color: '#f3e8dc' }}>
            <h2>书架上还空着</h2>
            <p>点击右上角的“开新书”，立下题签，写下故事的第一段吧。</p>
          </div>
        )}
      </main>

      {/* 底部悬浮工具台 */}
      {activeBook && activeBook.status === 'writing' && (
        <aside className="study-toolbar">
          <button
            type="button"
            className="btn btn--primary"
            style={{ borderRadius: 20, padding: '8px 20px', fontSize: 13 }}
            onClick={() => setWritingOpen(true)}
          >
            <Edit3 size={15} style={{ marginRight: 5 }} /> 使用者动笔续一段
          </button>
        </aside>
      )}

      {/* 使用者动笔模态框 */}
      {writingOpen && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            backgroundColor: 'rgba(28, 20, 14, 0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 680,
              backgroundColor: '#fcf8ee',
              borderRadius: 14,
              padding: 28,
              boxShadow: '0 12px 36px rgba(0,0,0,0.3)',
            }}
          >
            <h3 style={{ margin: '0 0 16px', color: '#543d2b' }}>使用者续写一段</h3>
            <textarea
              className="input"
              rows={12}
              style={{
                width: '100%',
                lineHeight: 1.8,
                fontSize: 15,
                padding: 14,
                backgroundColor: '#fffdf7',
                color: '#443425',
              }}
              placeholder="在这里落笔续写…（使用者享有优先接写权）"
              value={writeText}
              onChange={(e) => setWriteText(e.target.value)}
            />
            <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                className="btn"
                onClick={() => setWritingOpen(false)}
                disabled={submitting}
              >
                搁笔返回
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={submitSection}
                disabled={submitting || !writeText.trim()}
              >
                {submitting ? '正在落墨…' : '誊入手稿'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 划线批注模态框 */}
      {annotating && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            backgroundColor: 'rgba(28, 20, 14, 0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 520,
              backgroundColor: '#fffcf5',
              borderRadius: 14,
              padding: 24,
              boxShadow: '0 12px 36px rgba(0,0,0,0.3)',
            }}
          >
            <h3 style={{ margin: '0 0 12px', color: '#543d2b' }}>划线 · 批注</h3>
            <p style={{ fontStyle: 'italic', color: '#8c6b44', fontSize: 13, margin: '0 0 14px' }}>
              选定文本：“{selectedQuote}”
            </p>
            <textarea
              className="input"
              rows={4}
              style={{ width: '100%', padding: 10 }}
              placeholder="写下对这段文字的批注或修改想法…"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
            />
            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                className="btn"
                onClick={() => setAnnotating(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={submitAnnotation}
                disabled={!commentText.trim()}
              >
                批注完成
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 使用者开新书模态框 */}
      {creatingBook && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            backgroundColor: 'rgba(28, 20, 14, 0.65)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 560,
              backgroundColor: '#fdfbf6',
              borderRadius: 14,
              padding: 28,
            }}
          >
            <h3 style={{ margin: '0 0 16px', color: '#543d2b' }}>开新书 · 题签</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: 13, marginBottom: 5 }}>书名</label>
                <input
                  className="input"
                  style={{ width: '100%' }}
                  placeholder="例如：《海风与玫瑰》、《阁楼长夏》"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 13, marginBottom: 5 }}>题签（关键词、想要的感觉）</label>
                <input
                  className="input"
                  style={{ width: '100%' }}
                  placeholder="例如：白灯塔、潮湿的盛夏、重逢"
                  value={newMotif}
                  onChange={(e) => setNewMotif(e.target.value)}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 13, marginBottom: 5 }}>第一段（使用者可选先写）</label>
                <textarea
                  className="input"
                  rows={5}
                  style={{ width: '100%' }}
                  placeholder="写下故事的开篇，或者留给第一个醒来的家人…"
                  value={newFirstSection}
                  onChange={(e) => setNewFirstSection(e.target.value)}
                />
              </div>
            </div>
            <div style={{ marginTop: 22, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button type="button" className="btn" onClick={() => setCreatingBook(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={handleCreateBook}
                disabled={!newTitle.trim()}
              >
                立下书卷
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 掌柜驳回重写弹窗 */}
      {rewritingSectionId && (
        <div
          className="study-modal-overlay"
          onClick={() => setRewritingSectionId(null)}
        >
          <div
            className="study-modal"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 540 }}
          >
            <h3 style={{ margin: '0 0 12px 0', color: '#8a4b38', display: 'flex', alignItems: 'center', gap: 6 }}>
              <RotateCcw size={18} /> 驳回重写 · 要求作者（{rewriteAuthorName}）修改
            </h3>
            <p style={{ margin: '0 0 12px 0', fontSize: 13, color: '#88705c', lineHeight: 1.6 }}>
              打回后，后台将在该作者下一次心跳或醒来时强制优先派发重写，并硬性约束其文风契合故事气韵（严禁频繁碎行分行，保持大段连贯叙事）。
            </p>
            <textarea
              className="input"
              style={{ width: '100%', minHeight: 120, lineHeight: 1.6, fontSize: 13.5 }}
              value={rewriteReasonInput}
              onChange={(e) => setRewriteReasonInput(e.target.value)}
              placeholder="填写打回修改意见（选填，如：文风要古言，不要太文绉绉，避免频繁分行碎行。留空则默认按已有划线批注修改）..."
              autoFocus
            />
            <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                className="btn"
                onClick={() => setRewritingSectionId(null)}
                disabled={submittingRewrite}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={handleConfirmRewrite}
                disabled={submittingRewrite}
              >
                {submittingRewrite ? '打回中...' : '确认驳回重写'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 使用者修改手稿弹窗 */}
      {editingSectionId && (
        <div className="study-modal-overlay" onClick={() => setEditingSectionId(null)}>
          <div
            className="study-modal"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 640 }}
          >
            <h3 style={{ margin: '0 0 12px 0', color: '#8a4b38', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Edit3 size={18} /> 修改手稿（使用者）
            </h3>
            <p style={{ margin: '0 0 10px 0', fontSize: 13, color: '#88705c' }}>
              在他人提笔接龙之前，你可以随心修润这一折的字句与题引。
            </p>
            <textarea
              className="input"
              style={{ width: '100%', minHeight: 220, lineHeight: 1.7, fontSize: 14 }}
              value={editingText}
              onChange={(e) => setEditingText(e.target.value)}
              placeholder="修改手稿正文..."
              autoFocus
            />
            <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                className="btn"
                onClick={() => setEditingSectionId(null)}
                disabled={savingEdit}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={handleSaveEdit}
                disabled={savingEdit || !editingText.trim()}
              >
                {savingEdit ? '保存中...' : '保存手稿'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
