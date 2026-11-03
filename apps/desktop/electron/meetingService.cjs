'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class MeetingService {
  constructor({ dir, getMembers, startChat, stopChat, prepareMember, recoverMember, beforeStart = async()=>{}, timeoutMs = 240000 }) {
    Object.assign(this, { getMembers, startChat, stopChat, prepareMember, recoverMember, beforeStart, timeoutMs });
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'meeting.json');
    this.state = null;
    try { this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : null; }
    catch { this.loadError = '会议进度文件无法读取，已保留原文件，请先检查'; }
    this.recoveries = new Map();
    this.loop = null;
    this.cancelTurn = null;
    this.commands = Promise.resolve();
    if (this.state && ['running', 'preparing'].includes(this.state.status)) {
      this.state.status = 'paused';
      this.state.notice = '桌面主机重启，会议保留在原位置；继续前检查旧请求状态。';
      this.save();
    }
  }
  save() { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.state, null, 2)); fs.renameSync(this.file + '.tmp', this.file); }
  active() { return !!this.state && ['preparing', 'running'].includes(this.state.status); }
  holdsFloor() { return this.active() || this.state?.status === 'paused'; }
  snapshot() { if(this.loadError)throw Error(this.loadError); return this.state ? JSON.parse(JSON.stringify(this.state)) : null; }
  command(action, input) {
    const pending = this.commands.then(async () => {
      if (this.loadError) throw Error(this.loadError);
      if (action === 'start') {
        if (this.state?.startRequestId !== input.requestId && (this.state?.id ?? null) !== input.meetingId) {
          throw Error('会议已切换，请刷新后重试');
        }
        return this.start(input);
      }
      if (!this.state || this.state.id !== input.meetingId) throw Error('会议已切换，请刷新后重试');
      if (action === 'pause') return this.pause();
      if (action === 'end') return this.end();
      return this.resume(input);
    });
    this.commands = pending.catch(() => {});
    return pending;
  }
  view() {
    const state = this.snapshot();
    if (!state) return null;
    const { id, topic, status, round, maxRounds, participants, members, entries, result, notice } = state;
    return { id, topic, status, round, maxRounds, participants, members: Object.fromEntries(
      Object.entries(members).map(([id, member]) => [id, { status: member.status }])
    ), entries: entries.slice(-20).map(({ agent, round, phase, outcome, text }) => ({
      agent, round, phase, outcome, text: text?.slice(0, 1500)
    })), result, notice };
  }
  async start({ requestId, text, maxRounds = 3 }) {
    if (this.state?.startRequestId === requestId) {
      if (this.state.topic !== text || this.state.maxRounds !== maxRounds) throw Error('请求编号已用于另一项操作');
      return;
    }
    if (this.loop || this.holdsFloor() || this.recoveries.size) throw Error('请先继续或结束现有会议');
    const prior = this.state?.current || this.state?.pendingStop;
    if (prior && !prior.completed) await this.recoverMember(prior.agent, prior.requestId);
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) throw Error('轮数须为 1–10');
    const participants = this.getMembers();
    if (!participants.includes('agent_coordinator')) throw Error('请先为协调者配置可用的会议连接');
    this.state = { id: randomUUID(), startRequestId: requestId, topic: text, notes: [], participants,
      maxRounds, round: 1, index: 0, phase: 'discussion', status: 'preparing', members: {}, entries: [], notice: '', current: null };
    this.save();
    this.run();
  }
  run() {
    if (this.loop) return;
    this.loop = this.execute().catch(() => {
      this.state.status = 'paused';
      this.state.notice = '会议进度保存失败，请检查桌面主机';
      try { this.save(); } catch (error) { console.error('[meeting] save failed:', error.code); }
    }).finally(() => { this.loop = null; });
  }
  async execute() {
    const s = this.state;
    if (s.status === 'preparing') {
      await this.beforeStart();
      if (s.status !== 'preparing') return;
      await Promise.all(s.participants.map(async a => {
        try { await this.prepareMember(a); s.members[a] = { status: 'ready' }; }
        catch (e) { s.members[a] = { status: 'unavailable', reason: e.message }; this.recover(a); }
      }));
      if (s.status !== 'preparing') return;
      s.status = 'running'; this.save();
    }
    while (s.status === 'running') {
      const summary = s.phase === 'summary';
      const agent = summary ? 'agent_coordinator' : s.participants[s.index];
      if (this.recoveries.has(agent)) {
        if (agent === 'agent_coordinator') { s.status = 'paused'; s.notice = '主持线路正在恢复，请恢复后继续'; this.save(); return; }
        s.entries.push({ round: s.round, agent, outcome: 'skipped', reason: '连接正在恢复，本轮由下一位继续' });
        this.advance(); continue;
      }
      const requestId = `meeting_${s.id}_${randomUUID()}`;
      s.current = { agent, requestId, text: '', round: s.round, phase: s.phase };
      s.members[agent] = { status: 'speaking' }; this.save();
      try {
        // Old attempts must be accounted for before this member gets another turn.
        await this.prepareMember(agent);
        if (s.status !== 'running') return;
        const prompt = this.prompt(agent, summary);
        const text = await this.turn(agent, requestId, prompt);
        if (s.status !== 'running') return;
        if (!text.trim()) throw Error('本轮没有返回可用内容');
        s.current.text = text; s.current.completed = true;
        s.entries.push({ round: s.round, phase: s.phase, agent, requestId, outcome: 'sent', text });
        s.members[agent] = { status: 'ready' };
        s.current = null;
        if (summary && (s.round >= s.maxRounds || /^\[会议结论已就绪\]$/m.test(text))) { s.result = text.replace(/^\[会议结论已就绪\]$/gm, '').trim() || text; this.close('completed'); return; }
        this.advance();
      } catch (e) {
        if (s.status !== 'running') return;
        if (e.code) throw e;
        s.entries.push({ round: s.round, phase: s.phase, agent, requestId, outcome: 'failed', reason: e.message, partial: s.current?.text || '' });
        s.current = null;
        s.members[agent] = { status: 'recovering', reason: e.message };
        this.recover(agent, requestId);
        if (agent === 'agent_coordinator') { s.status = 'paused'; s.notice = '主持线路异常，进度已保留'; this.save(); return; }
        this.advance();
      }
    }
  }
  advance() {
    const s = this.state;
    if (s.phase === 'summary') { s.round++; s.index = 0; s.phase = 'discussion'; }
    else if (++s.index >= s.participants.length) s.phase = 'summary';
    this.save();
  }
  recover(agent, requestId) {
    if (this.recoveries.has(agent)) return;
    const s = this.state;
    const open = () => this.state === s && !['ended','completed'].includes(s.status);
    const p = Promise.resolve().then(() => { if(open())return this.recoverMember(agent, requestId); }).then(() => {
      if (open()) s.members[agent] = { status: 'ready', rejoined: true };
    }).catch(e => { if (open()) s.members[agent] = { status: 'unavailable', reason: e.message }; })
      .finally(() => { this.recoveries.delete(agent); if (open()) { try { this.save(); } catch (error) { console.error('[meeting] save failed:', error.code); } } });
    this.recoveries.set(agent, p);
  }
  prompt(agent, summary) {
    const s = this.state;
    const recent = s.entries.slice(-12).map(e => `[第${e.round}轮 ${e.agent}] ${e.outcome === 'sent' ? e.text : `缺席/连接异常：${e.reason}`}`).join('\n\n').slice(-18000);
    const missed = s.entries.filter(e => e.agent === agent && e.outcome !== 'sent').length;
    const notes = s.notes.map(note => note.text).join('\n').slice(-4000);
    return `【会议室自动主持：第${s.round}/${s.maxRounds}轮】\n原始需求：${s.topic}\n用户会中补充：${notes || '无'}\n最近讨论：\n${recent}\n${missed ? '你之前有连接中断或错过发言，请基于补齐的讨论自然接上；可以如实说明，不要假装自己已参与缺席部分。' : ''}\n${summary ? `你是协调者主持人。总结共识、分歧和下一轮需要解决的问题；已有足够方案时交付完整结论，并在末尾单独写[会议结论已就绪]。第${s.maxRounds}轮必须收束，明确未验证项，不编造全员一致。` : '现在轮到你发言。针对现有讨论补充、质疑或提出具体方案，避免重复和闲聊；不替其他成员发言。'}\n本次仅讨论，不自动批准或派发工作。`;
  }
  turn(agent, requestId, currentText) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, text) => { if (done) return; done = true; clearTimeout(timer); this.cancelTurn = null; error ? reject(error) : resolve(text); };
      const timer = setTimeout(() => {
        finish(Error('本轮回复超时，转交下一位并恢复连接'));
      }, this.timeoutMs);
      this.cancelTurn = () => {
        finish(Error('会议已暂停'));
        return this.stopChat(requestId);
      };
      Promise.resolve(this.startChat({ requestId, conversationId: 'conv_meeting_room', targetAgentId: agent, currentText, isUserInitiated: false }, (channel, data) => {
        if (done) return;
        if (channel === 'chat:stream-chunk' && this.state.current?.requestId === requestId) this.state.current.text = (this.state.current.text + (data.delta || '')).slice(0, 16000);
        if (channel === 'chat:stream-done') finish(null, (data.accumulatedText || this.state.current.text).slice(0, 16000));
        if (['chat:stream-error', 'chat:stream-stopped'].includes(channel)) finish(Error(data.error || '连接已中断'));
      })).then(r => { if (!r?.ok) finish(Error(r?.reason || '无法启动回复')); }).catch(e => finish(e));
    });
  }
  async pause() {
    if (!this.active()) return this.snapshot();
    this.state.status = 'paused';
    this.state.notice = '会议已暂停，可补充意见后继续';
    const current = this.state.current;
    if (current && !current.completed) this.state.members[current.agent] = { ...this.state.members[current.agent], status:'paused' };
    await this.cancelTurn?.();
    await this.loop;
    this.save(); return this.snapshot();
  }
  async resume({ requestId, text = '' }) {
    const s = this.state;
    if (s.resumeRequest?.id === requestId) {
      if (s.resumeRequest.text !== text) throw Error('请求编号已用于另一项操作');
      return;
    }
    if (s.status !== 'paused' || this.loop) throw Error('会议当前不能继续');
    await this.beforeStart();
    if (s.current && !s.current.completed) await this.recoverMember(s.current.agent, s.current.requestId);
    s.current = null;
    if (text) s.notes = [...s.notes.slice(-19), { text }];
    s.resumeRequest = { id: requestId, text };
    s.status = 'running';
    s.notice = '';
    this.save();
    this.run();
  }
  close(status) {
    const s = this.state;
    // Keep cancellation ownership for the next start, without presenting an
    // archived turn or an old connection check as live meeting activity.
    if (s.current) { s.pendingStop ||= s.current; s.current = null; }
    s.memberHistory ||= JSON.parse(JSON.stringify(s.members || {}));
    const members = new Set([...(s.participants || []), ...Object.keys(s.members || {})]);
    s.members = Object.fromEntries([...members].map(id=>[id,{status:'closed'}]));
    s.status = status;
    s.notice = status === 'completed' ? '会议已完成，结论与讨论记录已保留。' : '会议已结束，讨论记录已保留。';
    this.save();
  }
  async end() { await this.pause(); if (this.state) this.close('ended'); return this.snapshot(); }
}
module.exports = { MeetingService };
