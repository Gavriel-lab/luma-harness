import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSpeech } from './speech-api.mjs';
import { createWorker } from './index.mjs';

const env = { FISH_AUDIO_API_KEY: 'synthetic-private-key' };
const tts = (body, origin) => new Request('https://luma.test/api/tts', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });

test('speech routes work without ASSETS and still require owner authentication', async () => {
  const app = createWorker(async () => { throw new Error('not-owner'); });
  for (const path of ['/api/tts', '/api/stt']) {
    const response = await app.fetch(new Request('https://luma.test' + path, { method: 'POST' }), env);
    assert.equal(response.status, 503);
    assert.equal(await response.text(), '{"error":"identity_unavailable"}');
  }
});
test('tts keeps the entire reply, uses the selected voice and backend-only key', async () => {
  const text = '你好，今天的长回复。'.repeat(75);
  const reference = 'a'.repeat(32);
  let seen;
  const response = await handleSpeech(tts({ text, reference_id: reference, api_key: 'caller-key' }), env, async (url, options) => {
    seen = { url, options, input: JSON.parse(options.body) };
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
  });
  assert.equal(response.status, 200);
  assert.equal(seen.input.text, text);
  assert.equal(seen.input.reference_id, reference);
  assert.equal(seen.options.headers.Authorization, 'Bearer synthetic-private-key');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('mp4 recording bytes reach ASR unchanged with explicit browser-capable model', async () => {
  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array([5, 6, 7])], { type: 'audio/mp4' }), 'speech.m4a');
  const request = new Request('https://luma.test/api/stt', { method: 'POST', body: form });
  const response = await handleSpeech(request, env, async (url, options) => {
    assert.equal(url, 'https://api.fish.audio/v1/asr');
    assert.equal(options.headers.model, 'transcribe-1-pro');
    assert.equal(options.headers['content-type'], undefined);
    const audio = options.body.get('audio');
    assert.equal(audio.type, 'audio/mp4');
    assert.deepEqual([...new Uint8Array(await audio.arrayBuffer())], [5, 6, 7]);
    return Response.json({ text: '<|speaker:0|> 你好助手。', duration: 3.1 });
  });
  assert.deepEqual(await response.json(), { text: '你好助手。', duration: 3.1 });
});
test('empty transcripts and provider errors never become a fake user voice message', async () => {
  const request = () => { const form = new FormData(); form.append('audio', new Blob(['sound']), 'speech.webm'); return new Request('https://luma.test/api/stt', { method: 'POST', body: form }); };
  const empty = await handleSpeech(request(), env, async () => Response.json({ text: '<|speaker:0|> ', duration: 1 }));
  assert.equal(empty.status, 422);
  const rejected = await handleSpeech(request(), env, async () => new Response('provider secret synthetic-private-key', { status: 401 }));
  assert.equal(rejected.status, 502);
  assert.equal((await rejected.text()).includes('synthetic-private-key'), false);
});
test('invalid inputs fail before provider calls, and JSON is never passed as an MP3', async () => {
  const forbidden = await handleSpeech(tts({ text: 'hello' }, 'https://elsewhere.test'), env);
  assert.equal(forbidden.status, 403);
  assert.equal((await handleSpeech(tts({ text: 'hello' }), {})).status, 503);
  assert.equal((await handleSpeech(tts({ text: 'hello', reference_id: 'wrong' }), env)).status, 400);
  const invalidAudio = await handleSpeech(tts({ text: 'hello', reference_id: 'a'.repeat(32) }), env, async () => Response.json({ ok: false }));
  assert.equal(invalidAudio.status, 502);
});
test('unconfigured optional voice never uses another owners voice reference',async()=>{
 let called=false;const response=await handleSpeech(tts({text:'hello'}),env,async()=>{called=true;return new Response('');});
 assert.equal(response.status,503);assert.equal(called,false);
});
