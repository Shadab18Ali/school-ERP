export type Channel = "in_app" | "email" | "sms" | "whatsapp";
export type Outbound = Exclude<Channel, "in_app">;

export const CHANNEL_LABEL: Record<Channel, string> = { in_app: "In the app", email: "Email", sms: "SMS", whatsapp: "WhatsApp" };

export interface InboxItem { id: string; event_key: string; title: string; body: string; link: string | null; read: boolean; created_at: string }
export interface Inbox { items: InboxItem[]; total: number; unread: number; page: number; page_size: number }
export interface Preferences { email: boolean; sms: boolean; whatsapp: boolean }

export interface ChannelTemplate {
  enabled: boolean; subject: string | null; body: string; wa_template: string | null; wa_language: string | null; wa_params: string[] | null; customised: boolean;
}
export interface EventInfo {
  key: string; label: string; description: string; audience: string; variables: Record<string, string>;
  channels: Partial<Record<Channel, ChannelTemplate>>;
}

export interface NotifySettings {
  email_enabled: boolean; reply_to: string | null; quiet_start: number; quiet_end: number; fee_reminder_days: number[];
  sms_daily_limit: number; whatsapp_daily_limit: number; email_server: { configured: boolean; from: string | null };
}

export interface ChannelAccount {
  configured: boolean; enabled: boolean; provider: "twilio" | "meta"; config: Record<string, string | null>;
  has_app_secret: boolean; verify_token: string | null; updated_at: string | null; webhook_url: string;
}
export interface Channels { sms: ChannelAccount; whatsapp: ChannelAccount }

export type EventStatus = "pending" | "processing" | "done" | "skipped" | "failed";
export type DeliveryStatus = "queued" | "sending" | "sent" | "delivered" | "read" | "failed" | "skipped";

export interface HistoryItem {
  id: string; event_key: string; label: string; status: EventStatus; error: string | null; recipients: number;
  created_at: string; processed_at: string | null; triggered_by: string | null; in_app: number; counts: Record<string, number>;
}
export interface Delivery {
  id: string; channel: Outbound; recipient_name: string | null; recipient_kind: string; address: string; subject: string | null; body: string;
  wa_template: string | null; status: DeliveryStatus; error: string | null; attempts: number; provider: string | null;
  provider_message_id: string | null; sent_at: string | null; updated_at: string; next_attempt_at: string;
}
export interface HistoryDetail {
  id: string; event_key: string; status: EventStatus; error: string | null; recipients: number; created_at: string;
  in_app: { sent: number; read: number }; deliveries: Delivery[];
}

export const DELIVERY_LABEL: Record<DeliveryStatus, string> = {
  queued: "Waiting", sending: "Sending", sent: "Sent", delivered: "Delivered", read: "Read", failed: "Failed", skipped: "Not sent",
};
export const DELIVERY_TONE: Record<DeliveryStatus, string> = {
  queued: "bg-pencil-100 text-ink", sending: "bg-pencil-100 text-ink", sent: "bg-leaf-50 text-leaf-700",
  delivered: "bg-leaf-50 text-leaf-700", read: "bg-leaf-600 text-white", failed: "bg-danger-50 text-danger-600", skipped: "bg-ink/5 text-muted",
};
export const EVENT_STATUS_LABEL: Record<EventStatus, string> = {
  pending: "Waiting", processing: "Preparing", done: "Done", skipped: "Nothing sent", failed: "Failed",
};

/** "sms:delivered" counts -> per channel, per status. */
export function countsByChannel(counts: Record<string, number>): { channel: Outbound; status: DeliveryStatus; n: number }[] {
  return Object.entries(counts)
    .map(([k, n]) => { const [channel, status] = k.split(":"); return { channel: channel as Outbound, status: status as DeliveryStatus, n }; })
    .sort((a, b) => a.channel.localeCompare(b.channel) || a.status.localeCompare(b.status));
}

/** Time since, e.g. "5 min ago". */
export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : d < 7 ? `${d} days ago` : new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/** Rough SMS size: GSM-7 160/153 per part, otherwise Unicode 70/67. Matches the server's count. */
const GSM7 = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
const GSM7_EXT = new Set("^{}\\[~]|€\f"); // allowed, but each takes two characters' room
export function smsParts(text: string): { characters: number; parts: number; unicode: boolean } {
  const unicode = [...text].some((ch) => !GSM7.has(ch) && !GSM7_EXT.has(ch));
  const [single, multi] = unicode ? [70, 67] : [160, 153];
  const n = unicode ? text.length : text.length + [...text].filter((ch) => GSM7_EXT.has(ch)).length;
  return { characters: n, parts: n <= single ? 1 : Math.ceil(n / multi), unicode };
}

export const UNREAD_EVENT = "erp:notifications-changed";
/** Tell the bell to refresh its count (after reading items on the inbox page). */
export function notifyInboxChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(UNREAD_EVENT));
}
