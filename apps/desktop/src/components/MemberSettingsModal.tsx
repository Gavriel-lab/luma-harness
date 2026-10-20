import { useState, useEffect, useRef, useMemo } from 'react';
import { X, RefreshCw, Key, Shield, Sliders, Sparkles, Search, ChevronDown, Check, Type } from 'lucide-react';
import type { Store } from '../ui/useAppStore';
import type { ChatProfile, ModelCatalogItem, AppData, Agent } from '../types';
import { ReadingSettingsPanel } from './ReadingSettingsPanel';
import { Avatar } from './Avatar';
import { AvatarEditor } from './AvatarEditor';

export function MemberSettingsModal({
  store,
  onClose,
  initialAgentId,
  initialTab = 'members',
}: {
  store: Store;
  onClose: () => void;
  initialAgentId?: string;
  initialTab?: 'members' | 'reading';
}) {
  const [mainTab, setMainTab] = useState<'members' | 'reading'>(initialTab);
  const { data, updateAgentConfig, saveChatProfile } = store;
  const members = data.agents.filter(a => !a.removed);
  const removedMembers = data.agents.filter(a => a.kind === 'ai' && a.removed);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState(members.find(a => a.id === initialAgentId)?.id || members[0]?.id || '');
  const agent = data.agents.find((a) => a.id === selectedAgentId);

  // 异步操作代次追踪，防止切换成员后迟到的结果串写
  const generationRef = useRef(0);
  useEffect(() => () => { generationRef.current++; }, []);

  // Profile 表单状态
  const existingProfile = agent?.profileId ? data.chatProfiles?.find((p) => p.id === agent.profileId) : undefined;

  const [providerType,setProviderType]=useState<'openai-compatible'|'codex-app-server'>(existingProfile?.providerType==='codex-app-server'?'codex-app-server':'openai-compatible');
  const [mode, setMode] = useState<'demo' | 'real'>(agent?.mode === 'real' ? 'real' : 'demo');
  const [name, setName] = useState(existingProfile?.name || '默认接口配置');
  const [baseUrl, setBaseUrl] = useState(existingProfile?.baseUrl || 'https://openrouter.ai/api/v1');
  // 优先兼容 codexModel，再看 model
  const [model, setModel] = useState(
    existingProfile?.codexModel || existingProfile?.model || (providerType === 'codex-app-server' ? 'gpt-6.1-sol' : '')
  );
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [hasEncryptedKey, setHasEncryptedKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt || '');
  const [contextLimit, setContextLimit] = useState(existingProfile?.contextLimit || 10);
  const [maxTokens, setMaxTokens] = useState(existingProfile?.maxTokens || 2048);
  const [temperature, setTemperature] = useState(existingProfile?.temperature ?? 0.7);

  // Codex 专属状态
  const [codexModels, setCodexModels] = useState<string[]>([]);
  const [loadingCodexModels, setLoadingCodexModels] = useState(false);

  // 远程模型目录拉取状态
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<ModelCatalogItem[]>([]);
  const [modelSearch, setModelSearch] = useState('');
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  // 当选择 Coordinator 时异步加载本机 Codex 模型列表
  useEffect(() => {
    if (providerType === 'codex-app-server' && typeof window !== 'undefined' && window.xiaowuDesktop?.codex) {
      setLoadingCodexModels(true);
      window.xiaowuDesktop.codex.listModels().then((models) => {
        setLoadingCodexModels(false);
        if (Array.isArray(models) && models.length > 0) {
          const names = models.map((m: any) => m.id || m.displayName || String(m));
          setCodexModels(names);
          if (!model && names.includes('gpt-6.1-sol')) {
            setModel('gpt-6.1-sol');
          }
        }
      }).catch(() => {
        setLoadingCodexModels(false);
      });
    }
  }, [selectedAgentId]);

  // 当连接核心要素改变时，递增代次、立即取消旧 loading 并立即使过往的连通测试结果失效
  const handleBaseUrlChange = (val: string) => {
    generationRef.current++;
    setFetchingModels(false);
    setBaseUrl(val);
    setTestResult(null);
    setFetchedModels([]);
    setModelDropdownOpen(false);
    setModelsError(null);
  };
  const handleModelChange = (val: string) => {
    generationRef.current++;
    setModel(val);
    setTestResult(null);
  };
  const handleApiKeyChange = (val: string) => {
    generationRef.current++;
    setFetchingModels(false);
    setApiKeyInput(val);
    setTestResult(null);
  };

  // 根据搜索关键字过滤模型列表
  const filteredModels = useMemo(() => {
    if (!modelSearch.trim()) return fetchedModels;
    const q = modelSearch.toLowerCase();
    return fetchedModels.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        (m.description && m.description.toLowerCase().includes(q))
    );
  }, [fetchedModels, modelSearch]);

  // 监听 Escape 键关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // 连接测试状态
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    latencyMs?: number;
    error?: string;
    timestamp?: string;
  } | null>(
    existingProfile?.lastVerifiedAt
      ? {
          success: existingProfile.lastVerifiedStatus === 'success',
          error: existingProfile.lastVerifiedError || undefined,
          timestamp: existingProfile.lastVerifiedAt,
        }
      : null,
  );
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // 凭据引用 ID（与 agent 绑定或默认引用）
  const credentialRef = `cred_${selectedAgentId}`;

  // 检查当前 agent 是否已有加密存储的 key
  useEffect(() => {
    if (typeof window !== 'undefined' && window.xiaowuDesktop?.credentials) {
      window.xiaowuDesktop.credentials.has(credentialRef).then((has) => {
        setHasEncryptedKey(has);
      });
    }
  }, [credentialRef]);

  // 切换成员时同步状态
  const handleSelectAgent = (id: string) => {
    setConfirmRemove(false);
    generationRef.current++;
    setFetchingModels(false);
    setLoadingCodexModels(false);
    setSelectedAgentId(id);
    const ag = data.agents.find((a) => a.id === id);
    const prof = ag?.profileId ? data.chatProfiles?.find((p) => p.id === ag.profileId) : undefined;
    setProviderType(prof?.providerType==='codex-app-server'?'codex-app-server':'openai-compatible');
    setMode(ag?.mode === 'real' ? 'real' : 'demo');
    setName(prof?.name || (id === 'agent_coordinator' ? 'Coordinator (Codex CLI)' : `${ag?.name || '成员'} 专属配置`));
    setBaseUrl(prof?.baseUrl || 'https://openrouter.ai/api/v1');
    setModel(prof?.codexModel || prof?.model || (id === 'agent_coordinator' ? 'gpt-6.1-sol' : ''));
    setApiKeyInput('');
    setSystemPrompt(ag?.systemPrompt || '');
    setContextLimit(prof?.contextLimit || 10);
    setMaxTokens(prof?.maxTokens || 2048);
    setTemperature(prof?.temperature ?? 0.7);
    setFetchedModels([]);
    setModelSearch('');
    setModelDropdownOpen(false);
    setModelsError(null);
    setIsTruncated(false);
    setTestResult(
      prof?.lastVerifiedAt
        ? {
            success: prof.lastVerifiedStatus === 'success',
            error: prof.lastVerifiedError || undefined,
            timestamp: prof.lastVerifiedAt,
          }
        : null,
    );
    setStatusMsg(null);
  };

  // 应用 OpenRouter 模板
  const applyOpenRouterTemplate = () => {
    generationRef.current++;
    setFetchingModels(false);
    setBaseUrl('https://openrouter.ai/api/v1');
    if (selectedAgentId === 'agent_worker') {
      setName('执行助手 (自选模型)');
      setModel('');
      setStatusMsg('已填入 OpenRouter 模板与 自选模型 模型（注：免费/实验性端点不承诺永久可用）');
    } else {
      setName('OpenRouter 模板');
      setStatusMsg('已填入 OpenRouter 兼容端点模板，请填写具体模型');
    }
    setTestResult(null);
    setFetchedModels([]);
    setModelDropdownOpen(false);
  };

  // 拉取远程可用模型列表
  const handleFetchModels = async () => {
    const isCodex = providerType === 'codex-app-server';
    const currentGen = ++generationRef.current;
    setFetchingModels(true);
    setModelsError(null);
    setStatusMsg(isCodex ? '正在拉取本机 Codex CLI 可用模型...' : '正在拉取服务接口可用模型列表...');

    try {
      if (typeof window === 'undefined' || !window.xiaowuDesktop) {
        setFetchingModels(false);
        setModelsError('当前非桌面端环境，无法拉取模型列表');
        return;
      }

      const profileId = existingProfile?.id || (isCodex ? 'prof_coordinator' : `profile_${selectedAgentId}_${Date.now()}`);

      // 若用户输入了新 Key，先加密存入 safeStorage 以便主进程权威读取
      if (!isCodex && apiKeyInput.trim()) {
        const res = await window.xiaowuDesktop.credentials?.set(credentialRef, apiKeyInput.trim());
        if (!res?.ok) {
          setFetchingModels(false);
          setModelsError(`保存凭据草稿失败: ${res?.reason || '未知错误'}`);
          return;
        }
        setHasEncryptedKey(true);
        setApiKeyInput('');
      }

      // 同步当前 Base URL 草稿到 store，并确保主进程权威落盘，消除 200ms 防抖竞态
      const conv = store.data.conversations?.find((c) => c.agentId === selectedAgentId);
      const boundThreadId = conv?.codexThreadId || existingProfile?.codexThreadId;
      const boundSources = Array.isArray(conv?.instructionSources)
        ? conv.instructionSources
        : existingProfile?.instructionSources;

      const draftProfile: ChatProfile = {
        id: profileId,
        name: name.trim() || (isCodex ? 'Coordinator (Codex CLI)' : '草稿配置'),
        providerType: isCodex ? 'codex-app-server' : 'openai-compatible',
        baseUrl: isCodex ? '' : baseUrl.trim(),
        model: model.trim() || (isCodex ? 'gpt-6.1-sol' : ''),
        credentialRef: isCodex ? '' : credentialRef,
        codexModel: isCodex ? (model.trim() || 'gpt-6.1-sol') : undefined,
        codexCwd: isCodex ? existingProfile?.codexCwd || '' : undefined,
        codexThreadId: isCodex ? boundThreadId : undefined,
        instructionSources: isCodex ? boundSources : undefined,
        developerInstructions: systemPrompt.trim(),
        maxTokens: Number(maxTokens) || 2048,
        temperature: Number(temperature) || 0.7,
        contextLimit: Number(contextLimit) || 10,
      };
      saveChatProfile(draftProfile);

      const currentAgent = store.data.agents.find((a) => a.id === selectedAgentId);
      updateAgentConfig(selectedAgentId, {
        profileId,
        mode: currentAgent?.mode || 'demo',
      });

      // 构造当前明确草稿快照，确保 flushSave 立即落盘最新修改
      const latestProfiles = store.data.chatProfiles ? [...store.data.chatProfiles] : [];
      const profIdx = latestProfiles.findIndex((p) => p.id === draftProfile.id);
      if (profIdx < 0) latestProfiles.push(draftProfile);
      else latestProfiles[profIdx] = draftProfile;

      const latestAgents = store.data.agents ? [...store.data.agents] : [];
      const agIdx = latestAgents.findIndex((a) => a.id === selectedAgentId);
      if (agIdx >= 0 && latestAgents[agIdx]) {
        latestAgents[agIdx] = {
          ...latestAgents[agIdx],
          profileId,
          mode: latestAgents[agIdx].mode || 'demo',
        } as Agent;
      }
      const draftSnapshot: AppData = {
        ...store.data,
        chatProfiles: latestProfiles,
        agents: latestAgents,
      };

      // 权威事务落盘：等保存成功后再使用该连接拉目录
      if (typeof store.flushSave === 'function') {
        const saved = await store.flushSave(draftSnapshot);
        if (!saved) {
          setFetchingModels(false);
          setModelsError('连接草稿权威落盘失败，未发起目录请求；请重试');
          setStatusMsg('连接草稿保存落盘失败，请重试');
          return;
        }
      }

      // 调用主进程 models.fetch
      const res = await window.xiaowuDesktop.models?.fetch({
        agentId: selectedAgentId,
        profileId,
      });

      if (generationRef.current !== currentGen) return;
      setFetchingModels(false);

      if (res?.ok && Array.isArray(res.models) && res.models.length > 0) {
        setFetchedModels(res.models);
        setIsTruncated(!!res.truncated);
        setModelDropdownOpen(true);
        const truncNote = res.truncated ? '（部分目录，未全部取完）' : '';
        setStatusMsg(`成功获取 ${res.models.length} 个可用模型${truncNote}`);
      } else {
        const errMsg =
          res?.error ||
          (res?.truncated
            ? '未获取到可用对话模型（仅抓取部分目录，未匹配到对话模型）'
            : '未能获取到模型列表，请确认 Base URL 与凭据，或手动输入 Model ID');
        setModelsError(errMsg);
        setStatusMsg(errMsg);
      }
    } catch (err: any) {
      if (generationRef.current !== currentGen) return;
      setFetchingModels(false);
      const errMsg = err?.message || '拉取模型发生网络或系统异常';
      setModelsError(errMsg);
      setStatusMsg(errMsg);
    }
  };

  // 保存设置（支持保存无模型连接草稿）
  const saveSettings = async () => {
    if (!agent) return;
    const saveGeneration = generationRef.current;

    const isCodex = providerType === 'codex-app-server';

    if (mode === 'real' && !isCodex) {
      if (!baseUrl.trim()) {
        setStatusMsg('请填写接口 Base URL');
        return;
      }
    }

    let hasKeyNow = hasEncryptedKey;

    // 如果用户输入了新 Key，调用主进程 safeStorage 加密保存
    if (!isCodex && apiKeyInput.trim()) {
      if (typeof window !== 'undefined' && window.xiaowuDesktop?.credentials) {
        const res = await window.xiaowuDesktop.credentials.set(credentialRef, apiKeyInput.trim());
        if (!res.ok) {
          setStatusMsg(`保存密钥失败: ${res.reason}`);
          return;
        }
        hasKeyNow = true;
        setHasEncryptedKey(true);
        setApiKeyInput(''); // 立即在前端内存中清空明文 Key
      } else {
        setStatusMsg('当前非桌面端运行环境，无法调用系统安全凭据存储');
        return;
      }
    }

    if (generationRef.current !== saveGeneration) return;
    const conv = store.data.conversations?.find((c) => c.agentId === selectedAgentId);
    const boundThreadId = conv?.codexThreadId || existingProfile?.codexThreadId;
    const boundSources = Array.isArray(conv?.instructionSources)
      ? conv.instructionSources
      : existingProfile?.instructionSources;

    const profileId = existingProfile?.id || (isCodex ? 'prof_coordinator' : `profile_${selectedAgentId}_${Date.now()}`);
    const newProfile: ChatProfile = {
      id: profileId,
      name: name.trim() || (isCodex ? 'Coordinator (Codex CLI)' : '未命名配置'),
      providerType: isCodex ? 'codex-app-server' : 'openai-compatible',
      baseUrl: isCodex ? '' : baseUrl.trim(),
      model: model.trim() || (isCodex ? 'gpt-6.1-sol' : ''),
      credentialRef: isCodex ? '' : credentialRef,
      codexModel: isCodex ? (model.trim() || 'gpt-6.1-sol') : undefined,
      codexCwd: isCodex ? existingProfile?.codexCwd || '' : undefined,
      codexThreadId: isCodex ? boundThreadId : undefined,
      instructionSources: isCodex ? boundSources : undefined,
      developerInstructions: systemPrompt.trim(),
      maxTokens: Number(maxTokens) || 2048,
      temperature: Number(temperature) || 0.7,
      contextLimit: Number(contextLimit) || 10,
      lastVerifiedAt: testResult?.timestamp || existingProfile?.lastVerifiedAt || null,
      lastVerifiedStatus: testResult ? (testResult.success ? 'success' : 'failed') : (existingProfile?.lastVerifiedStatus || null),
      lastVerifiedError: testResult?.error || existingProfile?.lastVerifiedError || null,
    };

    saveChatProfile(newProfile);

    const hasModel = !!newProfile.model.trim();
    const isReady = isCodex ? hasModel : (hasKeyNow && hasModel);

    let statusNote = '演示模式：未连接真实服务';
    if (mode === 'real') {
      if (isCodex) {
        statusNote = `Codex CLI · ${newProfile.model || '未选模型'}`;
      } else if (!hasModel) {
        statusNote = '真实接口 · 未选定模型（草稿）';
      } else if (!hasKeyNow) {
        statusNote = '真实接口（未保存密钥）';
      } else {
        statusNote = `真实接口 · ${newProfile.model}`;
      }
    }

    updateAgentConfig(selectedAgentId, {
      mode,
      profileId: mode === 'real' ? profileId : null,
      systemPrompt: systemPrompt.trim(),
      statusNote,
      connected: mode === 'real' && isReady && testResult?.success === true,
    });

    const latestProfiles = store.data.chatProfiles ? [...store.data.chatProfiles] : [];
    const profIdx = latestProfiles.findIndex((p) => p.id === newProfile.id);
    if (profIdx < 0) latestProfiles.push(newProfile);
    else latestProfiles[profIdx] = newProfile;

    const latestAgents = store.data.agents ? [...store.data.agents] : [];
    const agIdx = latestAgents.findIndex((a) => a.id === selectedAgentId);
    if (agIdx >= 0 && latestAgents[agIdx]) {
      latestAgents[agIdx] = {
        ...latestAgents[agIdx],
        mode,
        profileId: mode === 'real' ? profileId : null,
        systemPrompt: systemPrompt.trim(),
        statusNote,
        connected: mode === 'real' && isReady && testResult?.success === true,
      } as Agent;
    }
    const saveSnapshot: AppData = {
      ...store.data,
      chatProfiles: latestProfiles,
      agents: latestAgents,
    };

    if (typeof store.flushSave === 'function') {
      const saved = await store.flushSave(saveSnapshot);
      if (!saved) {
        setStatusMsg('保存到磁盘失败，请重试');
        return; // 严禁关闭弹窗！保留输入和具体可重试错误
      }
    }

    if (generationRef.current !== saveGeneration) return;
    setStatusMsg(hasModel ? '配置已保存！' : '连接草稿已保存（尚未选定模型，发送前请选定模型）');
    onClose();
  };
  const handleSave = async () => {
    setSavingConfig(true);
    try { await saveSettings(); } finally { setSavingConfig(false); }
  };

  // 清除密钥
  const handleDeleteKey = async () => {
    if (typeof window !== 'undefined' && window.xiaowuDesktop?.credentials) {
      const res = await window.xiaowuDesktop.credentials.delete(credentialRef);
      if (!res.ok) {
        setStatusMsg(`清除密钥失败: ${res.reason}`);
        return;
      }
      setHasEncryptedKey(false);
      setApiKeyInput('');
      setTestResult(null);
      setStatusMsg('已安全抹除本成员的加密密钥');
    }
  };

  // 手动测试连接
  const handleTestConnection = async () => {
    if (mode === 'demo') {
      setStatusMsg('当前处于演示模式，无需测试真实接口');
      return;
    }

    const isCodex = providerType === 'codex-app-server';

    if (!isCodex) {
      if (!baseUrl.trim() || !model.trim()) {
        setStatusMsg('请先填写 Base URL 和 Model ID');
        return;
      }
    }

    const currentGen = ++generationRef.current;

    if (!isCodex) {
      // 先临时把输入的 key 保存好以供测试
      if (apiKeyInput.trim()) {
        if (typeof window !== 'undefined' && window.xiaowuDesktop?.credentials) {
          const res = await window.xiaowuDesktop.credentials.set(credentialRef, apiKeyInput.trim());
          if (!res.ok) {
            setStatusMsg(`保存密钥失败: ${res.reason}`);
            return;
          }
          setHasEncryptedKey(true);
          setApiKeyInput('');
        }
      } else if (!hasEncryptedKey) {
        setStatusMsg('未检测到已保存密钥，请先输入 API 密钥');
        return;
      }
    }

    setTesting(true);
    setStatusMsg(isCodex ? '正在与本机 Codex app-server 进行 stdio 握手与模型检测...' : '正在向服务接口发送最小测试消息（max_tokens: 1，无自动重试）...');

    const tempProfile = {
      id: existingProfile?.id || (isCodex ? 'prof_coordinator' : `profile_${selectedAgentId}`),
      agentId: selectedAgentId,
      providerType: isCodex ? ('codex-app-server' as const) : ('openai-compatible' as const),
      baseUrl: isCodex ? '' : baseUrl.trim(),
      model: model.trim() || (isCodex ? 'gpt-6.1-sol' : ''),
      credentialRef: isCodex ? '' : credentialRef,
      codexModel: isCodex ? (model.trim() || 'gpt-6.1-sol') : undefined,
      codexCwd: isCodex ? existingProfile?.codexCwd || '' : undefined,
    };

    try {
      if (typeof window !== 'undefined' && window.xiaowuDesktop?.chat) {
        const res = await window.xiaowuDesktop.chat.testConnection(tempProfile);
        setTesting(false);
        if (generationRef.current !== currentGen) return; // 避免切成员或修改配置后迟到结果写乱
        setTestResult(res);
        if (res.success) {
          setStatusMsg(isCodex ? `Codex app-server 握手成功！耗时 ${res.latencyMs}ms` : `连接测试成功！耗时 ${res.latencyMs}ms`);
        } else {
          setStatusMsg(`连接测试失败: ${res.error}`);
        }
      } else {
        setTesting(false);
        setStatusMsg('当前非桌面环境，无法调用主进程连接测试');
      }
    } catch (err: any) {
      setTesting(false);
      setStatusMsg(`测试异常: ${err?.message || '未知错误'}`);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal modal--settings"
        style={{ maxWidth: 680, width: '92vw', maxHeight: '88vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="member-settings-title"
        aria-modal="true"
      >
        <div className="modal__head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sliders size={18} aria-hidden />
            <h2 id="member-settings-title" className="modal__title">
              小屋设置
            </h2>
          </div>
          <button className="btn btn--icon" onClick={onClose} aria-label="关闭">
            <X size={16} aria-hidden />
          </button>
        </div>

        {/* 顶层主标签页 */}
        <div style={{ display: 'flex', gap: 8, padding: '0 20px', borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))', background: 'var(--panel-2, rgba(0,0,0,0.15))' }}>
          <button
            type="button"
            className={`btn ${mainTab === 'members' ? 'btn--primary' : 'btn--ghost'}`}
            style={{ borderRadius: '6px 6px 0 0', borderBottom: 'none', minHeight: 34, padding: '4px 14px', fontSize: 13 }}
            onClick={() => setMainTab('members')}
            data-testid="tab-members-settings"
          >
            <Sliders size={14} style={{ marginRight: 6 }} />
            成员与接口
          </button>
          <button
            type="button"
            className={`btn ${mainTab === 'reading' ? 'btn--primary' : 'btn--ghost'}`}
            style={{ borderRadius: '6px 6px 0 0', borderBottom: 'none', minHeight: 34, padding: '4px 14px', fontSize: 13 }}
            onClick={() => setMainTab('reading')}
            data-testid="tab-reading-settings"
          >
            <Type size={14} style={{ marginRight: 6 }} />
            聊天阅读
          </button>
        </div>

        <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {mainTab === 'reading' ? (
            <ReadingSettingsPanel store={store} />
          ) : (
            <>
              {/* 成员切换 Tab */}
              <div>
                <label className="label" style={{ marginBottom: 6, display: 'block' }}>
                  选择配置的成员
                </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {members.map((ag) => (
                <button
                  key={ag.id}
                  className={`btn ${selectedAgentId === ag.id ? 'btn--primary' : 'btn--ghost'}`}
                  style={{ minHeight: 34, padding: '4px 12px' }}
                  onClick={() => handleSelectAgent(ag.id)}
                  data-testid={`member-setting-${ag.id}`}
                >
                  <Avatar agent={ag} className="avatar--xs" style={{ marginRight: 6 }} />
                  {ag.name}
                  {ag.kind === 'ai' && <span
                    className={`dot dot--${ag.mode === 'real' ? 'live' : 'demo'}`}
                    style={{ marginLeft: 6 }}
                    title={ag.mode === 'real' ? '真实接口' : '演示模式'}
                  />}
                </button>
              ))}
            </div>
          </div>

          {removedMembers.length > 0 && <details data-testid="removed-members">
            <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>已移除成员（{removedMembers.length}）</summary>
            <p className="hint">本地资料仍然保留，恢复后可继续原来的聊天。</p>
            {removedMembers.map(ag => <div key={ag.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <Avatar agent={ag} className="avatar--xs" /><span>{ag.name}</span>
              <button className="btn btn--ghost" data-testid={`restore-member-${ag.id}`} onClick={() => store.dispatch({ type: 'setAgentRemoved', agentId: ag.id, removed: false })}>恢复成员</button>
            </div>)}
          </details>}

          {agent && <AvatarEditor key={agent.id} agent={agent} store={store} />}

          {agent?.kind === 'ai' && <>
          {/* 模式选择 */}
          <div style={{ display: 'flex', gap: 12, padding: '10px 14px', background: 'var(--panel-2)', borderRadius: 8, color: 'var(--ink)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--ink)' }}>
              <input
                type="radio"
                name="agent_mode"
                value="demo"
                data-testid="mode-demo"
                checked={mode === 'demo'}
                onChange={() => setMode('demo')}
              />
              <span>演示模式（本地生成回复，无接口调用）</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--ink)' }}>
              <input
                type="radio"
                name="agent_mode"
                value="real"
                data-testid="mode-real"
                checked={mode === 'real'}
                onChange={() => setMode('real')}
              />
              <span>
                {providerType === 'codex-app-server'
                  ? '真实接口（本机 Codex CLI app-server stdio 直连）'
                  : '真实接口（OpenAI 兼容 / OpenRouter API）'}
              </span>
            </label>
          </div>

          <label className="field">接入方式<select className="input" aria-label="接入方式" value={providerType} onChange={e=>{generationRef.current++;setProviderType(e.target.value as 'openai-compatible'|'codex-app-server');setModel('');setTestResult(null);}}><option value="openai-compatible">OpenAI 兼容 API</option><option value="codex-app-server">本机 Codex CLI</option></select></label>
          {/* 真实接口配置区域 */}
          {mode === 'real' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {providerType === 'codex-app-server' ? (
                /* Coordinator 专属 Codex CLI 界面 */
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ padding: '12px 14px', background: 'rgba(138, 106, 79, 0.15)', border: '1px solid rgba(138, 106, 79, 0.3)', borderRadius: 8 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: '#e8b89a', marginBottom: 4 }}>
                      小屋专属会话 · 本机 Codex CLI (app-server stdio 直连)
                    </div>
                    <p style={{ margin: 0, fontSize: 12, color: 'var(--text-sub)', lineHeight: 1.6 }}>
                      与本机已安装的 Codex CLI 直接进行 stdio JSON-RPC 通信。本会话为<strong>小屋独立专属会话</strong>（具有独立持久 thread，断电/重开后自动续聊；不自动同步办公室完整聊天历史）。
                    </p>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <label className="label">固定工作目录 (CWD)</label>
                      <input className="input" data-testid="codex-cwd-input" value={existingProfile?.codexCwd || ''} disabled readOnly style={{ opacity: 0.8 }} />
                    </div>
                    <div>
                      <label className="label">专属会话绑定标识 (Thread)</label>
                      {(() => {
                        const boundThread =
                          store.data.conversations?.find((c) => c.agentId === selectedAgentId)?.codexThreadId ||
                          existingProfile?.codexThreadId;
                        return (
                          <input
                            className="input"
                            data-testid="codex-thread-id-input"
                            value={boundThread || '未绑定专属 thread (首次发送时自动创建)'}
                            disabled
                            readOnly
                            style={{ opacity: 0.8 }}
                          />
                        );
                      })()}
                    </div>
                  </div>

                  <div style={{ padding: '10px 12px', background: 'var(--panel-2, rgba(255,255,255,0.02))', border: '1px solid var(--border, rgba(255,255,255,0.06))', borderRadius: 8 }} data-testid="codex-sources-panel">
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink, #eee)', marginBottom: 6 }}>
                      本次实际加载的指令与记忆来源
                    </div>
                    {(() => {
                      const conv = store.data.conversations?.find((c) => c.agentId === selectedAgentId);
                      const boundThread = conv?.codexThreadId || existingProfile?.codexThreadId;
                      const hasConfirmedSources = Array.isArray(conv?.instructionSources);
                      const sources: string[] = hasConfirmedSources
                        ? (conv?.instructionSources || [])
                        : (Array.isArray(existingProfile?.instructionSources) ? existingProfile.instructionSources : []);

                      if (!boundThread) {
                        return (
                          <div style={{ fontSize: 11, color: 'var(--text-sub)', lineHeight: 1.6 }}>
                            未绑定专属 thread（首次发送对话时将与 Codex CLI 握手并验证指令来源）
                          </div>
                        );
                      }

                      if (sources.length === 0) {
                        return (
                          <div style={{ fontSize: 11, color: 'var(--text-sub)', lineHeight: 1.6 }}>
                            {hasConfirmedSources
                              ? `已绑定专属会话 (${boundThread})，本次未返回额外指令来源（空列表）`
                              : `已绑定专属会话 (${boundThread})，待下次连接时更新来源回执`}
                          </div>
                        );
                      }

                      return (
                        <div style={{ fontSize: 11, color: 'var(--text-sub)', lineHeight: 1.6 }}>
                          <div style={{ marginBottom: 4 }}>
                            已从专属会话 (<code>{boundThread}</code>) 验证 {sources.length} 个来源（仅加载指定规则，不等于办公室完整历史已读入）：
                          </div>
                          <ul style={{ margin: 0, paddingLeft: 18, listStyleType: 'disc' }}>
                            {sources.map((srcPath, idx) => (
                              <li key={idx} style={{ wordBreak: 'break-all' }}>
                                <code>{String(srcPath)}</code>
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })()}
                  </div>

                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <label className="label">模型选择 (Model)</label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {loadingCodexModels && <span style={{ fontSize: 11, color: 'var(--text-sub)' }}>检测中...</span>}
                        <button
                          type="button"
                          className="btn btn--ghost"
                          data-testid="btn-refresh-codex-models"
                          disabled={loadingCodexModels}
                          onClick={() => {
                            setLoadingCodexModels(true);
                            window.xiaowuDesktop?.codex?.listModels().then((models) => {
                              setLoadingCodexModels(false);
                              if (Array.isArray(models) && models.length > 0) {
                                const names = models.map((m: any) => m.id || m.displayName || String(m));
                                setCodexModels(names);
                                setStatusMsg(`已更新本机 Codex 模型列表 (${names.length} 个)`);
                              }
                            }).catch((e) => {
                              setLoadingCodexModels(false);
                              setStatusMsg(`拉取 Codex 模型失败: ${e?.message || '未知错误'}`);
                            });
                          }}
                          style={{ minHeight: 24, fontSize: 11, padding: '1px 6px' }}
                          title="刷新本机 Codex CLI 可用模型"
                        >
                          <RefreshCw size={11} className={loadingCodexModels ? 'spin' : ''} style={{ marginRight: 3 }} />
                          刷新模型
                        </button>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        className="input"
                        data-testid="model-input"
                        value={model}
                        onChange={(e) => handleModelChange(e.target.value)}
                        placeholder="默认：gpt-6.1-sol"
                      />
                      {codexModels.length > 0 && (
                        <select
                          className="input"
                          style={{ width: 'auto', minWidth: 140 }}
                          value={model}
                          onChange={(e) => handleModelChange(e.target.value)}
                        >
                          {codexModels.map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>
                </div>
            ) : (
              /* 其他 AI（如执行助手 OpenRouter）配置区域 */
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, color: 'var(--text-sub)' }}>
                    {selectedAgentId === 'agent_worker'
                      ? '执行助手 (自选模型) 专属 OpenRouter 接入：请准确填写模型 ID 与 API Key'
                      : '接口规范：OpenAI 兼容 Chat Completions，数据在受信任主进程经安全加密通道传输'}
                  </span>
                  <button
                    className="btn btn--ghost"
                    style={{ minHeight: 28, fontSize: 12, padding: '2px 8px' }}
                    onClick={applyOpenRouterTemplate}
                    title="填入 OpenRouter 默认模板"
                  >
                    <Sparkles size={13} style={{ marginRight: 4 }} />
                    OpenRouter 模板
                  </button>
                </div>

                <div>
                  <label className="label">配置名称</label>
                  <input
                    className="input"
                    data-testid="name-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例如：执行助手专属配置"
                  />
                </div>

                <div>
                  <label className="label">接口 Base URL（支持 HTTPS 及本地回环）</label>
                  <input
                    className="input"
                    data-testid="base-url-input"
                    value={baseUrl}
                    onChange={(e) => handleBaseUrlChange(e.target.value)}
                    placeholder="例如：https://openrouter.ai/api/v1"
                  />
                </div>

                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <label className="label" style={{ margin: 0 }}>模型名称 (Model ID) *必填</label>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      data-testid="btn-fetch-models"
                      disabled={fetchingModels || !baseUrl.trim()}
                      onClick={handleFetchModels}
                      style={{ minHeight: 26, fontSize: 12, padding: '2px 8px' }}
                      title="从该服务接口拉取可用模型列表"
                    >
                      <RefreshCw size={12} className={fetchingModels ? 'spin' : ''} style={{ marginRight: 4 }} />
                      {fetchingModels ? '正在拉取…' : '拉取模型'}
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      className="input"
                      data-testid="model-input"
                      value={model}
                      onChange={(e) => handleModelChange(e.target.value)}
                      placeholder={selectedAgentId === 'agent_worker' ? '输入自己的模型 ID' : '可手动输入，或点击“拉取模型”选择'}
                    />
                    {fetchedModels.length > 0 && (
                      <button
                        type="button"
                        className="btn btn--ghost"
                        data-testid="btn-toggle-models-dropdown"
                        onClick={() => setModelDropdownOpen((v) => !v)}
                        style={{ minHeight: 36, padding: '0 10px', fontSize: 12, whiteSpace: 'nowrap' }}
                        title="展开/收起模型选择列表"
                      >
                        <ChevronDown size={14} style={{ transform: modelDropdownOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', marginRight: 4 }} />
                        {modelDropdownOpen ? '收起列表' : `可选 (${fetchedModels.length})`}
                      </button>
                    )}
                  </div>

                  {/* 远程拉取的模型列表浮层或内嵌卡片 */}
                  {modelDropdownOpen && fetchedModels.length > 0 && (
                    <div
                      data-testid="model-catalog-panel"
                      style={{
                        marginTop: 8,
                        padding: 10,
                        background: 'var(--panel-2, #1f1b24)',
                        border: '1px solid var(--border, #3a3242)',
                        borderRadius: 8,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }}>
                        <Search size={14} style={{ position: 'absolute', left: 8, color: 'var(--text-sub)' }} />
                        <input
                          className="input"
                          data-testid="model-search-input"
                          value={modelSearch}
                          onChange={(e) => setModelSearch(e.target.value)}
                          placeholder="搜索模型名称或 ID..."
                          style={{ paddingLeft: 28, height: 32, fontSize: 12 }}
                        />
                        {modelSearch && (
                          <button
                            type="button"
                            className="btn btn--icon"
                            onClick={() => setModelSearch('')}
                            style={{ width: 24, height: 24, padding: 0 }}
                            title="清除搜索"
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>

                      <div
                        data-testid="model-list-container"
                        style={{
                          maxHeight: 200,
                          overflowY: 'auto',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                          paddingRight: 4,
                        }}
                      >
                        {filteredModels.length === 0 ? (
                          <div style={{ fontSize: 12, color: 'var(--text-sub)', textAlign: 'center', padding: '12px 0' }}>
                            未找到匹配的模型
                          </div>
                        ) : (
                          filteredModels.map((item) => {
                            const isSelected = model === item.id;
                            return (
                              <button
                                key={item.id}
                                type="button"
                                data-testid={`model-item-${item.id}`}
                                onClick={() => {
                                  handleModelChange(item.id);
                                  setModelDropdownOpen(false);
                                  setStatusMsg(`已选择模型：${item.name || item.id}`);
                                }}
                                style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  alignItems: 'flex-start',
                                  padding: '6px 10px',
                                  borderRadius: 6,
                                  border: isSelected ? '1px solid var(--accent, #a67c52)' : '1px solid transparent',
                                  background: isSelected ? 'rgba(166, 124, 82, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                                  cursor: 'pointer',
                                  textAlign: 'left',
                                  transition: 'background 0.15s',
                                }}
                              >
                                <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                                  <span style={{ fontWeight: 600, fontSize: 12, color: isSelected ? 'var(--accent-light, #ffd599)' : 'var(--text, #eee)' }}>
                                    {item.name || item.id}
                                  </span>
                                  {isSelected && <Check size={13} style={{ color: 'var(--accent-light, #ffd599)' }} />}
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--text-sub)', wordBreak: 'break-all' }}>
                                  {item.id}
                                </div>
                                {(item.context_length || item.pricing) && (
                                  <div style={{ display: 'flex', gap: 8, fontSize: 10, color: 'var(--text-muted, #888)', marginTop: 2 }}>
                                    {item.context_length ? <span>上下文: {Math.round(item.context_length / 1024)}k</span> : null}
                                    {item.pricing ? (
                                      <span>定价: Prompt {item.pricing.prompt || '-'} / Completion {item.pricing.completion || '-'}</span>
                                    ) : null}
                                  </div>
                                )}
                                {item.description && (
                                  <div style={{ fontSize: 10, color: 'var(--text-sub)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                                    {item.description}
                                  </div>
                                )}
                              </button>
                            );
                          })
                        )}
                      </div>
                      {isTruncated && (
                        <div style={{ fontSize: 10, color: 'var(--text-sub)', textAlign: 'right' }}>
                          * 已达显示上限（最多展示 150 项），若未见目标请手动输入 Model ID
                        </div>
                      )}
                    </div>
                  )}

                  {modelsError && (
                    <div style={{ fontSize: 11, color: 'var(--danger, #ff6b6b)', marginTop: 4 }}>
                      {modelsError}（如服务不支持目录查询，可直接在上方手动输入 Model ID）
                    </div>
                  )}

                  {selectedAgentId === 'agent_worker' && (
                    <div style={{ fontSize: 11, color: 'var(--text-sub)', marginTop: 4 }}>
                      推荐模型：<code style={{ background: 'var(--panel-2)', padding: '1px 4px', borderRadius: 4 }}>stealth/space-bunny-alpha</code>（自选模型 实验性模型，不承诺永久免费或持续可用，失效时可随时换填其他可用模型）。
                    </div>
                  )}
                </div>

                {/* API 密钥管理 */}
                <div style={{ background: 'var(--panel-sub-bg, rgba(0,0,0,0.15))', padding: '12px 14px', borderRadius: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <label className="label" style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
                      <Key size={14} />
                      API 密钥（Key）
                    </label>
                    {hasEncryptedKey && (
                      <span style={{ fontSize: 12, color: 'var(--success, #74c991)', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Shield size={13} /> 已通过 Windows DPAPI 加密存储
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="password"
                      className="input"
                      data-testid="api-key-input"
                      value={apiKeyInput}
                      onChange={(e) => handleApiKeyChange(e.target.value)}
                      placeholder={hasEncryptedKey ? '•••••••••••••••• （已保存密钥，输入可替换）' : '粘贴 API Key（输入后保存即加密，前端不留明文）'}
                      autoComplete="off"
                    />
                    {hasEncryptedKey && (
                      <button
                        className="btn btn--danger btn--ghost"
                        style={{ minHeight: 36, whiteSpace: 'nowrap', fontSize: 12 }}
                        onClick={handleDeleteKey}
                        title="从安全存储中删除该密钥"
                      >
                        清除凭据
                      </button>
                    )}
                  </div>
                  <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--text-sub)' }}>
                    密钥绝不写入普通数据 JSON，不随聊天导出泄漏，仅限主进程发起网络请求时在内存短暂解密。
                  </p>
                </div>
              </div>
            )}

            {/* 连接测试 */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--card-bg, rgba(255,255,255,0.03))', borderRadius: 8 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>连接连通性检查</div>
                  <div style={{ fontSize: 12, color: 'var(--text-sub)' }}>
                    {testResult
                      ? testResult.success
                        ? `最近验证成功 (${testResult.latencyMs ? testResult.latencyMs + 'ms · ' : ''}${testResult.timestamp?.slice(0, 19)})`
                        : `验证失败: ${testResult.error}`
                      : '尚未进行手动连接检查'}
                  </div>
                </div>
                <button
                  className="btn btn--ghost"
                  data-testid="btn-test-connection"
                  onClick={handleTestConnection}
                  disabled={testing}
                  style={{ minHeight: 32, fontSize: 13 }}
                >
                  <RefreshCw size={13} className={testing ? 'spin' : ''} style={{ marginRight: 6 }} />
                  {testing ? '检查中…' : '检查连接'}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ padding: '16px', background: 'var(--panel-sub-bg, rgba(0,0,0,0.1))', borderRadius: 8, fontSize: 13, color: 'var(--ink)' }}>
              当前成员处于本地演示模式，所有发言均在本机生成离线演示内容，不会消耗网络与 API 费用。
            </div>
          )}

          {/* 人格与上下文设置 */}
          <div>
            <label className="label">
              {providerType === 'codex-app-server'
                ? '用户补充人格与临时指令 (Developer Instructions)'
                : '成员系统人格设定 (System Prompt)'}
            </label>
            <textarea
              className="input"
              data-testid="system-prompt-input"
              rows={3}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={
                providerType === 'codex-app-server'
                  ? '此处填写的补充说明将作为 developerInstructions 安全注入专属会话（补充设定，不覆盖底层 AGENTS.md 准则与记忆库）；留空则完全沿用底层设定。'
                  : '例如：你是执行助手（自选模型），活泼灵动、富有想象力、真诚体贴的小屋伙伴…'
              }
            />
            {providerType === 'codex-app-server' && (
              <span style={{ fontSize: 11, color: 'var(--text-sub)', marginTop: 4, display: 'block' }}>
                * 说明：协调者的核心准则与爱人设定由 <code>AGENTS.md</code> 权威承载；此处可输入对本会话的临时补充吩咐，直接传入 CLI 生效。
              </span>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label className="label">历史上下文轮数限制</label>
              <input
                type="number"
                className="input"
                min={2}
                max={50}
                value={contextLimit}
                onChange={(e) => setContextLimit(Number(e.target.value))}
              />
              <span style={{ fontSize: 11, color: 'var(--text-sub)' }}>默认 10 轮（共 20 条消息）</span>
            </div>
            <div>
              <label className="label">单次生成最大 Tokens</label>
              <input
                type="number"
                className="input"
                min={128}
                max={8192}
                step={256}
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value))}
              />
              <span style={{ fontSize: 11, color: 'var(--text-sub)' }}>默认 2048</span>
            </div>
          </div>

          {statusMsg && (
            <div style={{ padding: '8px 12px', borderRadius: 6, fontSize: 12, background: 'var(--accent, #6a4c93)', color: '#fff' }}>
              {statusMsg}
            </div>
          )}
          </>}
            </>
          )}
        </div>

        <div className="modal__foot" style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          {mainTab === 'members' && agent?.kind === 'ai' && !agent.removed && <div style={{ marginRight: 'auto' }}>
            {confirmRemove ? <div data-testid="remove-member-confirm" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span>移除「{agent.name}」？聊天、记忆、头像和接口配置都保留在本地。</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn--danger" data-testid="confirm-remove-member" disabled={!store.ready || (!!store.streamingMessageId || data.messages.some(m => m.status === 'streaming')) || testing || fetchingModels || savingConfig} onClick={() => {
                  generationRef.current++;
                  store.dispatch({ type: 'setAgentRemoved', agentId: agent.id, removed: true });
                  onClose();
                }}>确认移除</button>
                <button className="btn btn--ghost" data-testid="cancel-remove-member" onClick={() => setConfirmRemove(false)}>取消</button>
              </div>
            </div> : <button className="btn btn--ghost btn--danger" data-testid="remove-member" disabled={!store.ready || (!!store.streamingMessageId || data.messages.some(m => m.status === 'streaming')) || testing || fetchingModels || savingConfig} title={store.streamingMessageId ? '请等回复完成，或先停止生成' : '从小屋移除，保留本地资料'} onClick={() => setConfirmRemove(true)}>删除成员</button>}
          </div>}
          <button className="btn btn--ghost" onClick={onClose}>
            关闭
          </button>
          {mainTab === 'members' && agent?.kind === 'ai' && (
            <button className="btn btn--primary" data-testid="btn-save-settings" disabled={savingConfig} onClick={handleSave}>
              保存当前配置
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
