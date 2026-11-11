// Web alerts (plan section 10b): ring sound, browser notification, web push.
// TODO: alerts.native.ts with expo-notifications (APNs / FCM) and a server sender.

const BASE = process.env.EXPO_BASE_URL || '/callenvoy';

export type Permission = 'default' | 'granted' | 'denied' | 'unsupported';

let ctx: AudioContext | null = null;

/** Plays a two-tone ring every 2 s until the returned stop function is called.
 *  Browsers allow sound only after the owner clicked the page once; until then it stays silent. */
export function startRing(): () => void {
  const ring = () => {
    if (!navigator.userActivation?.hasBeenActive) return;
    ctx ??= new AudioContext();
    const c = ctx;
    void c.resume();
    for (const [i, hz] of [880, 660, 880, 660].entries()) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      const t = c.currentTime + i * 0.25;
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.15, t);
      gain.gain.setValueAtTime(0, t + 0.2);
      osc.connect(gain).connect(c.destination);
      osc.start(t);
      osc.stop(t + 0.22);
    }
  };
  ring();
  const timer = setInterval(ring, 2000);
  return () => clearInterval(timer);
}

export function notificationPermission(): Permission {
  return typeof Notification === 'undefined' ? 'unsupported' : (Notification.permission as Permission);
}

export async function requestNotifications(): Promise<Permission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  return (await Notification.requestPermission()) as Permission;
}

async function registration() {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` });
}

/** Registers the service worker (asks for nothing) and routes notification clicks to `open`. */
export function setupAlerts(open: (path: string) => void): () => void {
  if (!('serviceWorker' in navigator)) return () => {};
  void registration().catch(() => {});
  const onMessage = (e: MessageEvent) => {
    if (e.data?.type === 'open' && typeof e.data.url === 'string') open(e.data.url.replace(BASE, '') || '/');
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  return () => navigator.serviceWorker.removeEventListener('message', onMessage);
}

/** Shows one notification per call (tag = call id, same as web push). */
export async function showNotification(title: string, body: string, callId: string) {
  if (notificationPermission() !== 'granted') return;
  const options = { body, tag: callId, requireInteraction: true, icon: `${BASE}/icon.png`, data: { url: `${BASE}/calls/${callId}` } };
  const reg = await registration().catch(() => null);
  if (reg) await reg.showNotification(title, options);
  else new Notification(title, options);
}

export function closeNotification(callId: string) {
  void registration()
    .then((reg) => reg?.getNotifications({ tag: callId }))
    .then((list) => list?.forEach((n) => n.close()))
    .catch(() => {});
}

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

/** 'ok', 'home_screen' (iPhone/iPad must add the console to the home screen first) or 'unsupported'. */
export function pushSupport(): 'ok' | 'home_screen' | 'unsupported' {
  if (isIos() && !standalone()) return 'home_screen';
  return 'serviceWorker' in navigator && 'PushManager' in window ? 'ok' : 'unsupported';
}

/** A short name for this device, e.g. "Chrome on Mac". */
export function deviceLabel() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'this device';
  return `${browser} on ${os}`;
}

export async function pushEndpoint(): Promise<string | null> {
  if (pushSupport() !== 'ok') return null;
  const reg = await registration();
  return (await reg?.pushManager.getSubscription())?.endpoint ?? null;
}

/** Subscribes this browser to web push. Returns the body for POST /api/push/subscriptions. */
export async function subscribePush(vapidPublicKey: string) {
  const reg = await registration();
  if (!reg) throw new Error('Push is not supported in this browser.');
  await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(vapidPublicKey) });
  const json = sub.toJSON();
  return { endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' }, label: deviceLabel() };
}

/** Unsubscribes; returns the endpoint to delete on the server. */
export async function unsubscribePush(): Promise<string | null> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return null;
  await sub.unsubscribe();
  return sub.endpoint;
}

function base64UrlToBytes(s: string) {
  const b64 = (s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
