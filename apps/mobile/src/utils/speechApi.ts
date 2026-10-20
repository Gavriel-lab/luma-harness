export function speechText(text: string): string {
  return text.replace(/\[语音[^\]]*\]/g, '').replace(/```[\s\S]*?```/g, '（代码请查看文字消息。）')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_#`~]/g, '').trim();
}

export async function speechResponse(response: Response): Promise<Response> {
  if (response.headers.get('content-type')?.includes('text/html')) throw new Error('请重新登录小屋后使用语音');
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.message || data?.message || `语音请求失败 (${response.status})`);
  }
  return response;
}

export function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('无法读取录音'));
    reader.readAsDataURL(blob);
  });
}

export async function transcribeVoice(audio: Blob, signal?: AbortSignal): Promise<{ text: string; duration: number | null }> {
  const extension = audio.type.includes('mp4') ? 'm4a' : audio.type.includes('ogg') ? 'ogg' : 'webm';
  const form = new FormData();
  form.append('audio', audio, `speech.${extension}`);
  const response = await speechResponse(await fetch('/api/stt', { method: 'POST', body: form, signal }));
  const result = await response.json();
  if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('没听清这段录音，请重新录制');
  return result;
}

export async function audioDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const audio = new Audio();
    const timer = setTimeout(() => finish(0), 5000);
    const finish = (duration: number) => {
      clearTimeout(timer); audio.onloadedmetadata = null; audio.onerror = null; audio.removeAttribute('src'); audio.load(); resolve(duration);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) ? audio.duration : 0);
    audio.onerror = () => finish(0);
    audio.src = url;
  });
}

export async function fetchTtsVoice(text: string, referenceId?: string, signal?: AbortSignal): Promise<{ audioUrl: string; duration: number }> {
  const clean = speechText(text);
  if (!clean) throw new Error('没有可朗读的文字');
  const response = await speechResponse(await fetch('/api/tts', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: clean, ...(referenceId ? { reference_id: referenceId } : {}) }), signal,
  }));
  const blob = await response.blob();
  if (!blob.size || !blob.type.startsWith('audio/')) throw new Error('语音服务没有返回可播放的音频');
  const audioUrl = await blobDataUrl(blob);
  return { audioUrl, duration: await audioDuration(audioUrl) };
}

export function recordingMime(): string | undefined {
  return ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
}
