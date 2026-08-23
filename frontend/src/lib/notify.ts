/**
 * Desktop/mobile notifications for incoming messages.
 * Android only allows notifications via a service-worker registration
 * (page-created `new Notification()` throws there), so everything goes
 * through registration.showNotification() with a page-level fallback.
 */

import type { NotifyPrefs } from './api';

const ENABLED_KEY = 'wa_notify';

/** `now` inside the HH:MM..HH:MM window; supports overnight (mirrors backend inQuietHours). */
function inQuietHours(now: Date, start: string, end: string): boolean {
  const parse = (v: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(v);
    if (!m) return null;
    const mins = Number(m[1]) * 60 + Number(m[2]);
    return mins < 24 * 60 ? mins : null;
  };
  const s = parse(start);
  const e = parse(end);
  if (s == null || e == null || s === e) return false;
  const n = now.getHours() * 60 + now.getMinutes();
  return s < e ? n >= s && n < e : n >= s || n < e;
}

/**
 * Whether an incoming message should notify this person, per their prefs.
 * Mirrors the backend shouldNotifyMessage so the in-page and push paths agree:
 * a keyword hit always notifies; else quiet hours mute; else the category toggle.
 * Undefined prefs (not loaded yet) → notify (the pre-prefs default).
 */
export function messageGate(
  prefs: NotifyPrefs | undefined,
  msg: { isGroup: boolean; text: string },
): boolean {
  if (!prefs) return true;
  const kws = prefs.keywords
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  if (kws.length) {
    const t = msg.text.toLowerCase();
    if (kws.some((k) => t.includes(k))) return true;
  }
  if (prefs.quietEnabled && inQuietHours(new Date(), prefs.quietStart, prefs.quietEnd)) return false;
  return msg.isGroup ? prefs.groups : prefs.dms;
}

/** This browser's current push subscription endpoint, for a targeted test push. */
export async function currentPushEndpoint(): Promise<string | null> {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub?.endpoint ?? null;
}

export function registerServiceWorker(): void {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* unsupported / blocked — notifications degrade gracefully */
    });
  }
}

export const notificationsSupported = (): boolean =>
  'Notification' in window || 'serviceWorker' in navigator;

export function notificationsEnabled(): boolean {
  try {
    return (
      localStorage.getItem(ENABLED_KEY) === '1' &&
      'Notification' in window &&
      Notification.permission === 'granted'
    );
  } catch {
    return false;
  }
}

/** Ask for permission (must be called from a user gesture). */
export async function enableNotifications(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  const perm = await Notification.requestPermission();
  const ok = perm === 'granted';
  try {
    localStorage.setItem(ENABLED_KEY, ok ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
  // Register a Web Push subscription so messages notify even with the app
  // closed (the page-driven path dies when the OS suspends the tab). Best
  // effort — a browser without Push still gets the in-page notifications.
  if (ok) await subscribePush().catch(() => {});
  return ok;
}

export function disableNotifications(): void {
  try {
    localStorage.setItem(ENABLED_KEY, '0');
  } catch {
    /* storage unavailable */
  }
  void unsubscribePush().catch(() => {});
}

/** base64url VAPID key → the byte buffer PushManager.subscribe expects. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Subscribe this browser to Web Push and hand the subscription to the server.
 * Reuses any existing subscription. No-op (returns false) where Push isn't
 * available — e.g. iOS Safari that hasn't been installed to the home screen.
 */
export async function subscribePush(): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  const reg = await navigator.serviceWorker.ready;
  const res = await fetch('/api/push/key');
  if (!res.ok) return false;
  const { publicKey } = (await res.json()) as { publicKey?: string };
  if (!publicKey) return false;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));
  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub.toJSON()),
  });
  return true;
}

/** Drop this browser's push subscription, server-side and locally. */
async function unsubscribePush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await fetch('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

/**
 * Show a message notification — only when enabled and the app is hidden.
 * `url` is the deep-link the click opens (e.g. `/?chat=<jid>&msg=<id>`); the SW
 * routes it in-page (see public/sw.js, App deep-link handling).
 */
export function notifyMessage(title: string, body: string, tag: string, url?: string): void {
  if (!notificationsEnabled() || document.visibilityState === 'visible') return;
  const options: NotificationOptions = {
    body,
    tag, // collapse repeated notifications per chat
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: url || '/' },
  };
  navigator.serviceWorker?.getRegistration().then((reg) => {
    if (reg) {
      void reg.showNotification(title, options);
    } else {
      try {
        new Notification(title, options);
      } catch {
        /* page notifications unsupported (Android without SW) */
      }
    }
  });
}
