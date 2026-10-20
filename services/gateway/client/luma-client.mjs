// Browser only. Uses the owner's Access cookie; contains no API/service secrets.
export class LumaClientError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function createLumaClient(fetcher = globalThis.fetch.bind(globalThis)) {
  async function read(path) {
    let response;
    try {
      response = await fetcher(path, { credentials: 'same-origin', cache: 'no-store',
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    } catch { throw new LumaClientError('network_unavailable'); }
    // Access can redirect a fetch to HTML even when the final status is 200.
    if (response.redirected || response.status === 401 ||
        response.headers.get('content-type')?.includes('text/html')) {
      throw new LumaClientError('login_required');
    }
    let data;
    try { data = await response.json(); }
    catch { throw new LumaClientError('invalid_response'); }
    if (!response.ok) throw new LumaClientError(data.error || 'request_failed');
    return data;
  }
  return { bootstrap: () => read('/api/bootstrap'), session: () => read('/api/session') };
}
