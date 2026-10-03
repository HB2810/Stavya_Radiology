let token = sessionStorage.getItem('ris_token') || '';
export const setToken = (t) => { token = t || ''; t ? sessionStorage.setItem('ris_token', t) : sessionStorage.removeItem('ris_token'); };
export const hasToken = () => Boolean(token);

export class ApiError extends Error {
  constructor(status, body) { super(body?.message || 'Request failed'); this.status = status; this.code = body?.error; this.body = body; }
}

// Every POST carries an Idempotency-Key. If the network drops, the same request is repeated with the same key, so the server
// returns the original result instead of creating a second order, patient or payment. A caller can pass its own `key` to make a
// user-level resubmit (for example after "did that save?") safe too; use newKey() once per form and reuse it until the form succeeds.
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const NO_KEY = ['/auth/login', '/auth/logout', '/auth/forgot', '/auth/reset'];

async function send(method, path, body, headers) {
  const init = { method, headers, body: body ? JSON.stringify(body) : undefined };
  for (let attempt = 0; ; attempt++) {
    try { return await fetch('/api' + path, init); }
    catch (e) { if (method !== 'POST' || !headers['Idempotency-Key'] || attempt >= 2) throw e; await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); }
  }
}

async function request(method, path, body, raw = false, key) {
  const post = method === 'POST' && !NO_KEY.includes(path);
  const res = await send(method, path, body, {
    ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(post ? { 'Idempotency-Key': key || newKey() } : {})
  });
  if (res.status === 401 && token) { setToken(''); window.dispatchEvent(new Event('ris-logout')); }
  if (raw && res.ok) return res.text();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}, opts = {}) => request('POST', p, b, false, opts.key),
  html: (p) => request('GET', p, null, true)
};
