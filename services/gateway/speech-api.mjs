const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const error = (code, message, status) => json({ error: { code, message, retryable: status >= 500 || status === 429 } }, status);

// Owner authentication happens in index.mjs before either speech endpoint.
export async function handleSpeech(request, env, fetcher = fetch) {
  if (request.method !== 'POST') return error('method_not_allowed', '请使用 POST 请求', 405);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return error('forbidden', '请求来源不符', 403);
  if (!env.FISH_AUDIO_API_KEY) return error('speech_not_configured', '语音服务尚未配置', 503);
  const asr = new URL(request.url).pathname === '/api/stt';
  let body, headers = { Authorization: `Bearer ${env.FISH_AUDIO_API_KEY}` };
  try {
    if (asr) {
      const form = await request.formData();
      const audio = form.get('audio');
      if (!audio || typeof audio === 'string' || !audio.size) return error('empty_audio', '没有收到录音，请重新录制', 400);
      if (audio.size > 25 * 1024 * 1024) return error('audio_too_large', '录音超过 25 MB，请分段发送', 413);
      body = new FormData();
      body.append('audio', audio, audio.name || 'speech.webm');
      body.append('language', 'zh');
      body.append('ignore_timestamps', 'true');
      body.append('tag_audio_events', 'false');
      body.append('diarize', 'false');
      headers.model = env.FISH_ASR_MODEL || 'transcribe-1-pro';
    } else {
      const input = await request.json();
      if (typeof input.text !== 'string' || !input.text.trim()) return error('empty_text', '没有可朗读的文字', 400);
      if (input.text.length > 12000) return error('text_too_long', '文字过长，请分段朗读', 413);
      const reference = input.reference_id || env.FISH_DEFAULT_VOICE_ID;
      if(!reference)return error('voice_not_configured','Configure your own voice reference',503);
      if (typeof reference !== 'string' || !/^[a-f0-9]{32}$/i.test(reference)) return error('invalid_voice', '音色 ID 格式不正确，请检查房间设置', 400);
      headers['content-type'] = 'application/json';
      headers.model = env.FISH_TTS_MODEL || 's2.1-pro-free';
      body = JSON.stringify({ text: input.text.trim(), reference_id: reference, format: 'mp3' });
    }
  } catch { return error('invalid_request', asr ? '无法读取录音文件' : '无法读取语音请求', 400); }
  try {
    const upstream = await fetcher(`https://api.fish.audio/v1/${asr ? 'asr' : 'tts'}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(120000) });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      const status = upstream.status === 429 ? 429 : 502;
      const message = [401, 403].includes(upstream.status) ? '语音服务授权失败，请检查后台配置' : upstream.status === 402 ? '语音服务额度不足' : upstream.status === 429 ? '语音服务繁忙，请稍后重试' : '语音服务未完成请求，请稍后重试';
      return error(asr ? 'stt_failed' : 'tts_failed', message, status);
    }
    if (asr) {
      const data = await upstream.json();
      if (typeof data.text !== 'string') return error('invalid_transcript', '语音服务返回了无效文字', 502);
      const text = data.text.replace(/<\|speaker:\d+\|>/g, '').trim();
      if (!text) return error('no_speech', '没听清这段录音，可以重试或重新录制', 422);
      return json({ text, duration: Number.isFinite(data.duration) ? data.duration : null });
    }
    if (!upstream.headers.get('content-type')?.startsWith('audio/')) return error('invalid_audio', '语音服务未返回音频', 502);
    return new Response(upstream.body, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  } catch { return error('speech_unavailable', '语音服务连接失败，请稍后重试', 503); }
}
