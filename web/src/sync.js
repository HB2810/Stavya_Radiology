// Cross-tab live sync: each browser tab keeps its own login (sessionStorage) and polls a cheap
// server stamp so reception / assistant / technician tabs refresh together.
import { api } from './api.js';

const EVT = 'ris-sync';
const bus = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('stavya-ris-sync') : null;

let lastStamp = '';
let timer = null;
let started = false;

export function notifyLocalChange() {
  window.dispatchEvent(new CustomEvent(EVT, { detail: { local: true } }));
  try { bus?.postMessage({ t: Date.now() }); } catch { /* ignore */ }
}

export function onSync(fn) {
  const handler = () => fn();
  window.addEventListener(EVT, handler);
  const onBus = () => fn();
  bus?.addEventListener('message', onBus);
  return () => {
    window.removeEventListener(EVT, handler);
    bus?.removeEventListener('message', onBus);
  };
}

async function tick() {
  if (document.visibilityState === 'hidden') return;
  try {
    const s = await api.get('/sync');
    if (s?.stamp && s.stamp !== lastStamp) {
      const first = !lastStamp;
      lastStamp = s.stamp;
      if (!first) window.dispatchEvent(new CustomEvent(EVT, { detail: { stamp: s.stamp } }));
    } else if (!lastStamp && s?.stamp) {
      lastStamp = s.stamp;
    }
  } catch { /* signed out / offline */ }
}

export function startLiveSync(intervalMs = 2500) {
  if (started) return;
  started = true;
  tick();
  timer = setInterval(tick, intervalMs);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
}

export function stopLiveSync() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
