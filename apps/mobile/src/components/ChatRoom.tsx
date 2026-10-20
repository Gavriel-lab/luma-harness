/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { CHARACTERS } from '../data/characters';
import { Character, Message, MessageDto, ConversationDto, SendChatAttachment } from '../types';
import { bubbleAppearance, useChatAppearance, useLiquidGlass } from '../utils/chatAppearance';
import replyRules from '../../../desktop/electron/chatReplies.cjs';
import { MarkdownView } from './MarkdownView';
import { 
  fetchConversations,
  fetchMembers,
  fetchMessages, 
  postChatJob, 
  pollChatJob, 
  fetchTtsVoice,
  deleteChatMessage,
  LumaApiError 
} from '../utils/apiClient';
import { 
  SessionStateManager, 
  reconcileMessages,
  setCachedMedia,
  getCachedVoice,
  restoreRetryMedia,
  setCachedVoice
} from '../utils/conversationReconciler';
import { getAllMemberAvatars } from '../utils/assetManager';
import { transcribeVoice, blobDataUrl, recordingMime, speechText } from '../utils/speechApi';
import { restoreVoices, persistVoice } from '../utils/voiceCache';
import { ChatRoomSettingsModal, getSingleChatConfig, SingleChatConfig } from './ChatRoomSettingsModal';
import { ChatMemoriesModal } from './ChatMemoriesModal';
import { XiaoduChannelModal, isXiaoduMessage } from './XiaoduChannelModal';
import { ChatWallpaper } from './ChatWallpaper';
import { StickerPickerModal } from './StickerPickerModal';
import './chatSalon.css';

const sealUrl = `${import.meta.env.BASE_URL}assets/salon/seal-rose.webp`;
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const CN_DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const cnNumber = (n: number) => n <= 10 ? CN_DIGITS[n] : n < 20 ? `十${CN_DIGITS[n - 10]}` : `${CN_DIGITS[Math.floor(n / 10)]}十${n % 10 ? CN_DIGITS[n % 10] : ''}`;
/** 消息所在的日子；没有原始时间的（本地刚发的）算今天 */
const messageDay = (msg: Message) => {
  const date = msg.createdAt ? new Date(msg.createdAt) : new Date();
  return isNaN(date.getTime()) ? null : date;
};
const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
const dayLabel = (date: Date) => `${cnNumber(date.getMonth() + 1)}月${cnNumber(date.getDate())}日 · ${WEEKDAYS[date.getDay()]}`;
import { 
  Radio,
  ChevronDown, 
  BookOpen,
  Send, 
  Paperclip,
  Smile,
  Mic,
  MicOff,
  X, 
  Sliders,
  Volume2, 
  VolumeX,
  RotateCcw,
  AlertTriangle,
  Loader2,
  WifiOff,
  Square,
  AlertCircle,
  FileText,
  Maximize2,
  Download,
  Play,
  Pause,
  Image as ImageIcon,
  Copy,
  Quote,
  Bookmark,
  Trash2,
  Check
} from 'lucide-react';

interface ChatRoomProps {
  onBackToHome: () => void;
  onBackToList?: () => void;
  initialCharacterId?: string;
  customChatBgUrl: string | null;
  groupConversation?: ConversationDto;
}

interface PendingAttachment {
  type: 'image' | 'file';
  name: string;
  size: number;
  dataUrl: string;
}

function formatMessageTime(isoString?: string): string {
  if (!isoString) {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '';
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  } catch {
    return '';
  }
}

