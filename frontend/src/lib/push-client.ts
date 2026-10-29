/**
 * Push notifications on this device (Web Push). The server pushes every in-app notification to
 * the devices a person turned on; this module turns a device on or off and keeps it registered.
 *
 * Where it works: Android (Chrome, Edge, Samsung Internet, Firefox), desktop browsers, and on
 * iPhone/iPad only inside the installed app (Home Screen, iOS 16.4 or later).
 */
import { apiFetch } from "@/lib/api";
import { deviceLabel, isIos, isStandalone } from "@/lib/pwa";

const FLAG = "erp.push";   // "on" once the person turned notifications on here (cleared on sign-out)

export type PushState =
  | "unsupported"        // this browser can't do push at all
  | "ios-needs-install"  // iPhone/iPad Safari: only the Home Screen app can
  | "server-off"         // the server has no push keys configured
  | "blocked"            // the person said "Block" (only the browser's site settings can undo it)
  | "off"
  | "on";

export interface PushConfig { enabled: boolean; public_key: string | null }

function swSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator;
}

export function pushSupported(): boolean {
  return swSupported() && "PushManager" in window && "Notification" in window;
}

function keyBytes(base64url: string): Uint8Array {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Hex SHA-256 (first 16 characters) of the device address — what the server shows instead of the address. */
export async function fingerprint(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!swSupported()) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function pushState(config: PushConfig | null): Promise<PushState> {
  // iPhone/iPad: push exists only for the Home Screen app (iOS 16.4+), never in a Safari tab
  if (isIos() && !isStandalone()) return "ios-needs-install";
  if (!pushSupported()) return "unsupported";
  if (config && !config.enabled) return "server-off";
  if (Notification.permission === "denied") return "blocked";
  return Notification.permission === "granted" && (await currentSubscription()) ? "on" : "off";
}

async function register(sub: PushSubscription, showPreview?: boolean) {
  const json = sub.toJSON();
  await apiFetch("/push/subscriptions", {
    method: "POST",
    body: { endpoint: sub.endpoint, keys: json.keys, device_label: deviceLabel(), ...(showPreview === undefined ? {} : { show_preview: showPreview }) },
  });
}

/** Asks permission (must follow a tap), subscribes this device and registers it with the server. */
export async function enablePush(config: PushConfig, showPreview = true): Promise<PushState> {
  if (!pushSupported() || !config.enabled || !config.public_key) return pushState(config);
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "blocked" : "off";
  const reg = (await registration()) ?? (await navigator.serviceWorker.register("/sw.js"));
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // a subscription made with another server key can't receive our messages: replace it
  const key = keyBytes(config.public_key);
  const old = sub?.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
  if (sub && old && (old.length !== key.length || old.some((b, i) => b !== key[i]))) { await sub.unsubscribe(); sub = null; }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
  await register(sub, showPreview);
  try { localStorage.setItem(FLAG, "on"); } catch { /* private mode */ }
  return "on";
}

/** Stops notifications on this device (here and on the server). */
export async function disablePush(): Promise<void> {
  try { localStorage.removeItem(FLAG); } catch { /* private mode */ }
  const sub = await currentSubscription();
  if (!sub) return;
  try { await apiFetch("/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }); } catch { /* the push service will report it gone */ }
  await sub.unsubscribe().catch(() => undefined);
}

/**
 * On every app start (signed in): if this person turned notifications on here, make sure the
 * server has this device's current address (it can change, and devices unused for long are dropped).
 */
export async function syncPush(): Promise<void> {
  try {
    if (!pushSupported() || Notification.permission !== "granted" || localStorage.getItem(FLAG) !== "on") return;
    const config = await apiFetch<PushConfig>("/push/config");
    if (!config.enabled || !config.public_key) return;
    const reg = await registration();
    if (!reg) return;
    const sub = (await reg.pushManager.getSubscription())
      ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.public_key) as BufferSource }));
    await register(sub);
  } catch { /* offline, or the browser refused: try again next time */ }
}

/**
 * Before signing out: this device must stop receiving the person's notifications — the next
 * person to use it would otherwise see them. Also forgets the cached pages and the icon badge.
 */
export async function forgetDeviceOnSignOut(): Promise<void> {
  try { localStorage.removeItem(FLAG); } catch { /* private mode */ }
  try {
    const sub = await currentSubscription();
    if (sub) {
      await apiFetch("/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => undefined);
      await sub.unsubscribe().catch(() => undefined);
    }
    navigator.serviceWorker?.controller?.postMessage({ type: "SIGNED_OUT" });
    (navigator as Navigator & { clearAppBadge?: () => Promise<void> }).clearAppBadge?.().catch(() => undefined);
  } catch { /* never block signing out */ }
}
