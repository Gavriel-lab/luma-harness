import type { CachedVoiceData } from './conversationReconciler';

// Audio only: this does not enable the paused general chat/read-cache candidate.
function openVoices(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('luma-voice-media', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('voices');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function persistVoice(key: string, data: CachedVoiceData): Promise<void> {
  if (!data.audioUrl.startsWith('data:audio/')) return;
  const db = await openVoices();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('voices', 'readwrite');
      transaction.objectStore('voices').put(data, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

export async function restoreVoices(keys: string[]): Promise<Array<[string, CachedVoiceData]>> {
  const db = await openVoices();
  try {
    const transaction = db.transaction('voices', 'readonly');
    return await Promise.all([...new Set(keys)].map(key => new Promise<[string, CachedVoiceData] | null>((resolve, reject) => {
      const request = transaction.objectStore('voices').get(key);
      request.onsuccess = () => resolve(request.result ? [key, request.result] : null);
      request.onerror = () => reject(request.error);
    }))).then(values => values.filter((value): value is [string, CachedVoiceData] => value !== null));
  } finally { db.close(); }
}
