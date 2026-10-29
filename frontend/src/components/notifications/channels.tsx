"use client";

import { Copy, Send } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { CHANNEL_LABEL, type ChannelAccount, type Channels, type HistoryDetail, type NotifySettings, type Outbound } from "@/lib/notifications";
import { useAuth } from "@/providers/auth-provider";
import { DeliveryPill } from "./history";

function Card({ title, description, badge, children, testId }: { title: string; description?: string; badge?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="rounded-lg border border-line bg-white" data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-5 py-4">
        <div><h2 className="font-semibold">{title}</h2>{description && <p className="mt-0.5 text-sm text-muted">{description}</p>}</div>
        {badge}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Status({ on, configured }: { on: boolean; configured: boolean }) {
  return (
    <span className={on ? "rounded-full bg-leaf-600 px-2.5 py-0.5 text-xs font-medium text-white" : "rounded-full bg-ink/5 px-2.5 py-0.5 text-xs font-medium text-muted"}
      data-testid="channel-status">{on ? "On" : configured ? "Off" : "Not set up"}</span>
  );
}

function CopyLine({ label, value, testId }: { label: string; value: string; testId?: string }) {
  const toast = useToast();
  return (
    <div className="text-sm">
      <p className="text-xs text-muted">{label}</p>
      <span className="mt-0.5 flex items-center gap-2">
        <code className="break-all rounded bg-paper px-2 py-1 text-xs" data-testid={testId}>{value}</code>
        <Button size="sm" variant="ghost" aria-label={`Copy ${label}`} onClick={() => { void navigator.clipboard?.writeText(value).then(() => toast.success("Copied.")); }}><Copy className="size-4" /></Button>
      </span>
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => `${h === 0 ? 12 : h > 12 ? h - 12 : h}:00 ${h < 12 ? "am" : "pm"}`;

function SettingsCard({ schoolId }: { schoolId: string }) {
  const toast = useToast();
  const [s, setS] = useState<NotifySettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState({ email_enabled: true, reply_to: "", quiet_start: 21, quiet_end: 8, days: "", sms: "500", wa: "500" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function apply(x: NotifySettings) {
    setS(x);
    setForm({ email_enabled: x.email_enabled, reply_to: x.reply_to ?? "", quiet_start: x.quiet_start, quiet_end: x.quiet_end,
      days: x.fee_reminder_days.join(", "), sms: String(x.sms_daily_limit), wa: String(x.whatsapp_daily_limit) });
  }
  useEffect(() => { apiFetch<NotifySettings>("/notifications/admin/settings", { schoolId }).then(apply).catch((e) => setLoadError(errorMessage(e))); }, [schoolId]);

  async function save() {
    setError(null);
    const days = form.days.split(/[\s,]+/).filter(Boolean).map(Number);
    if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 28)) return setError("Reminder days must be numbers from 1 to 28, e.g. 5, 15.");
    if (days.length > 6) return setError("Choose at most 6 reminder days a month.");
    const sms = Number(form.sms), wa = Number(form.wa);
    if (![sms, wa].every((n) => Number.isInteger(n) && n >= 0 && n <= 100000)) return setError("Daily limits must be whole numbers from 0 to 100000.");
    setBusy(true);
    try {
      apply(await apiFetch<NotifySettings>("/notifications/admin/settings", { schoolId, method: "PUT", body: {
        email_enabled: form.email_enabled, reply_to: form.reply_to.trim() || null, quiet_start: form.quiet_start, quiet_end: form.quiet_end,
        fee_reminder_days: days, sms_daily_limit: sms, whatsapp_daily_limit: wa } }));
      toast.success("Settings saved.");
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  if (loadError) return <ErrorState message={loadError} />;
  if (!s) return <LoadingState />;
  return (
    <>
      <Card title="Email" testId="email-card" description="Emails are sent by the ERP's mail server, in the school's name."
        badge={<Status on={s.email_server.configured && form.email_enabled} configured={s.email_server.configured} />}>
        <div className="space-y-4">
          {s.email_server.configured
            ? <p className="text-sm">Sent from <b>{s.email_server.from}</b>. Replies go to the address below, or to the school&apos;s email.</p>
            : <p className="rounded-md bg-pencil-100 px-3 py-2 text-sm" data-testid="email-not-configured">The mail server isn&apos;t set up yet (SMTP settings on the server). Emails are recorded as “not sent” until it is.</p>}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-leaf-600" checked={form.email_enabled} onChange={(e) => setForm({ ...form, email_enabled: e.target.checked })} data-testid="email-enabled" />
            Send emails
          </label>
          <TextField label="Reply-to address" type="email" value={form.reply_to} onChange={(e) => setForm({ ...form, reply_to: e.target.value })} placeholder="office@yourschool.in" data-testid="reply-to" />
        </div>
      </Card>
      <Card title="Sending rules" testId="rules-card" description="Apply to SMS and WhatsApp. Emails and notifications in the app are sent at any time.">
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label="Quiet hours start" value={form.quiet_start} onChange={(e) => setForm({ ...form, quiet_start: Number(e.target.value) })} data-testid="quiet-start">
            {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </SelectField>
          <SelectField label="Quiet hours end" value={form.quiet_end} onChange={(e) => setForm({ ...form, quiet_end: Number(e.target.value) })} data-testid="quiet-end">
            {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </SelectField>
          <p className="-mt-2 text-xs text-muted sm:col-span-2">India time. SMS and WhatsApp messages due in quiet hours wait until they end. Same start and end: no quiet hours.</p>
          <TextField label="SMS per day, at most" inputMode="numeric" value={form.sms} onChange={(e) => setForm({ ...form, sms: e.target.value })} data-testid="sms-limit" />
          <TextField label="WhatsApp messages per day, at most" inputMode="numeric" value={form.wa} onChange={(e) => setForm({ ...form, wa: e.target.value })} data-testid="wa-limit" />
          <TextField className="sm:col-span-2" label="Automatic fee reminders on these days of the month" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })}
            placeholder="e.g. 5, 15" data-testid="reminder-days" hint="Sent after 9 am to parents of students with overdue fees. Leave empty to send reminders only by hand." />
        </div>
        {error && <p className="mt-3 text-sm text-danger-600" role="alert" data-testid="settings-error">{error}</p>}
        <Button className="mt-4" onClick={save} loading={busy} data-testid="save-notify-settings">Save</Button>
      </Card>
    </>
  );
}

function SmsCard({ schoolId, acc, onSaved }: { schoolId: string; acc: ChannelAccount; onSaved: (c: Channels) => void }) {
  const toast = useToast();
  const [f, setF] = useState({ sid: "", token: "", from: "", service: "", enabled: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setF({ sid: acc.config.account_sid ?? "", token: "", from: acc.config.from_number ?? "", service: acc.config.messaging_service_sid ?? "", enabled: acc.enabled });
  }, [acc]);

  async function save() {
    setError(null);
    if (!/^AC[0-9a-fA-F]{32}$/.test(f.sid.trim())) return setError("Enter the Account SID from the Twilio Console (AC followed by 32 characters).");
    if (!acc.configured && !f.token.trim()) return setError("Enter the auth token.");
    if (!f.from.trim() && !f.service.trim()) return setError("Enter the sender number or a messaging service SID.");
    if (f.from.trim() && !/^\+[1-9][0-9]{6,14}$/.test(f.from.trim().replace(/\s/g, ""))) return setError("Enter the sender number with the country code, e.g. +15005550006.");
    setBusy(true);
    try {
      onSaved(await apiFetch<Channels>("/notifications/admin/channels/sms", { schoolId, method: "PUT", body: {
        account_sid: f.sid.trim(), auth_token: f.token.trim() || null, from_number: f.from.trim().replace(/\s/g, "") || null,
        messaging_service_sid: f.service.trim() || null, enabled: f.enabled } }));
      toast.success("SMS settings saved.");
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Card title="SMS (Twilio)" testId="sms-card" badge={<Status on={acc.enabled} configured={acc.configured} />}
      description="Uses the school's own Twilio account; Twilio charges the school per message.">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <TextField label="Account SID" value={f.sid} onChange={(e) => setF({ ...f, sid: e.target.value })} autoComplete="off" placeholder="AC…" data-testid="sms-sid" />
          <TextField label="Auth token" type="password" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} autoComplete="new-password" data-testid="sms-token"
            placeholder={acc.configured ? "Saved — leave empty to keep it" : ""} hint="Stored encrypted; it can't be shown again." />
          <TextField label="Sender number" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} placeholder="+1…" data-testid="sms-from" />
          <TextField label="Messaging service SID (optional)" value={f.service} onChange={(e) => setF({ ...f, service: e.target.value })} placeholder="MG…"
            hint="If set, it's used instead of the sender number (needed for DLT-registered sender IDs in India)." />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-leaf-600" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} data-testid="sms-enabled" />
            Send SMS
          </label>
          {error && <p className="text-sm text-danger-600" role="alert" data-testid="sms-error">{error}</p>}
          <Button onClick={save} loading={busy} data-testid="save-sms">Save</Button>
          {acc.updated_at && <p className="text-xs text-muted">Last changed {formatDateTime(acc.updated_at)}</p>}
        </div>
        <div className="space-y-3 rounded-md bg-paper p-4 text-sm">
          <p className="font-medium">Delivery reports</p>
          <p>Twilio reports whether each SMS was delivered to this address; the ERP adds it to every message it sends, so there is nothing to set up in Twilio.</p>
          <CopyLine label="Status callback URL" value={acc.webhook_url} testId="sms-webhook-url" />
          <p className="text-xs text-muted">In India, bulk SMS must use a DLT-registered sender and templates. Register them with your provider before sending to parents.</p>
        </div>
      </div>
    </Card>
  );
}

function WhatsAppCard({ schoolId, acc, onSaved }: { schoolId: string; acc: ChannelAccount; onSaved: (c: Channels) => void }) {
  const toast = useToast();
  const [f, setF] = useState({ phone: "", token: "", secret: "", enabled: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setF({ phone: acc.config.phone_number_id ?? "", token: "", secret: "", enabled: acc.enabled }); }, [acc]);
  const { hasFeature } = useAuth();
  const inPlan = hasFeature("whatsapp");

  async function save() {
    setError(null);
    if (!/^[0-9]{6,30}$/.test(f.phone.trim())) return setError("Enter the phone number ID from WhatsApp Manager (digits only).");
    if (!acc.configured && !f.token.trim()) return setError("Enter the access token.");
    setBusy(true);
    try {
      onSaved(await apiFetch<Channels>("/notifications/admin/channels/whatsapp", { schoolId, method: "PUT", body: {
        phone_number_id: f.phone.trim(), access_token: f.token.trim() || null, app_secret: f.secret.trim() || null, enabled: f.enabled } }));
      toast.success("WhatsApp settings saved.");
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Card title="WhatsApp (Meta WhatsApp Business)" testId="whatsapp-card" badge={<Status on={acc.enabled} configured={acc.configured} />}
      description="Uses the school's WhatsApp Business account through Meta's Cloud API. Only templates approved by Meta can be sent.">
      {!inPlan && (
        <p className="mb-4 rounded-md bg-pencil-100 px-3 py-2 text-sm" role="status" data-testid="wa-not-in-plan">
          WhatsApp notifications aren&apos;t part of your school&apos;s plan. Messages meant for WhatsApp are skipped (email, SMS and in-app still go out).
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <TextField label="Phone number ID" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} autoComplete="off" data-testid="wa-phone-id" />
          <TextField label="Access token" type="password" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} autoComplete="new-password" data-testid="wa-token"
            placeholder={acc.configured ? "Saved — leave empty to keep it" : ""} hint="A permanent system-user token. Stored encrypted." />
          <TextField label="App secret" type="password" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} autoComplete="new-password" data-testid="wa-secret"
            placeholder={acc.has_app_secret ? "Saved — leave empty to keep it" : ""} hint="Used to check that delivery reports really come from Meta." />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-leaf-600" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} data-testid="wa-enabled" />
            Send WhatsApp messages
          </label>
          {error && <p className="text-sm text-danger-600" role="alert" data-testid="wa-error">{error}</p>}
          <Button onClick={save} loading={busy} disabled={!inPlan} data-testid="save-whatsapp">Save</Button>
          {acc.updated_at && <p className="text-xs text-muted">Last changed {formatDateTime(acc.updated_at)}</p>}
        </div>
        <div className="space-y-3 rounded-md bg-paper p-4 text-sm">
          <p className="font-medium">Delivery reports (webhook)</p>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>In your Meta app, open <b>WhatsApp → Configuration → Webhook</b> and paste the callback URL and verify token below.</li>
            <li>Subscribe to the <code className="rounded bg-white px-1 text-xs">messages</code> field.</li>
            <li>Enter the app&apos;s secret above so reports can be checked.</li>
          </ol>
          <CopyLine label="Callback URL" value={acc.webhook_url} testId="wa-webhook-url" />
          {acc.verify_token && <CopyLine label="Verify token" value={acc.verify_token} testId="wa-verify-token" />}
          <p className="text-xs text-muted">Choose each message&apos;s approved template under Templates → WhatsApp.</p>
        </div>
      </div>
    </Card>
  );
}

function TestCard({ schoolId }: { schoolId: string }) {
  const [channel, setChannel] = useState<Outbound>("email");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<HistoryDetail | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);

  useEffect(() => {
    if (!eventId) return;
    let stop = false; let n = 0;
    const tick = async () => {
      try {
        const d = await apiFetch<HistoryDetail>(`/notifications/admin/history/${eventId}`, { schoolId });
        if (stop) return;
        setResult(d);
        const x = d.deliveries[0];
        if (d.status === "skipped" || d.status === "failed") return;
        // final: failed / not sent / read, delivered, or "sent" for email (mail servers don't report back)
        if (x && (["failed", "skipped", "delivered", "read"].includes(x.status) || (x.status === "sent" && x.channel === "email"))) return;
      } catch { /* try again */ }
      if (++n < 45 && !stop) window.setTimeout(() => void tick(), 1000);
    };
    void tick();
    return () => { stop = true; };
  }, [eventId, schoolId]);

  async function send() {
    setError(null); setResult(null); setEventId(null);
    if (!address.trim()) return setError(channel === "email" ? "Enter an email address." : "Enter a mobile number.");
    setBusy(true);
    try { setEventId((await apiFetch<{ event_id: string }>("/notifications/admin/test", { schoolId, method: "POST", body: { channel, address: address.trim() } })).event_id); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  const d = result?.deliveries[0];
  return (
    <Card title="Send a test message" testId="test-card" description="Checks a channel end to end. Sent at once, even in quiet hours, and shown in the history.">
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
        <SelectField label="Channel" value={channel} onChange={(e) => setChannel(e.target.value as Outbound)} data-testid="test-channel">
          {(["email", "sms", "whatsapp"] as Outbound[]).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
        </SelectField>
        <TextField label={channel === "email" ? "Email address" : "Mobile number"} value={address} onChange={(e) => setAddress(e.target.value)}
          placeholder={channel === "email" ? "you@example.com" : "+91 98765 43210"} data-testid="test-address" />
        <Button onClick={send} loading={busy} data-testid="send-test"><Send className="size-4" /> Send</Button>
      </div>
      {channel === "whatsapp" && <p className="mt-2 text-xs text-muted">Uses Meta&apos;s standard “hello_world” template, available on every WhatsApp Business account.</p>}
      {error && <p className="mt-3 text-sm text-danger-600" role="alert" data-testid="test-error">{error}</p>}
      {eventId && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm" data-testid="test-result" aria-live="polite">
          {d ? <><DeliveryPill status={d.status} />{d.error && <span className="text-muted" data-testid="test-result-error">{d.error}</span>}</>
            : result?.status === "skipped" ? <span className="text-muted">{result.error}</span>
            : <span className="text-muted">Sending…</span>}
        </div>
      )}
    </Card>
  );
}

export function ChannelsTab({ schoolId }: { schoolId: string }) {
  const [ch, setCh] = useState<Channels | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { apiFetch<Channels>("/notifications/admin/channels", { schoolId }).then(setCh).catch((e) => setError(errorMessage(e))); }, [schoolId]);
  return (
    <div className="space-y-6">
      <SettingsCard schoolId={schoolId} />
      {error ? <ErrorState message={error} /> : !ch ? <LoadingState /> : (
        <>
          <SmsCard schoolId={schoolId} acc={ch.sms} onSaved={setCh} />
          <WhatsAppCard schoolId={schoolId} acc={ch.whatsapp} onSaved={setCh} />
        </>
      )}
      <TestCard schoolId={schoolId} />
      <p className="text-xs text-muted">This system sends written messages only: no phone calls or voice messages are made.</p>
    </div>
  );
}