function formatFileSize(bytes?: number): string {
  if (!bytes || isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const ChatRoom: React.FC<ChatRoomProps> = ({ 
  onBackToHome, 
  onBackToList, 
  initialCharacterId, 
  customChatBgUrl,
  groupConversation,
}) => {
  // 当前选中的目标成员 ID
  const [activeCharacterId, setActiveCharacterId] = useState<string>(
    initialCharacterId || 'agent_worker_editor'
  );

  useEffect(() => {
    if (initialCharacterId) {
      setActiveCharacterId(initialCharacterId);
    }
  }, [initialCharacterId]);

  const isGroup = !!groupConversation;
  const [awayAgentId,setAwayAgentId]=useState<string|null>(null);
  useEffect(()=>{
    const controller=new AbortController();
    const update=()=>fetch('/api/autonomy/presence',{signal:controller.signal}).then(r=>r.ok?r.json():null).then(p=>{if(p&&!controller.signal.aborted)setAwayAgentId(p.running||null);}).catch(()=>{});
    void update();const timer=setInterval(update,5000);return()=>{controller.abort();clearInterval(timer);};
  },[]);
  const { appearance } = useChatAppearance();
  const [groupMembers, setGroupMembers] = useState<Character[]>([]);
  const [mentionAll, setMentionAll] = useState(false);
  const characters = isGroup ? groupMembers : CHARACTERS;
  const activeCharacter = characters.find(c => c.id === activeCharacterId) || (isGroup ? CHARACTERS.find(c => c.id === activeCharacterId) : undefined);

  useEffect(() => {
    if (!isGroup) return;
    const controller = new AbortController();
    fetchMembers(controller.signal).then(members => {
      const fallback = CHARACTERS.find(c => c.kind === 'ai') || {role:'AI',frenchRole:'Agent',avatarSeed:'agent',signatureColor:'#666',bubbleBg:'#f5f5f5',bubbleBorder:'#ddd',textColor:'#222',greeting:'',available:false,kind:'ai' as const,executorId:null,pinyin:'',title:''};
      const live = members.filter(m => m.kind === 'ai').map(m => ({
        ...(CHARACTERS.find(c => c.id === m.agentId) || fallback),
        id: m.agentId, name: m.displayName, title: m.displayName,
        avatarUrl: m.avatarDataUrl, available: m.available, statusNote: m.status,
      }));
      setGroupMembers(live);
      setActiveCharacterId(id => live.some(m => m.id === id) ? id : live[0]?.id || id);
    }).catch(() => {});
    return () => controller.abort();
  }, [isGroup, groupConversation?.conversationId]);

  // 全局头像映射响应式状态
  const [avatarMap, setAvatarMap] = useState<Record<string, string>>(() => getAllMemberAvatars());
  useEffect(() => {
    const handleAvatarUpdate = () => {
      setAvatarMap(getAllMemberAvatars());
    };
    window.addEventListener('luma_avatar_updated', handleAvatarUpdate);
    return () => window.removeEventListener('luma_avatar_updated', handleAvatarUpdate);
  }, []);

  // 单人房间专属配置
  const [chatConfig, setChatConfig] = useState<SingleChatConfig>(() => 
    getSingleChatConfig(activeCharacterId)
  );
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMemoriesOpen, setIsMemoriesOpen] = useState(false);
  const [isXiaoduOpen, setIsXiaoduOpen] = useState(false);
  const closeXiaodu = useCallback(() => setIsXiaoduOpen(false), []);
  useEffect(() => { setIsXiaoduOpen(false); }, [activeCharacterId, isGroup]);

  useEffect(() => {
    if (activeCharacter) {
      setChatConfig(getSingleChatConfig(activeCharacter.id));
    }
  }, [activeCharacterId, activeCharacter]);

  // 权威会话映射状态（来自 /api/conversations）
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isResolvingConversation, setIsResolvingConversation] = useState<boolean>(true);
  const [conversationError, setConversationError] = useState<string | null>(null);

  // 消息流状态
  const [messages, setMessages] = useState<Message[]>([]);
  const lastMainMessage = messages.filter(message => isGroup || activeCharacterId !== 'agent_coordinator' || !isXiaoduMessage(message)).at(-1);
  const [isLoadingHistory, setIsLoadingHistory] = useState<boolean>(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // 输入草稿、附件与发送控制
  const [inputText, setInputText] = useState('');
  const [pendingAttachment, setPendingAttachment] = useState<PendingAttachment | null>(null);
  const [isCharacterMenuOpen, setIsCharacterMenuOpen] = useState(false);
  const [isAmbientPlaying, setIsAmbientPlaying] = useState(false);
  const [sendingJobId, setSendingJobId] = useState<string | null>(null);

  // 回形针菜单与表情包弹窗状态
  const [isAttachMenuOpen, setIsAttachMenuOpen] = useState(false);
  const [isStickerPickerOpen, setIsStickerPickerOpen] = useState(false);

  // 图片全屏放大预览弹窗
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);

  // 语音录制 (WeChat / TG 风格语音条与内置转文字)
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [transcribedVoiceText, setTranscribedVoiceText] = useState('');
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const [audioNotice, setAudioNotice] = useState<string | null>(null);
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [pendingVoice, setPendingVoice] = useState<{ blob: Blob; audioUrl: string; duration: number } | null>(null);
  const voiceOperationRef = useRef(0);
  const voiceAbortRef = useRef<AbortController | null>(null);
  const recordingStartedAtRef = useRef(0);
  const voiceGeneratingRef = useRef(new Set<string>());

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<any>(null);
  const recognitionRef = useRef<any>(null);
  const activeAudioElementRef = useRef<HTMLAudioElement | null>(null);

  // 微信式气泡长按菜单、引用与删除状态
  const [activeMenuMessage, setActiveMenuMessage] = useState<Message | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const longPressTriggeredRef = useRef(false);
  const [deleteConfirmMsg, setDeleteConfirmMsg] = useState<Message | null>(null);
  const [activeMenuPart, setActiveMenuPart] = useState<string | null>(null);
  const [deleteConfirmPart, setDeleteConfirmPart] = useState<string | null>(null);
  const [isDeletingMessage, setIsDeletingMessage] = useState(false);
  const [expandedVoiceIds, setExpandedVoiceIds] = useState<Set<string>>(() => new Set());
  const [quotedMessage, setQuotedMessage] = useState<Message | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<NodeJS.Timeout | null>(null);

  const showToast = (msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMessage(msg);
    toastTimerRef.current = setTimeout(() => setToastMessage(null), 2000);
  };

  // 权威会话多会话状态管理器
  const sessionManagerRef = useRef<SessionStateManager>(new SessionStateManager());
  const currentAgentIdRef = useRef<string>(activeCharacterId);
  const currentConvIdRef = useRef<string | null>(null);
  const isMountedRef = useRef<boolean>(true);

  const historyAbortCtrlRef = useRef<AbortController | null>(null);
  const activePollsRef = useRef<Map<string, AbortController>>(new Map());
  const sendInFlightRef = useRef(false);
  const followLatestRef = useRef(true);

  const messagesViewportRef = useRef<HTMLElement | null>(null);
  useLiquidGlass(messagesViewportRef, appearance.bubbleTheme === 'liquid');
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const ambientOscRef = useRef<OscillatorNode | null>(null);

  useEffect(() => {
    currentAgentIdRef.current = activeCharacterId;
  }, [activeCharacterId]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      historyAbortCtrlRef.current?.abort();
      activePollsRef.current.forEach((ctrl) => ctrl.abort());
      activePollsRef.current.clear();
      voiceOperationRef.current++;
      voiceAbortRef.current?.abort();
      if (ambientOscRef.current) {
        try {
          ambientOscRef.current.stop();
        } catch {}
      }
      if (activeAudioElementRef.current) {
        try {
          activeAudioElementRef.current.pause();
        } catch {}
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        try {
          mediaRecorderRef.current.onstop = null;
          mediaRecorderRef.current.stop();
          mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
        } catch {}
      }
      clearInterval(recordTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const handleVisualResize = () => {
      if (followLatestRef.current) {
        const viewport = messagesViewportRef.current;
        viewport?.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' });
      }
    };
    window.visualViewport.addEventListener('resize', handleVisualResize);
    return () => {
      window.visualViewport?.removeEventListener('resize', handleVisualResize);
    };
  }, []);

  /**
   * 加载指定真实会话的历史
   */
  const loadAuthoritativeHistory = useCallback(
    async (targetConvId: string, signal?: AbortSignal, silent = false) => {
      if (!silent) {
        setIsLoadingHistory(true);
        setHistoryError(null);
      }

      try {
        const remoteMessages: MessageDto[] = await fetchMessages(targetConvId, undefined, signal);
        const voiceKeys = remoteMessages.flatMap(m => [m.id, ...(m.role === 'user' && m.requestId ? [m.requestId] : [])]);
        const restored = await restoreVoices(voiceKeys).catch(() => []);
        restored.forEach(([key, data]) => setCachedVoice(key, data, false));

        if (!isMountedRef.current || currentConvIdRef.current !== targetConvId) {
          return;
        }

        const localUnsent = sessionManagerRef.current.getUnsentMessages(targetConvId);
        const session = sessionManagerRef.current.getOrCreateSession(targetConvId, currentAgentIdRef.current);

        const resolveSenderName = (agentId: string, isUser: boolean) => {
          if (isUser) return '使用者（我）';
          return characters.find((c) => c.id === agentId)?.name || '成员';
        };

        const result = reconcileMessages(
          remoteMessages,
          localUnsent,
          session.reconciledRequestIds,
          targetConvId,
          resolveSenderName
        );

        session.unsentMessages = result.remainingUnsent;
        if (isGroup) {
          for (const message of result.mergedMessages) {
            const remote = remoteMessages.find(m => m.id === message.id);
            if (remote) {
              message.status = remote.status || 'sent';
              message.errorReason = remote.error;
              // Replies share the round requestId; owner media and quotes stay on the owner bubble.
              if (!message.isUser) {
                message.image = undefined;
                message.fileAttachment = undefined;
                message.quote = undefined;
              }
            }
          }
        }
        setMessages(prev => JSON.stringify(prev) === JSON.stringify(result.mergedMessages) ? prev : result.mergedMessages);

        return result.mergedMessages;
      } catch (err: unknown) {
        if (!isMountedRef.current || currentConvIdRef.current !== targetConvId) return;
        if (signal?.aborted) return;
        const errMsg = err instanceof Error ? err.message : String(err);
        setHistoryError(errMsg || '未能连通桌面会话服务');
      } finally {
        if (!silent && isMountedRef.current && currentConvIdRef.current === targetConvId) {
          setIsLoadingHistory(false);
        }
      }
    },
    [characters, isGroup]
  );

  /**
   * 切换成员核心逻辑
   */
  useEffect(() => {
    // Changing who answers in a group does not replace the conversation or its scroll position.
    if (isGroup && currentConvIdRef.current === groupConversation?.conversationId) return;
    historyAbortCtrlRef.current?.abort();
    followLatestRef.current = true;
    setSendingJobId(null);

    setMessages([]);
    setConversationId(null);
    currentConvIdRef.current = null;
    setConversationError(null);
    setHistoryError(null);
    setPendingAttachment(null);
    setIsAttachMenuOpen(false);

    if (activeCharacter) {
      const initialDraft = sessionManagerRef.current.getDraft({
        conversationId: null,
        agentId: activeCharacter.id,
      });
      setInputText(initialDraft);
    }

    if (!activeCharacter) {
      setIsResolvingConversation(false);
      setConversationError(`未在正式成员配置中找到「${activeCharacterId}」，暂无直连通道。`);
      return;
    }

    setIsResolvingConversation(true);
    const abortCtrl = new AbortController();
    historyAbortCtrlRef.current = abortCtrl;

    async function resolveAndLoadConversation() {
      try {
        const conversations: ConversationDto[] = await fetchConversations(abortCtrl.signal);
        if (!isMountedRef.current || currentAgentIdRef.current !== activeCharacter!.id) {
          return;
        }

        const matched = conversations.find(
          (c) => isGroup ? c.kind === 'group' && c.conversationId === groupConversation!.conversationId : c.kind === 'direct' && c.agentId === activeCharacter!.id
        );

        if (!matched || !matched.conversationId) {
          setIsResolvingConversation(false);
          setConversationId(null);
          currentConvIdRef.current = null;
          setConversationError(
            isGroup ? '小屋客厅尚未同步，请保持桌面 Luma 打开后重试。' : `未在桌面端检索到与「${activeCharacter!.name}」的权威会话（conversationId 缺失）。请等待网关同步，或在桌面发起该会话。`
          );
          return;
        }

        const realConvId = matched.conversationId;
        setConversationId(realConvId);
        currentConvIdRef.current = realConvId;
        setIsResolvingConversation(false);

        const savedDraft = sessionManagerRef.current.getDraft({
          conversationId: realConvId,
          agentId: activeCharacter!.id,
        });
        setInputText(savedDraft);

        await loadAuthoritativeHistory(realConvId, abortCtrl.signal);
      } catch (err: unknown) {
        if (!isMountedRef.current || currentAgentIdRef.current !== activeCharacter!.id) return;
        if (abortCtrl.signal.aborted) return;
        setIsResolvingConversation(false);
        const errMsg = err instanceof Error ? err.message : String(err);
        setConversationError(`无法获取权威会话列表: ${errMsg}`);
      }
    }

    resolveAndLoadConversation();

    return () => {
      abortCtrl.abort();
    };
  }, [activeCharacterId, activeCharacter, loadAuthoritativeHistory, groupConversation]);

  useEffect(() => {
    if (!conversationId) return;
    const controller = new AbortController();
    let busy = false;
    const refresh = async () => {
      if (document.visibilityState !== 'visible' || busy) return;
      busy = true;
      try { await loadAuthoritativeHistory(conversationId, controller.signal, true); }
      finally { busy = false; }
    };
    const timer = setInterval(refresh, isGroup ? 2500 : 12000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('online', refresh); };
  }, [isGroup, conversationId, loadAuthoritativeHistory]);

  const handleInputChange = (text: string) => {
    setInputText(text);
    if (activeCharacter) {
      sessionManagerRef.current.saveDraft(
        { conversationId, agentId: activeCharacter.id },
        text
      );
    }
  };

  const scrollToBottom = () => {
    const viewport = messagesViewportRef.current;
    viewport?.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' });
  };

  useLayoutEffect(() => {
    if (!isGroup || followLatestRef.current) scrollToBottom();
  }, [lastMainMessage?.id, lastMainMessage?.content, lastMainMessage?.status, sendingJobId]);

  // 微风声景
  const toggleAmbientSound = () => {
    if (isAmbientPlaying) {
      if (ambientOscRef.current) {
        ambientOscRef.current.stop();
        ambientOscRef.current = null;
      }
      setIsAmbientPlaying(false);
    } else {
      try {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioCtx();
        audioContextRef.current = ctx;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(140, ctx.currentTime);
        gain.gain.setValueAtTime(0.015, ctx.currentTime);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        ambientOscRef.current = osc;
        setIsAmbientPlaying(true);
      } catch (e) {
        console.warn('Audio ambient init error:', e);
      }
    }
  };

  // 处理图片选择
  const handleImageFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          setPendingAttachment({
            type: 'image',
            name: file.name,
            size: file.size,
            dataUrl: event.target.result as string,
          });
        }
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
    setIsAttachMenuOpen(false);
  };

  // 处理通用文件选择
  const handleAnyFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          const isImg = file.type.startsWith('image/');
          setPendingAttachment({
            type: isImg ? 'image' : 'file',
            name: file.name,
            size: file.size,
            dataUrl: event.target.result as string,
          });
        }
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
    setIsAttachMenuOpen(false);
  };

  // A recording stays local until the owner finishes and sends its transcript.
  const cancelVoiceRecording = () => {
    voiceOperationRef.current++;
    voiceAbortRef.current?.abort();
    clearInterval(recordTimerRef.current);
    const recorder = mediaRecorderRef.current;
    if (recorder) {
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      recorder.stream.getTracks().forEach(track => track.stop());
    }
    mediaRecorderRef.current = null;
    setIsRecording(false);
    setIsStartingRecording(false);
    setIsTranscribing(false);
    setPendingVoice(null);
    setRecordingDuration(0);
    setTranscribedVoiceText('');
  };

  useEffect(() => {
    cancelVoiceRecording();
    activeAudioElementRef.current?.pause();
    window.speechSynthesis?.cancel();
    setPlayingAudioId(null);
  }, [conversationId, activeCharacterId]);

  const startVoiceRecording = async () => {
    if (isStartingRecording || isTranscribing || pendingVoice || !conversationId || sendInFlightRef.current) return;
    const operation = ++voiceOperationRef.current;
    setIsStartingRecording(true);
    setAudioNotice(null);
    let stream: MediaStream | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不支持录音，请使用 Safari 或 Chrome');
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (operation !== voiceOperationRef.current || !isMountedRef.current) { stream.getTracks().forEach(track => track.stop()); return; }
      const mimeType = recordingMime();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      audioChunksRef.current = [];
      recorder.ondataavailable = event => { if (event.data.size) audioChunksRef.current.push(event.data); };
      recorder.onerror = () => { cancelVoiceRecording(); setAudioNotice('录音中断，请重新录制'); };
      mediaRecorderRef.current = recorder;
      recordingStartedAtRef.current = Date.now();
      recorder.start();
      setIsRecording(true);
      setRecordingDuration(0);
      setTranscribedVoiceText('');
      recordTimerRef.current = setInterval(() => setRecordingDuration(Math.floor((Date.now() - recordingStartedAtRef.current) / 1000)), 1000);
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      if (operation === voiceOperationRef.current) setAudioNotice(error instanceof Error && error.name !== 'NotAllowedError' ? error.message : '请允许小屋使用麦克风，再试一次');
    } finally { if (operation === voiceOperationRef.current) setIsStartingRecording(false); }
  };

  const recognizeRecording = async (voice: { blob: Blob; audioUrl: string; duration: number }) => {
    const operation = ++voiceOperationRef.current;
    const controller = new AbortController();
    voiceAbortRef.current?.abort();
    voiceAbortRef.current = controller;
    const timer = setTimeout(() => controller.abort(), 125000);
    setIsTranscribing(true);
    setAudioNotice(null);
    try {
      const result = await transcribeVoice(voice.blob, controller.signal);
      if (operation !== voiceOperationRef.current || !isMountedRef.current) return;
      setTranscribedVoiceText(result.text);
      setPendingVoice({ ...voice, duration: result.duration || voice.duration });
    } catch (error) {
      if (operation === voiceOperationRef.current && isMountedRef.current) setAudioNotice(controller.signal.aborted ? '转文字超时，录音还在，可以重试' : '转文字失败：' + (error instanceof Error ? error.message : '请重试'));
    } finally {
      clearTimeout(timer);
      if (operation === voiceOperationRef.current && isMountedRef.current) setIsTranscribing(false);
    }
  };

  const finishAndSendVoiceNote = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'recording') return;
    const operation = voiceOperationRef.current;
    const duration = (Date.now() - recordingStartedAtRef.current) / 1000;
    clearInterval(recordTimerRef.current);
    setIsRecording(false);
    setIsTranscribing(true);
    recorder.onstop = async () => {
      recorder.stream.getTracks().forEach(track => track.stop());
      if (operation !== voiceOperationRef.current || !isMountedRef.current) return;
      const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || audioChunksRef.current[0]?.type || 'audio/webm' });
      try {
        if (!blob.size) throw new Error('录音为空，请重新录制');
        const audioUrl = await blobDataUrl(blob);
        if (operation !== voiceOperationRef.current || !isMountedRef.current) return;
        const voice = { blob, audioUrl, duration };
        setPendingVoice(voice);
        await recognizeRecording(voice);
      } catch (error) {
        if (operation === voiceOperationRef.current) { setIsTranscribing(false); setAudioNotice(error instanceof Error ? error.message : '无法读取录音'); }
      }
    };
    recorder.stop();
  };

  const sendPendingVoice = (textOnly = false) => {
    if (!pendingVoice || !transcribedVoiceText.trim() || !conversationId || !activeCharacter || sendInFlightRef.current) return;
    const voice = pendingVoice;
    const transcription = transcribedVoiceText.trim();
    const duration = Math.max(1, Math.round(voice.duration));
    cancelVoiceRecording();
    void executeSend(textOnly ? transcription : `[语音消息 ${duration}秒]: ${transcription}`, crypto.randomUUID(), undefined, null,
      textOnly ? undefined : { audioUrl: voice.audioUrl, audioDuration: duration, voiceTranscription: transcription });
  };

  const makeMessageVoice = async (message: Message) => {
    const cached = getCachedVoice(message.id);
    if (cached) {
      if (currentConvIdRef.current === message.conversationId) setMessages(previous => previous.map(item => item.id === message.id ? { ...item, ...cached } : item));
      return;
    }
    if (voiceGeneratingRef.current.has(message.id)) return;
    const config = getSingleChatConfig(message.isUser ? activeCharacterId : message.senderId);
    if (config.ttsEngine === 'native') {
      if (!window.speechSynthesis) throw new Error('当前设备不支持系统朗读');
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(speechText(message.content));
      utterance.lang = 'zh-CN';
      utterance.rate = config.ttsSpeed || 1;
      utterance.voice = window.speechSynthesis.getVoices().find(voice => voice.lang.startsWith('zh')) || null;
      window.speechSynthesis.speak(utterance);
      return;
    }
    if (config.ttsEngine === 'edge-tts') throw new Error('Edge TTS 尚未接入，请在房间设置选择 Fish Audio 或系统朗读');
    const targetConvId = message.conversationId;
    voiceGeneratingRef.current.add(message.id);
    try {
      const { audioUrl, duration } = await fetchTtsVoice(message.content, config.fishAudioVoiceId || undefined);
      const voiceData = { audioUrl, audioDuration: duration, voiceTranscription: replyRules.replyText(message.content) };
      setCachedVoice(message.id, voiceData);
      await persistVoice(message.id, voiceData).catch(() => {});
      if (isMountedRef.current && currentConvIdRef.current === targetConvId) setMessages(previous => previous.map(item => item.id === message.id ? { ...item, ...voiceData } : item));
    } finally { voiceGeneratingRef.current.delete(message.id); }
  };

  // Reopening a room or receiving an office message uses the same marked reply,
  // not a second generated chat. Failure leaves readable text and manual retry.
  const voiceAttemptedRef = useRef(new Set<string>());
  useEffect(() => {
    for (const message of messages.slice(-20)) {
      if (message.isUser || message.status !== 'sent' || message.audioUrl || replyRules.replyMedium(message.content) !== 'voice') continue;
      const config = getSingleChatConfig(message.senderId);
      if (config.replyMedium === 'text' || config.ttsEngine === 'native' || voiceAttemptedRef.current.has(message.id)) continue;
      voiceAttemptedRef.current.add(message.id);
      void makeMessageVoice(message).catch(error => {
        if (isMountedRef.current && currentConvIdRef.current === message.conversationId) setAudioNotice('文字已收到，语音生成失败，可长按重试：' + error.message);
      });
    }
  }, [messages]);

  // 播放语音条
  const handlePlayVoice = (msgId: string, audioUrl?: string) => {
    if (longPressTriggeredRef.current) { longPressTriggeredRef.current = false; return; }
    if (!audioUrl) return;

    if (playingAudioId === msgId) {
      activeAudioElementRef.current?.pause();
      setPlayingAudioId(null);
      return;
    }

    if (activeAudioElementRef.current) {
      activeAudioElementRef.current.pause();
    }

    const audio = new Audio(audioUrl);
    const message = messages.find(item => item.id === msgId);
    const config = getSingleChatConfig(message?.isUser ? activeCharacterId : message?.senderId || activeCharacterId);
    audio.playbackRate = config.ttsSpeed || 1;
    activeAudioElementRef.current = audio;
    setPlayingAudioId(msgId);

    audio.onended = () => {
      setPlayingAudioId(null);
    };
    audio.onerror = () => {
      setPlayingAudioId(null);
    };

    audio.play().catch((e) => {
      console.warn('Audio play error:', e);
      setPlayingAudioId(null);
    });
  };

  // 表情包发送 (即时作为图片信笺发送)
  const handleSendSticker = (stickerUrl: string, stickerName: string = '表情') => {
    if (!conversationId || !activeCharacter) return;
    const requestId = crypto.randomUUID();
    const textWire = `[表情: ${stickerName}]`;

    executeSend(textWire, requestId, undefined, {
      type: 'image',
      name: stickerName,
      size: 0,
      dataUrl: stickerUrl,
    });
  };

  // 中止轮询等待
  const handleAbortWait = () => {
    if (conversationId) {
      activePollsRef.current.get(conversationId)?.abort();
      activePollsRef.current.delete(conversationId);
    }
    setSendingJobId(null);

    if (conversationId) {
      const abortReason = '已中止等待 (停止等待不等于后端取消，可稍后重试)';
      const unsent = sessionManagerRef.current.getUnsentMessages(conversationId);
      unsent.forEach((m) => {
        if (m.status === 'pending') {
          sessionManagerRef.current.updateUnsentMessage(conversationId, m.id, {
            status: 'failed',
            errorReason: abortReason,
          });
        }
      });
      setMessages((prev) =>
        prev.map((m) =>
          m.status === 'pending'
            ? { ...m, status: 'failed', errorReason: abortReason }
            : m
        )
      );
    }
  };

  // 规范化压缩本地图片以适配多模态模型与极速传输 (<100KB)
  const compressImageForUpload = async (dataUrl: string, maxDim = 960, quality = 0.72): Promise<{ dataBase64: string; mimeType: string; size: number }> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
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
        if (ctx) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
        }
        const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
        const cIdx = compressedDataUrl.indexOf(',');
        const b64 = compressedDataUrl.slice(cIdx + 1);
        resolve({
          dataBase64: b64,
          mimeType: 'image/jpeg',
          size: Math.floor((b64.length * 3) / 4),
        });
      };
      img.onerror = () => {
        const commaIdx = dataUrl.indexOf(',');
        const rawBase64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
        resolve({
          dataBase64: rawBase64,
          mimeType: 'image/jpeg',
          size: Math.floor((rawBase64.length * 3) / 4),
        });
      };
      img.src = dataUrl;
    });
  };

  /**
   * 核心发送逻辑
   */
  const executeSend = async (
    textToSend: string,
    requestId: string,
    existingMsgId?: string,
    attachment?: PendingAttachment | null,
    voiceMeta?: { audioUrl: string; audioDuration: number; voiceTranscription: string }
  ) => {
    if (!conversationId || !activeCharacter || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    followLatestRef.current = true;
    setSendingJobId('pending');

    const targetConvId = conversationId;
    const targetAgentId = existingMsgId
      ? sessionManagerRef.current.getUnsentMessages(targetConvId).find(m => m.id === existingMsgId)?.targetAgentId || activeCharacter.id
      : isGroup && (mentionAll || /^@(?:全部|所有人)(?=\s|$)/u.test(textToSend)) ? '@all' : activeCharacter.id;
    const clientMsgId = existingMsgId || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const timeStr = formatMessageTime();

    if (attachment?.type === 'image' && attachment.dataUrl) {
      setCachedMedia(clientMsgId, attachment.dataUrl);
      setCachedMedia(requestId, attachment.dataUrl);
    }

    const currentQuote = quotedMessage ? {
      id: quotedMessage.id,
      senderName: quotedMessage.senderName,
      content: quotedMessage.content || (quotedMessage.image ? '[照片]' : '[附件]'),
      image: quotedMessage.image,
    } : undefined;

    if (!existingMsgId) {
      const pendingMsg: Message = {
        id: clientMsgId,
        conversationId: targetConvId,
        senderId: 'user',
        senderName: '使用者（我）',
        content: textToSend,
        timestamp: timeStr,
        createdAt: new Date().toISOString(),
        isUser: true,
        image: attachment?.type === 'image' ? attachment.dataUrl : undefined,
        imageName: attachment?.type === 'image' ? attachment.name : undefined,
        quote: currentQuote,
        fileAttachment: attachment?.type === 'file' ? {
          name: attachment.name,
          size: attachment.size,
          dataUrl: attachment.dataUrl
        } : undefined,
        audioUrl: voiceMeta?.audioUrl,
        audioDuration: voiceMeta?.audioDuration,
        voiceTranscription: voiceMeta?.voiceTranscription,
        status: 'pending',
        requestId,
        targetAgentId,
      };
      sessionManagerRef.current.addUnsentMessage(targetConvId, targetAgentId, pendingMsg);
      setMessages((prev) => [...prev, pendingMsg]);
      setQuotedMessage(null);
    } else {
      sessionManagerRef.current.updateUnsentMessage(targetConvId, existingMsgId, {
        status: 'pending',
        errorReason: undefined,
      });
      setMessages((prev) =>
        prev.map((m) =>
          m.id === existingMsgId
            ? { ...m, status: 'pending', errorReason: undefined }
            : m
        )
      );
    }

    const abortCtrl = new AbortController();
    activePollsRef.current.set(targetConvId, abortCtrl);

    const timeoutTimer = setTimeout(() => {
      abortCtrl.abort();
    }, isGroup ? 600000 : 65000);

    try {
      // 构造适合远端 /api/chat 的安全文本载荷与附件
      let wireText = textToSend;
      let attachmentsToSend: SendChatAttachment[] | undefined = undefined;

      if (attachment) {
        if (attachment.type === 'image') {
          const isHttpUrl = attachment.dataUrl.startsWith('http://') || attachment.dataUrl.startsWith('https://');
          if (isHttpUrl) {
            wireText = isHttpUrl 
              ? `${textToSend ? textToSend + '\n\n' : ''}![${attachment.name}](${attachment.dataUrl})`
              : `${textToSend ? textToSend + '\n\n' : ''}[图片: ${attachment.name}]`;
          } else {
            wireText = textToSend || '你看一下这张图片';
            const compressed = await compressImageForUpload(attachment.dataUrl);
            attachmentsToSend = [{
              name: attachment.name || 'photo.jpg',
              mimeType: compressed.mimeType,
              size: compressed.size,
              dataBase64: compressed.dataBase64,
            }];
          }
        } else {
          wireText = `${textToSend ? textToSend + '\n\n' : ''}[发送文件: ${attachment.name} (${formatFileSize(attachment.size)})]`;
        }
      }

      if (voiceMeta) {
        setCachedVoice(clientMsgId, voiceMeta);
        setCachedVoice(requestId, voiceMeta);
        await persistVoice(requestId, voiceMeta).catch(() => {});
      }
      const chatJob = await postChatJob(
        {
          requestId,
          conversationId: targetConvId,
          targetAgentId,
          text: wireText,
          attachments: attachmentsToSend,
        },
        abortCtrl.signal
      );

      sessionManagerRef.current.updateUnsentMessage(targetConvId, clientMsgId, {
        jobId: chatJob.jobId,
        userMessageId: chatJob.userMessageId,
      });

      if(chatJob.state==='queued') {
        clearTimeout(timeoutTimer);activePollsRef.current.delete(targetConvId);
        sessionManagerRef.current.markJobCompleted(targetConvId,requestId,undefined,chatJob.userMessageId);
        sessionManagerRef.current.saveDraft({conversationId:targetConvId,agentId:targetAgentId},'');
        if(isMountedRef.current&&currentConvIdRef.current===targetConvId)await loadAuthoritativeHistory(targetConvId,undefined,true);
        return;
      }

      if (isMountedRef.current && currentConvIdRef.current === targetConvId) {
        setSendingJobId(chatJob.jobId);
      }

      const completedJob = await pollChatJob(chatJob.jobId, isGroup ? 400 : 40, 1500, abortCtrl.signal, async () => {
        if (isMountedRef.current && currentConvIdRef.current === targetConvId) await loadAuthoritativeHistory(targetConvId, abortCtrl.signal, true);
      });
      clearTimeout(timeoutTimer);
      activePollsRef.current.delete(targetConvId);

      sessionManagerRef.current.markJobCompleted(
        targetConvId,
        requestId,
        completedJob.reply,
        completedJob.userMessageId || chatJob.userMessageId
      );
      sessionManagerRef.current.saveDraft({ conversationId: targetConvId, agentId: targetAgentId }, '');

      if (isMountedRef.current && currentConvIdRef.current === targetConvId) {
        const roundMessages = await loadAuthoritativeHistory(targetConvId, undefined, isGroup);

        // Generate only this completed round, never the whole chat history.
        for (const reply of roundMessages || []) {
          if (reply.isUser || reply.requestId !== requestId || !reply.content || reply.status !== 'sent') continue;
          const config = getSingleChatConfig(reply.senderId);
          if (config.replyMedium === 'voice' && config.ttsEngine !== 'native') {
            void makeMessageVoice(reply).catch(error => { if (isMountedRef.current && currentConvIdRef.current === targetConvId) setAudioNotice('回复已收到，语音生成失败：' + error.message); });
          }
        }
      }
    } catch (err: unknown) {
      clearTimeout(timeoutTimer);
      activePollsRef.current.delete(targetConvId);

      let errorReason = '执行通道异常';

      if (err instanceof LumaApiError) {
        if (err.code === 'authentication_required') {
          errorReason = '需要登录认证 (401/403)';
        } else if (err.code === 'quota_exhausted') {
          errorReason = 'CLI 额度不足 (429)';
        } else if (err.code === 'house_offline') {
          errorReason = '电脑离线或网关未就绪 (503)';
        } else if (err.code === 'aborted') {
          errorReason = '已中止等待 (停止等待不等于后端取消，可恢复或重试)';
        } else {
          errorReason = `${err.message} (${err.code})`;
        }
      } else if (err instanceof Error) {
        if (err.name === 'AbortError' || err.message.includes('aborted')) {
          errorReason = '已暂停等待 (停止等待不等于后端取消，可恢复或重试)';
        } else {
          errorReason = err.message;
        }
      }

      sessionManagerRef.current.updateUnsentMessage(targetConvId, clientMsgId, {
        status: 'failed',
        errorReason,
      });

      if (isMountedRef.current && currentConvIdRef.current === targetConvId) {
        setSendingJobId(null);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === clientMsgId
              ? { ...m, status: 'failed', errorReason }
              : m
          )
        );
      }
    } finally {
      sendInFlightRef.current = false;
      if (isMountedRef.current && currentConvIdRef.current === targetConvId) setSendingJobId(null);
    }
  };

  const handleSendMessage = () => {
    if (sendInFlightRef.current) return;
    if (!inputText.trim() && !pendingAttachment) return;

    if (!conversationId) {
      alert('未接通有效真实会话，无法发送消息。');
      return;
    }

    if (activeCharacter?.kind === 'human') {
      alert('使用者是创作者本人，请在上方切换到协调者、编辑助手、执行助手、审核助手或 Researcher 进行对话。');
      return;
    }

    const textToSend = inputText.trim();
    const currentAttachment = pendingAttachment;
    const requestId = crypto.randomUUID();

    setInputText('');
    setPendingAttachment(null);
    setIsAttachMenuOpen(false);
    if (activeCharacter) {
      sessionManagerRef.current.saveDraft(
        { conversationId, agentId: activeCharacter.id },
        ''
      );
    }

    executeSend(textToSend, requestId, undefined, currentAttachment);
  };

  const handleRetryMessage = (msg: Message) => {
    if (!conversationId || msg.conversationId !== conversationId) return;
    const requestId = msg.requestId || crypto.randomUUID();
    const { attachment, voiceMeta } = restoreRetryMedia(msg);
    executeSend(msg.content, requestId, msg.id, attachment, voiceMeta);
  };

  const getBaseBubbleStyle = (msg: Message) => {
    if (msg.isUser) {
      return {
        backgroundColor: 'rgba(235, 225, 212, 0.85)',
        border: '1px solid rgba(198, 147, 144, 0.65)',
        color: 'var(--ink)'
      };
    }

    const sender = characters.find((c) => c.id === msg.senderId) || activeCharacter;
    return {
      backgroundColor: sender?.bubbleBg || 'rgba(220, 220, 220, 0.55)',
      border: `1px solid ${sender?.bubbleBorder || 'rgba(180, 180, 180, 0.6)'}`,
      color: sender?.textColor || 'var(--ink)'
    };
  };

  const removeSelectedMessage = async (mode: 'hide' | 'purge') => {
    if (!deleteConfirmMsg || isDeletingMessage) return;
    const target = deleteConfirmMsg;
    const part = mode === 'hide' ? deleteConfirmPart : null;
    setIsDeletingMessage(true);
    try {
      await deleteChatMessage(target.conversationId, target.id, mode, part || undefined);
      setMessages(previous => part ? previous.map(m => m.id !== target.id ? m : { ...m, hiddenReplyParts: [...new Set([...(m.hiddenReplyParts || []), part])] }) : previous.filter(m => m.id !== target.id));
      sessionManagerRef.current.setUnsentMessages(target.conversationId, sessionManagerRef.current.getUnsentMessages(target.conversationId).filter(m => m.id !== target.id));
      setDeleteConfirmMsg(null);
      void loadAuthoritativeHistory(target.conversationId, undefined, true);
      showToast(mode === 'purge' ? '原消息及关联记忆已清除' : '已保存隐藏设置');
    } catch (error) { showToast(error instanceof Error ? error.message : '删除未保存，请重试'); }
    finally { setIsDeletingMessage(false); }
  };

  if (!activeCharacter) {
    return (
      <div className="relative w-full h-full flex flex-col items-center justify-center p-6 bg-stone-100 text-stone-800">
        <AlertCircle className="w-10 h-10 text-amber-600 mb-3" />
        <h2 className="text-base font-serif font-bold mb-1">未开放的会话通道</h2>
        <p className="text-xs font-serif text-stone-600 text-center mb-4 max-w-xs">
          当前通道未接入权威桌面直连线路，不使用虚拟 ID 伪造。请返回细语沙龙选择小屋正式成员。
        </p>
        <button
          onClick={onBackToList || onBackToHome}
          className="px-4 py-2 rounded-xl bg-stone-200 text-stone-800 font-serif text-xs hover:bg-stone-300 transition-colors"
        >
          返回细语沙龙
        </button>
      </div>
    );
  }

  const effectiveBgUrl = isGroup ? customChatBgUrl : chatConfig.customChatBg || customChatBgUrl;
  const userAvatarUrl = avatarMap['agent_owner'] || avatarMap['user'] || null;
  const companionAvatarUrl = avatarMap[activeCharacter.id] || null;
  const hasXiaoduChannel = !isGroup && activeCharacter.id === 'agent_coordinator';
  const mainMessages = hasXiaoduChannel ? messages.filter(message => !isXiaoduMessage(message)) : messages;
  const xiaoduMessages = hasXiaoduChannel ? messages.filter(isXiaoduMessage) : [];
  const replyModes = replyRules.replyModes(messages);
  const renderMessage = (msg: Message, readOnly = false) => {
    if(!msg.isUser&&msg.senderId===awayAgentId&&msg.status==='pending'&&!msg.content)return null;
          const isPending = msg.status === 'pending';
          const isFailed = msg.status === 'failed';
          const isUser = msg.isUser;
          if (!isUser && isPending && !msg.content && !msg.audioUrl && !msg.image && !msg.fileAttachment) return null;

          const senderChar = characters.find((c) => c.id === msg.senderId) || activeCharacter;
          const msgSenderAvatar = isUser 
            ? userAvatarUrl 
            : (avatarMap[senderChar.id] || null);

          const isAudioPlaying = playingAudioId === msg.id;
          const parts = replyRules.splitReply(msg.content, {
            work: replyModes.get(msg.id),
            preserve: isUser || isFailed || !!(msg.audioUrl || msg.image || msg.fileAttachment || msg.quote),
            legacy: msg.hiddenReplyParts || false,
          });
          const visibleParts = parts.map((part, index) => ({ part, index })).filter(({ part }) => !msg.hiddenReplyParts?.includes(part.trim()));
          if (!visibleParts.length) return null;

          return (
            <div
              key={msg.id}
              data-message-id={msg.id}
              className={`flex items-start gap-2.5 w-full ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
            >
              {/* 聊天头像展示 */}
              <div className="relative shrink-0 mt-0.5 select-none">
                {msgSenderAvatar ? (
                  <img
                    src={msgSenderAvatar}
                    alt={isUser ? '使用者' : senderChar.name}
                    className="letter-cameo"
                  />
                ) : (
                  <div
                    className="letter-cameo flex items-center justify-center font-serif text-xs font-bold text-stone-900"
                    style={{ backgroundColor: isUser ? 'var(--dusty-rose)' : senderChar.signatureColor }}
                  >
                    {isUser ? 'U' : senderChar.name.slice(0, 1)}
                  </div>
                )}
              </div>

              {/* 消息本体与气泡：对方气泡最大宽度约 78%，我的气泡靠右 */}
              <div className={`flex flex-col ${isUser ? 'items-end max-w-[78%] ml-auto' : 'items-start max-w-[78%]'} space-y-1 min-w-0`}>
                {/* 发送者名称与时间 */}
                <div className={`flex items-center gap-1.5 px-1.5 text-[11px] letter-byline ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
                  <span>{msg.senderName}</span>
                  <span>·</span>
                  <span>{msg.timestamp}</span>
                  {isPending && (
                    <span className="text-[10px] text-amber-600 flex items-center gap-0.5">
                      <Loader2 className="w-2.5 h-2.5 animate-spin" /> 发送中
                    </span>
                  )}
                  {isFailed && (
                    <span className="text-[10px] text-rose-600 flex items-center gap-0.5">
                      <AlertTriangle className="w-2.5 h-2.5" /> 未发出
                    </span>
                  )}
                </div>

                {/* One original reply, up to five visual bubbles; actions keep the original message. */}
                {visibleParts.map(({ part, index: partIndex }) => (
                <div
                  key={partIndex}
                  data-reply-part={partIndex + 1}
                  data-bubble-style={msg.audioUrl ? undefined : appearance.bubbleTheme}
                  style={msg.audioUrl ? undefined : bubbleAppearance(appearance, getBaseBubbleStyle(msg), msg.isUser)}
                  className={`min-w-0 max-w-full [overflow-wrap:anywhere] text-sm font-sans tracking-wide leading-relaxed ${msg.audioUrl ? 'flex flex-col gap-2' : `px-3.5 py-2.5 select-text ${isUser ? 'paint-blot-user' : 'paint-blot'}`} relative group cursor-pointer ${isFailed ? 'opacity-85 ring-1 ring-rose-400' : ''}`}
                  onTouchStart={(e) => {
                    if (readOnly) return;
                    longPressTriggeredRef.current = false;
                    const touch = e.touches[0];
                    const x = touch.clientX;
                    const y = touch.clientY;
                    longPressTimerRef.current = setTimeout(() => {
                      try { navigator.vibrate?.(25); } catch {}
                      longPressTriggeredRef.current = true;
                      setActiveMenuMessage(msg);
                      setActiveMenuPart(parts.length > 1 && !msg.audioUrl ? part.trim() : null);
                      setMenuPosition({ x, y });
                    }, 420);
                  }}
                  onTouchMove={() => {
                    if (longPressTimerRef.current) {
                      clearTimeout(longPressTimerRef.current);
                      longPressTimerRef.current = null;
                    }
                  }}
                  onTouchEnd={() => {
                    if (longPressTimerRef.current) {
                      clearTimeout(longPressTimerRef.current);
                      longPressTimerRef.current = null;
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (readOnly) return;
                    setActiveMenuMessage(msg);
                    setActiveMenuPart(parts.length > 1 && !msg.audioUrl ? part.trim() : null);
                    setMenuPosition({ x: e.clientX, y: e.clientY });
                  }}
                >
                  {/* 微信风格引用块展示 */}
                  {msg.quote && (
                    <div className="mb-2 p-2 rounded-xl bg-black/5 border-l-2 border-amber-700/60 text-xs text-stone-700 font-serif flex flex-col gap-0.5">
                      <div className="font-semibold text-amber-900 text-[11px] flex items-center gap-1">
                        <Quote className="w-3 h-3 text-amber-700" />
                        <span>@{msg.quote.senderName}</span>
                      </div>
                      <p className="text-[11px] text-stone-600 line-clamp-2">
                        {msg.quote.content}
                      </p>
                    </div>
                  )}
                  {/* 微信/TG 风格语音条 */}
                  {msg.audioUrl && (
                    <>
                      <button
                        type="button"
                        aria-label={`${isAudioPlaying ? '暂停' : '播放'}${msg.senderName}的语音`}
                        data-voice-bar
                        data-bubble-style={appearance.bubbleTheme}
                        onClick={() => handlePlayVoice(msg.id, msg.audioUrl)}
                        style={{ ...bubbleAppearance(appearance, getBaseBubbleStyle(msg), msg.isUser), width: `${Math.min(264, 144 + Math.max(0, msg.audioDuration || 0) * 5)}px` }}
                        className={`flex items-center gap-3 max-w-full px-3.5 py-3 ${isUser ? 'paint-blot-user' : 'paint-blot'} cursor-pointer select-none transition-transform active:scale-[.98] text-current`}
                      >
                        <span className="w-7 h-7 rounded-full bg-black/5 flex items-center justify-center shrink-0">
                          {isAudioPlaying ? (
                            <Pause className="w-3.5 h-3.5" />
                          ) : (
                            <Play className="w-3.5 h-3.5 ml-0.5" />
                          )}
                        </span>

                        {/* 声波振幅动画指示 */}
                        <div className="flex items-center gap-0.5 flex-1 h-4">
                          {[40, 70, 95, 60, 80, 45, 90, 65, 85, 50].map((h, i) => (
                            <span
                              key={i}
                              style={{ height: `${h}%` }}
                              className={`w-0.5 rounded-full ${
                                isAudioPlaying ? 'bg-current animate-pulse' : 'bg-current opacity-60'
                              }`}
                            />
                          ))}
                        </div>

                        <span className="text-xs font-mono font-semibold shrink-0">
                          {msg.audioDuration ? `${Math.round(msg.audioDuration)}"` : '语音'}
                        </span>
                      </button>

                      {/* 内部语音转文字字幕 */}
                      {expandedVoiceIds.has(msg.id) && (msg.voiceTranscription || msg.content) && (
                        <p data-voice-transcript style={bubbleAppearance(appearance, getBaseBubbleStyle(msg), msg.isUser)} data-bubble-style={appearance.bubbleTheme} className={`px-3.5 py-2.5 text-sm select-text ${isUser ? 'paint-blot-user' : 'paint-blot'}`}>
                          {msg.voiceTranscription || replyRules.replyText(msg.content).replace(/^\[语音消息.*?\]:\s*/, '')}
                        </p>
                      )}
                    </>
                  )}

                  {/* 图片展示（含表情包，点击可全屏查看） */}
                  {msg.image && (
                    <div 
                      onClick={() => setPreviewImageUrl(msg.image || null)}
                      className="relative group cursor-pointer mb-2 overflow-hidden rounded-xl border border-black/10 shadow-xs"
                    >
                      <img
                        src={msg.image}
                        alt="画作图片"
                        className="max-h-60 max-w-full rounded-xl object-cover hover:scale-[1.01] transition-transform duration-200"
                      />
                      <div className="absolute bottom-1.5 right-1.5 px-2 py-0.5 rounded-lg bg-black/50 text-white text-[10px] font-serif flex items-center gap-1 backdrop-blur-xs">
                        <Maximize2 className="w-3 h-3" />
                        <span>点击放大</span>
                      </div>
                    </div>
                  )}

                  {/* 文件附件展示卡片 */}
                  {msg.fileAttachment && (
                    <div className="flex items-center gap-2.5 p-2.5 mb-2 rounded-xl bg-black/5 border border-black/10 text-xs">
                      <div className="p-2 rounded-lg bg-amber-100 text-amber-800 shrink-0">
                        <FileText className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-[12px] truncate">{msg.fileAttachment.name}</p>
                        <p className="text-[10px] text-stone-600 font-mono">{formatFileSize(msg.fileAttachment.size)}</p>
                      </div>
                      {msg.fileAttachment.dataUrl && (
                        <a
                          href={msg.fileAttachment.dataUrl}
                          download={msg.fileAttachment.name}
                          className="p-1.5 rounded-lg bg-stone-200/80 hover:bg-stone-300 text-stone-800 transition-colors shrink-0"
                          title="下载附件"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                  )}

                  {/* 文本内容（非纯语音转文字时展示） */}
                  {!msg.audioUrl && part && <MarkdownView content={parts.length > 1 ? part.trim() : part} />}

                  {/* 收藏星标 */}
                  {msg.isFavorite && partIndex === parts.length - 1 && (
                    <div className="mt-1 flex items-center justify-end">
                      <Bookmark className="w-3 h-3 text-amber-700/80 fill-amber-600/70" />
                    </div>
                  )}

                  {/* 失败重试项 */}
                  {!readOnly && (isFailed || (isPending && !sendingJobId)) && (
                    <div className="mt-2.5 pt-2 border-t border-rose-300/60 flex items-center justify-between text-xs text-rose-800">
                      <span className="truncate pr-2 font-mono text-[11px]">
                        {msg.errorReason || (isPending ? '等待已暂停，可恢复重试' : '远端网关未接通')}
                      </span>
                      <button
                        onClick={() => handleRetryMessage(msg)}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg bg-rose-200/80 hover:bg-rose-300 text-rose-900 text-[11px] font-serif transition-colors cursor-pointer shrink-0"
                        title="沿用原 requestId 重新发送"
                      >
                        <RotateCcw className="w-3 h-3" />
                        <span>重试</span>
                      </button>
                    </div>
                  )}
                </div>
                ))}
              </div>
            </div>
          );

  };

  return (
    <div className="relative w-full h-full min-w-0 min-h-0 flex flex-col overflow-hidden overscroll-none select-none bg-[#f5eee3]">
      {/* 背景：花园油画虚化 + 细密亚麻布肌理 */}
      <ChatWallpaper url={effectiveBgUrl} appearance={appearance} />
      {appearance.bubbleTheme === 'letter' && <div className="letter-room-rules" aria-hidden="true" />}

      {/* 顶部：信纸抬头 */}
      <header
        className="relative z-20 shrink-0 flex items-center justify-between px-3 letter-room-header"
        style={{
          paddingTop: 'max(env(safe-area-inset-top, 0px), 8px)',
          paddingBottom: '0.45rem'
        }}
      >
        {/* 返回按钮 */}
        <button
          onClick={onBackToList || onBackToHome}
          className="flex items-center gap-1 px-2 py-1 rounded-xl hover:bg-white/40 active:bg-white/60 transition-colors text-stone-800 cursor-pointer"
          title="返回沙龙"
        >
          <span className="text-base leading-none">‹</span>
          <span className="font-calligraphy text-base text-stone-800 tracking-wider">Salon</span>
        </button>

        {/* 中间：当前对话对象名字 + 下拉展开选择 */}
        <div className="relative">
          <button
            disabled={!!sendingJobId}
            onClick={() => setIsCharacterMenuOpen(!isCharacterMenuOpen)}
            aria-expanded={isCharacterMenuOpen}
            aria-label={isGroup ? '选择本轮由谁回答' : '切换对话伙伴'}
            className="letter-room-title cursor-pointer"
          >
            <span className="flex items-center gap-1.5">
              {companionAvatarUrl ? (
                <img
                  src={companionAvatarUrl}
                  alt=""
                  className="w-4 h-4 rounded-full object-cover"
                />
              ) : (
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: activeCharacter.signatureColor }}
                />
              )}
              <span className="font-serif font-semibold text-sm tracking-wide">{isGroup ? groupConversation.title : activeCharacter.title}</span>
              <ChevronDown className="w-3 h-3 text-stone-500" aria-hidden="true" />
            </span>
            {sendingJobId && <span className="letter-room-status" role="status">{isGroup && mentionAll ? '大家在写信…' : `${activeCharacter.name}在写信…`}</span>}
          </button>

          {/* 下拉角色切换菜单 */}
          {isCharacterMenuOpen && (
            <div className="absolute left-1/2 -translate-x-1/2 top-full mt-2 w-56 p-1.5 rounded-2xl bg-stone-50/95 backdrop-blur-lg border border-stone-300/80 shadow-xl oil-shadow z-50 animate-[fadeIn_0.2s_ease-out]">
              <div className="px-3 py-1.5 text-[11px] font-serif text-stone-500 border-b border-stone-200 flex justify-between items-center">
                <span>{isGroup ? '本轮由谁回答' : '切换对话伙伴'}</span>
                <span className="text-[9px] font-mono text-stone-400">稳定 AgentId</span>
              </div>
              <div className="mt-1 space-y-1">
                {isGroup && <button type="button" onClick={() => { setMentionAll(true); setIsCharacterMenuOpen(false); }} className="w-full px-3 py-2 text-left text-xs text-stone-800 rounded-xl hover:bg-stone-100" aria-pressed={mentionAll}>@全部 · 每位成员依次回应</button>}
                {characters.filter((c) => c.kind !== 'human').map((char) => (
                  <button
                    key={char.id}
                    onClick={() => {
                      setActiveCharacterId(char.id);
                      setMentionAll(false);
                      setIsCharacterMenuOpen(false);
                    }}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-serif transition-colors cursor-pointer ${
                      char.id === activeCharacterId
                        ? 'bg-stone-200/80 text-stone-900 font-semibold'
                        : 'hover:bg-stone-100 text-stone-700'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {avatarMap[char.id] ? (
                        <img
                          src={avatarMap[char.id]}
                          alt={char.name}
                          className="w-4 h-4 rounded-full object-cover"
                        />
                      ) : (
                        <span
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: char.signatureColor }}
                        />
                      )}
                      <span>{char.name}</span>
                    </div>
                    <span className="text-[10px] text-stone-500 font-mono truncate max-w-[80px]">
                      {char.role.split('/')[0]}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 右侧：单人聊天设置 + 花园声景 */}
        <div className="flex items-center gap-1.5">
          {hasXiaoduChannel && <button type="button" aria-label="打开小度陪伴" title="小度陪伴" aria-haspopup="dialog" aria-expanded={isXiaoduOpen} aria-controls="xiaodu-channel" onClick={() => setIsXiaoduOpen(value => !value)} className="p-1.5 rounded-full text-stone-700 hover:bg-white/40 transition-colors cursor-pointer"><Radio className="w-4 h-4" /></button>}
          <button
            onClick={toggleAmbientSound}
            className={`p-1.5 rounded-full transition-colors cursor-pointer ${
              isAmbientPlaying ? 'text-amber-700 bg-amber-100/80' : 'text-stone-600 hover:bg-white/40'
            }`}
            title={isAmbientPlaying ? '静音花园声景' : '聆听花园微风'}
          >
            {isAmbientPlaying ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </button>

          {/* 记忆档案库按钮 */}
          <button
            onClick={() => setIsMemoriesOpen(true)}
            className="p-1.5 rounded-full text-stone-700 hover:bg-white/40 transition-colors cursor-pointer"
            title={isGroup ? '查看小屋客厅公开记忆' : `查看与 ${activeCharacter.name} 的专属记忆档案`}
          >
            <BookOpen className="w-4 h-4" />
          </button>

          {/* 单人房间设置按钮 */}
          {!isGroup && <button
            onClick={() => setIsSettingsOpen(true)}
            className="p-1.5 rounded-full text-stone-700 hover:bg-white/40 transition-colors cursor-pointer"
            title={`进入与 ${activeCharacter.name} 的专属单人设置 (TTS / 生图 / 背景)`}
          >
            <Sliders className="w-4 h-4" />
          </button>}
        </div>
      </header>
      {awayAgentId&&(!isGroup?awayAgentId===activeCharacterId:true)&&<p role="status" className="shrink-0 px-4 py-1 text-[10px] text-stone-500 text-center">{characters.find(c=>c.id===awayAgentId)?.name||'伙伴'}出门了，暂时不在家 · 可以留言，回来后再聊</p>}

      {isGroup && <div className="relative z-20 shrink-0 px-3 py-2 text-xs bg-white/45 border-b border-white/60 flex flex-wrap items-center gap-2">
        <span className="text-stone-600">本轮回答：</span>
        <button type="button" disabled={!!sendingJobId} aria-pressed={mentionAll} onClick={() => setMentionAll(true)} className={`px-2 py-1 rounded-full ${mentionAll ? 'bg-amber-200' : 'bg-white/60'}`}>@全部</button>
        {groupMembers.map(member => <button key={member.id} type="button" disabled={!!sendingJobId || !member.available} aria-pressed={!mentionAll && activeCharacterId === member.id} onClick={() => { setMentionAll(false); setActiveCharacterId(member.id); }} className={`px-2 py-1 rounded-full disabled:opacity-40 ${!mentionAll && activeCharacterId === member.id ? 'bg-amber-200' : 'bg-white/60'}`}>@{member.name}{member.available ? '' : '（未连接）'}</button>)}
      </div>}

      {/* 状态横幅 */}
      {isResolvingConversation && (
        <div className="letter-note flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-700 shrink-0" />
          <span className="truncate">正在解析与 {activeCharacter.name} 的真实会话...</span>
        </div>
      )}

      {conversationError && !isResolvingConversation && (
        <div className="letter-note flex items-start gap-1.5" data-tone="warn" role="alert">
          <WifiOff className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold text-[11px]">{conversationError}</p>
          </div>
        </div>
      )}

      {audioNotice && (
        <div className="letter-note text-center" role="status">
          {audioNotice}
        </div>
      )}

      {/* 消息滚动流 */}
      <main ref={messagesViewportRef} aria-label={isGroup ? '客厅消息' : '私聊消息'} onScroll={e => { const node=e.currentTarget; followLatestRef.current=node.scrollHeight-node.scrollTop-node.clientHeight<100; }} className="relative z-10 flex-1 min-w-0 min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain touch-pan-y px-3 py-3 space-y-3.5 no-scrollbar">
        {/* 对话开始手写诗意提示 */}
        {!isGroup && <div className="text-center my-1.5">
          <div className="letter-greeting">
            「{activeCharacter.greeting}」
          </div>
        </div>}

        {isLoadingHistory && (
          <div className="flex items-center justify-center py-3 text-xs letter-byline gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>正在同步桌面权威会话记录...</span>
          </div>
        )}

        {mainMessages.map((message, index) => {
          const day = messageDay(message);
          const previous = index > 0 ? messageDay(mainMessages[index - 1]) : null;
          const showDate = day && (!previous || dayKey(previous) !== dayKey(day));
          return <React.Fragment key={message.id}>
            {showDate && <div className="letter-date" role="separator" aria-label={dayLabel(day)}>{dayLabel(day)}</div>}
            {renderMessage(message)}
          </React.Fragment>;
        })}

        {sendingJobId && (
          <div className="letter-note !mx-0 flex items-center justify-between italic max-w-sm">
            <div className="flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-700" />
              <span>{isGroup && mentionAll ? '大家正在依次回应…' : `${activeCharacter.name} 正在执笔构思…`}</span>
            </div>
            <button
              onClick={handleAbortWait}
              className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-stone-300/80 hover:bg-stone-300 text-stone-800 text-[10px] font-sans not-italic cursor-pointer"
              title="停止在前端继续轮询等待"
            >
              <Square className="w-2.5 h-2.5 fill-current" />
              <span>停止等候</span>
            </button>
          </div>
        )}

      </main>

      {/* 底部输入栏：雾面玻璃效果 + 向左完整扩展 + 紧凑留白（往下拉） */}
      <footer
        className="relative z-30 shrink-0 px-3 letter-room-footer"
        style={{
          paddingTop: '0.4rem',
          paddingBottom: 'max(var(--chat-safe-bottom, env(safe-area-inset-bottom, 0px)), 8px)'
        }}
      >
        {/* 当前选中待发送的附件预览 */}
        {pendingAttachment && (
          <div className="mb-2 p-2 rounded-2xl bg-amber-50/95 border border-amber-300/70 flex items-center justify-between text-xs text-amber-950 font-serif shadow-xs">
            <div className="flex items-center gap-2.5 min-w-0">
              {pendingAttachment.type === 'image' ? (
                <img
                  src={pendingAttachment.dataUrl}
                  alt="附件预览"
                  className="w-11 h-11 object-cover rounded-xl border border-amber-300 shrink-0"
                />
              ) : (
                <div className="w-11 h-11 rounded-xl bg-amber-200/80 border border-amber-300 flex items-center justify-center text-amber-900 shrink-0">
                  <FileText className="w-5 h-5" />
                </div>
              )}
              <div className="min-w-0">
                <p className="font-semibold text-xs truncate max-w-[200px]">
                  {pendingAttachment.name}
                </p>
                <p className="text-[10px] text-amber-800/80 font-mono">
                  {formatFileSize(pendingAttachment.size)} · 待随信发送
                </p>
              </div>
            </div>
            <button
              onClick={() => setPendingAttachment(null)}
              className="p-1 rounded-full hover:bg-amber-200/60 text-amber-900 cursor-pointer ml-2"
              title="移除附件"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* 正在录制语音条的实时提示栏 */}
        {(isRecording || isTranscribing || pendingVoice) && (
          <div className="mb-2 p-2 rounded-2xl bg-rose-50/95 border border-rose-300/80 flex items-center justify-between text-xs text-rose-950 font-serif shadow-xs animate-[pulse_2s_infinite]">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-rose-600 animate-ping" />
              <span className="font-bold">{isRecording ? `正在录音… (${recordingDuration}s)` : isTranscribing ? '正在转文字…' : '录音已就绪，文字可以修改'}</span>
              {transcribedVoiceText && (
                <span className="text-[10px] text-rose-800 truncate max-w-[140px] italic">
                  {transcribedVoiceText}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={cancelVoiceRecording}
                className="px-2.5 py-1 rounded-xl bg-stone-200 hover:bg-stone-300 text-stone-700 text-xs cursor-pointer"
              >
                取消
              </button>
              <button
                disabled={isTranscribing || !!sendingJobId || (!isRecording && !transcribedVoiceText.trim())}
                onClick={isRecording ? finishAndSendVoiceNote : () => sendPendingVoice()}
                className="px-3 py-1 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs cursor-pointer shadow-xs"
              >
                {isRecording ? '完成录音' : isTranscribing ? '识别中…' : '发送语音'}
              </button>
            </div>
          </div>
        )}

        {pendingVoice && !isRecording && (
          <div className="px-3 py-2 bg-white/70 border-t border-stone-200 space-y-2">
            <audio controls src={pendingVoice.audioUrl} className="w-full h-8" />
            <textarea aria-label="语音转文字结果" value={transcribedVoiceText} onChange={event => setTranscribedVoiceText(event.target.value)} disabled={isTranscribing} placeholder="识别完成后，可修改文字再发送" className="w-full rounded-xl px-3 py-2 bg-white/70 text-sm border border-stone-200" rows={2} />
            <div className="flex gap-3 text-xs text-amber-900">
              <button type="button" disabled={isTranscribing || !!sendingJobId || !transcribedVoiceText.trim()} onClick={() => sendPendingVoice(true)}>只发文字</button>
              <button type="button" disabled={isTranscribing} onClick={() => { void recognizeRecording(pendingVoice); }}>重新识别</button>
            </div>
          </div>
        )}

        {/* 回形针展开弹窗（发送图片 / 发送文件合集） */}
        {isAttachMenuOpen && (
          <div className="absolute left-3 bottom-14 w-40 p-1.5 rounded-2xl bg-white/95 backdrop-blur-xl border border-stone-300 shadow-xl oil-shadow z-40 space-y-1 animate-[fadeIn_0.15s_ease-out]">
            <button
              onClick={() => imageInputRef.current?.click()}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-serif text-stone-800 hover:bg-amber-50 hover:text-amber-950 transition-colors cursor-pointer"
            >
              <ImageIcon className="w-4 h-4 text-amber-700" />
              <span>发送画作 / 图片</span>
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-serif text-stone-800 hover:bg-amber-50 hover:text-amber-950 transition-colors cursor-pointer"
            >
              <FileText className="w-4 h-4 text-amber-700" />
              <span>发送文档 / 文件</span>
            </button>
          </div>
        )}

        {/* 隐藏的文件输入组件 */}
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          onChange={handleImageFileChange}
          className="hidden"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="*/*"
          onChange={handleAnyFileChange}
          className="hidden"
        />

        {/* 正在引用的消息条 (微信同款) */}
        {quotedMessage && (
          <div className="mb-2 px-3 py-1.5 rounded-xl bg-amber-50/90 backdrop-blur-md border border-amber-200/80 flex items-center justify-between text-xs text-stone-700 animate-[fadeIn_0.15s_ease-out]">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <Quote className="w-3.5 h-3.5 text-amber-700 shrink-0" />
              <span className="font-semibold text-amber-950 shrink-0">回复 @{quotedMessage.senderName}:</span>
              <span className="truncate text-stone-600 font-serif">
                {quotedMessage.content || (quotedMessage.image ? '[画作/照片]' : '[附件]')}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setQuotedMessage(null)}
              className="p-1 rounded-full hover:bg-black/5 text-stone-400 hover:text-stone-700 transition-colors shrink-0"
              title="取消引用"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* 底部功能组合行：[回形针(图片+文件)] [表情包] [输入框] [语音输入] [发送] */}
        <div className="flex items-center gap-1.5">
          {/* 回形针合集按钮 */}
          <button
            onClick={() => setIsAttachMenuOpen(!isAttachMenuOpen)}
            data-on={isAttachMenuOpen || undefined}
            className="letter-room-tool"
            title="发送图片与文件附件"
            aria-label="发送图片与文件附件"
          >
            <Paperclip className="w-4 h-4" />
          </button>

          {/* 表情包按钮 */}
          <button
            onClick={() => setIsStickerPickerOpen(true)}
            className="letter-room-tool"
            title="表情包工坊 (添加、删除、图床导入)"
            aria-label="表情包"
          >
            <Smile className="w-4 h-4" />
          </button>

          {/* 画布输入框 */}
          <div className="flex-1 min-w-0 relative">
            <input
              type="text"
              value={inputText}
              onChange={(e) => handleInputChange(e.target.value)}
              onFocus={() => {
                setTimeout(() => {
                  if (followLatestRef.current) scrollToBottom();
                }, 200);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              disabled={!conversationId || sendingJobId !== null || activeCharacter.kind === 'human'}
              placeholder={
                activeCharacter.kind === 'human'
                  ? '使用者是本人，请切换其他成员对话...'
                  : !conversationId
                  ? '等待桌面权威会话接通后输入...'
                  : isGroup ? `在客厅发消息 · ${mentionAll ? '@全部' : '@' + activeCharacter.name}` : `与 ${activeCharacter.name} 畅聊...`
              }
              aria-label="写信"
              className="letter-room-input"
            />
          </div>

          {/* 语音输入按钮（放置在发送按钮左边） */}
          <button
            disabled={isStartingRecording || isTranscribing || !!pendingVoice || !!sendingJobId || !conversationId || activeCharacter.kind === 'human'}
            onClick={isRecording ? cancelVoiceRecording : startVoiceRecording}
            data-on={isRecording || undefined}
            className={`letter-room-tool ${isRecording ? 'animate-pulse' : ''}`}
            title={isRecording ? '点击取消录音' : '点击录音，完成后可转文字或发语音'}
            aria-label={isRecording ? '取消录音' : '录音'}
          >
            {isRecording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          </button>

          {/* 发送：火漆印 */}
          <button
            onClick={handleSendMessage}
            disabled={
              (!inputText.trim() && !pendingAttachment) ||
              !conversationId ||
              sendingJobId !== null ||
              activeCharacter.kind === 'human'
            }
            className="letter-room-seal"
            title="封缄寄出"
            aria-label="发送"
          >
            <span>发送</span>
          </button>
        </div>
      </footer>

      {/* 单人房间设置弹窗 (Portal 挂载在根节点，绝不被侧边栏遮挡) */}
      <ChatRoomSettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        character={activeCharacter}
        onConfigUpdated={(cfg) => setChatConfig(cfg)}
      />

      {/* 记忆档案库弹窗 */}
      {isXiaoduOpen && hasXiaoduChannel && <XiaoduChannelModal messages={xiaoduMessages} renderMessage={message => renderMessage(message, true)} onClose={closeXiaodu} error={historyError} wallpaperUrl={effectiveBgUrl} appearance={appearance} />}
      <ChatMemoriesModal
        isOpen={isMemoriesOpen}
        onClose={() => setIsMemoriesOpen(false)}
        character={activeCharacter}
        conversationId={conversationId}
        scopeType={isGroup ? 'living-room' : 'direct'}
      />

      {/* 表情包工坊弹窗 (Portal 挂载) */}
      <StickerPickerModal
        isOpen={isStickerPickerOpen}
        onClose={() => setIsStickerPickerOpen(false)}
        onSelectSticker={handleSendSticker}
      />

      {/* 图片全屏查看灯箱 */}
      {previewImageUrl && (
        <div 
          onClick={() => setPreviewImageUrl(null)}
          className="fixed inset-0 z-[9999] bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease-out]"
        >
          <button
            onClick={() => setPreviewImageUrl(null)}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/20 hover:bg-white/30 text-white transition-colors cursor-pointer"
            title="关闭预览"
          >
            <X className="w-5 h-5" />
          </button>
          <img
            src={previewImageUrl}
            alt="高清大图"
            className="max-w-full max-h-[90vh] object-contain rounded-xl shadow-2xl"
          />
        </div>
      )}
      {/* 微信式气泡长按/右键操作菜单 */}
      {activeMenuMessage && (
        <div 
          className="fixed inset-0 z-[9990] flex items-center justify-center p-4 bg-black/25 backdrop-blur-[2px] animate-[fadeIn_0.15s_ease-out]"
          onClick={() => setActiveMenuMessage(null)}
        >
          <div 
            className="p-1.5 rounded-2xl bg-stone-900/90 text-white backdrop-blur-xl border border-white/15 shadow-2xl flex flex-wrap justify-center items-center gap-1 max-w-full select-none animate-[scaleIn_0.15s_ease-out]"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                const textToCopy = activeMenuMessage.content || (activeMenuMessage.image ? '[画作/照片]' : '');
                if (textToCopy) {
                  navigator.clipboard?.writeText(textToCopy);
                  showToast('已复制到剪贴板');
                }
                setActiveMenuMessage(null);
              }}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl hover:bg-white/10 active:bg-white/15 text-xs font-serif text-stone-100 transition-colors cursor-pointer"
            >
              <Copy className="w-3.5 h-3.5 text-amber-400" />
              <span>复制</span>
            </button>

            <div className="w-[1px] h-4 bg-white/20" />

            <button
              type="button"
              onClick={() => {
                setQuotedMessage(activeMenuMessage);
                setActiveMenuMessage(null);
                showToast(`已引用 @${activeMenuMessage.senderName}`);
              }}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl hover:bg-white/10 active:bg-white/15 text-xs font-serif text-stone-100 transition-colors cursor-pointer"
            >
              <Quote className="w-3.5 h-3.5 text-amber-400" />
              <span>引用</span>
            </button>

            <div className="w-[1px] h-4 bg-white/20" />

            <button
              type="button"
              onClick={() => {
                const isFav = activeMenuMessage.isFavorite;
                setMessages(prev => prev.map(m => m.id === activeMenuMessage.id ? { ...m, isFavorite: !isFav } : m));
                showToast(isFav ? '已取消收藏' : '已存入灵感收藏');
                setActiveMenuMessage(null);
              }}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl hover:bg-white/10 active:bg-white/15 text-xs font-serif text-stone-100 transition-colors cursor-pointer"
            >
              <Bookmark className={`w-3.5 h-3.5 ${activeMenuMessage.isFavorite ? 'text-amber-400 fill-amber-400' : 'text-amber-400'}`} />
              <span>{activeMenuMessage.isFavorite ? '取消收藏' : '收藏'}</span>
            </button>

            {activeMenuMessage.audioUrl && (
              <button type="button" onClick={() => {
                const id = activeMenuMessage.id;
                setExpandedVoiceIds(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
                setActiveMenuMessage(null);
              }} className="flex items-center gap-1.5 px-3 py-2 rounded-xl hover:bg-white/10 active:bg-white/15 text-xs font-serif text-stone-100 cursor-pointer">
                <FileText className="w-3.5 h-3.5 text-amber-400" />
                <span>{expandedVoiceIds.has(activeMenuMessage.id) ? '收起文字' : '转文字'}</span>
              </button>
            )}

            {activeMenuMessage.content && !activeMenuMessage.audioUrl && (
              <>
                <div className="w-[1px] h-4 bg-white/20" />
                <button
                  type="button"
                  onClick={async () => {
                    const target = activeMenuMessage;
                    setActiveMenuMessage(null);
                    showToast('正在转换语音...');
                    try {
                      await makeMessageVoice(target);
                      showToast(getSingleChatConfig(target.isUser ? activeCharacterId : target.senderId).ttsEngine === 'native' ? '正在使用系统朗读' : '语音已生成，点击即可收听');
                    } catch (e: any) {
                      showToast('语音转换失败: ' + (e?.message || '网络异常'));
                    }
                  }}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl hover:bg-white/10 active:bg-white/15 text-xs font-serif text-amber-300 transition-colors cursor-pointer"
                >
                  <Volume2 className="w-3.5 h-3.5 text-amber-400" />
                  <span>转语音</span>
                </button>
              </>
            )}

            <div className="w-[1px] h-4 bg-white/20" />

            <button
              type="button"
              onClick={() => {
                const target = activeMenuMessage;
                setActiveMenuMessage(null);
                setDeleteConfirmMsg(target);
                setDeleteConfirmPart(activeMenuPart);
              }}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl hover:bg-rose-500/20 active:bg-rose-500/30 text-xs font-serif text-rose-300 transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5 text-rose-400" />
              <span>删除</span>
            </button>
          </div>
        </div>
      )}

      {/* 删除方式确认弹窗 (仅隐藏 vs 同时删除记忆) */}
      {deleteConfirmMsg && (
        <div 
          className="fixed inset-0 z-[9995] flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-[fadeIn_0.15s_ease-out]"
          onClick={() => { if (!isDeletingMessage) setDeleteConfirmMsg(null); }}
        >
          <div 
            className="w-full max-w-xs p-5 rounded-3xl bg-white/95 backdrop-blur-xl border border-stone-200/90 shadow-2xl oil-shadow space-y-4 text-center select-none"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-10 mx-auto rounded-full bg-rose-50 border border-rose-200 text-rose-600 flex items-center justify-center">
              <Trash2 className="w-5 h-5" />
            </div>

            <div className="space-y-1">
              <h3 className="font-serif text-sm font-bold text-stone-900">{deleteConfirmPart ? '删除此气泡' : '删除此条消息'}</h3>
              <p className="text-[11px] text-stone-500 font-serif leading-relaxed px-2">
                {deleteConfirmPart ? '可以只移除选中的气泡，保留前后文字和记忆；清除相关记忆会删除整条原消息。' : '可以仅隐藏聊天记录、保留记忆，或者删除原消息及其相关记忆。'}
              </p>
            </div>

            <div className="space-y-2 pt-1 font-serif text-xs">
              <button
                type="button"
                disabled={isDeletingMessage}
                onClick={() => void removeSelectedMessage('hide')}
                className="w-full py-2.5 rounded-2xl bg-stone-100 hover:bg-stone-200 text-stone-800 font-medium transition-colors cursor-pointer"
              >
                {isDeletingMessage ? '正在保存…' : deleteConfirmPart ? '仅移除此气泡' : '仅从聊天中移除'}
              </button>

              <button
                type="button"
                disabled={isDeletingMessage}
                onClick={() => void removeSelectedMessage('purge')}
                className="w-full py-2.5 rounded-2xl bg-rose-600 hover:bg-rose-700 text-white font-medium shadow-xs transition-colors cursor-pointer"
              >
                {deleteConfirmPart ? '删除整条原消息及相关记忆' : '同时删除相关记忆'}
              </button>

              <button
                type="button"
                disabled={isDeletingMessage}
                onClick={() => setDeleteConfirmMsg(null)}
                className="w-full py-2 rounded-xl text-stone-400 hover:text-stone-600 text-[11px] transition-colors cursor-pointer"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 全局轻量 Toast 提示条 */}
      {toastMessage && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[9999] px-4 py-2 rounded-2xl bg-stone-900/85 backdrop-blur-md border border-white/10 text-white text-xs font-serif shadow-xl flex items-center gap-1.5 animate-[fadeIn_0.15s_ease-out]">
          <Check className="w-3.5 h-3.5 text-amber-400" />
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  );
};
