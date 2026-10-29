"use client";

import { Copy, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { config } from "@/lib/config";
import { formatDateTime } from "@/lib/format";

interface GatewaySettings {
  provider: "razorpay"; configured: boolean; key_id: string | null; enabled: boolean; mode: "test" | "live" | null;
  has_webhook_secret: boolean; updated_at: string | null; webhook_path: string; webhook_events: string[];
}

export function GatewaySettingsCard({ schoolId }: { schoolId: string }) {
  const toast = useToast();
  const [s, setS] = useState<GatewaySettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [hookSecret, setHookSecret] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function apply(x: GatewaySettings) { setS(x); setKeyId(x.key_id ?? ""); setEnabled(x.enabled); setKeySecret(""); setHookSecret(""); }
  useEffect(() => { apiFetch<GatewaySettings>("/payments/settings", { schoolId }).then(apply).catch((e) => setLoadError(errorMessage(e))); }, [schoolId]);

  async function save() {
    setError(null);
    if (!/^rzp_(test|live)_[A-Za-z0-9]{6,40}$/.test(keyId.trim())) return setError("Enter the Razorpay key id (it starts with rzp_test_ or rzp_live_).");
    if (!s?.configured && !keySecret.trim()) return setError("Enter the key secret.");
    if (enabled && !s?.has_webhook_secret && !hookSecret.trim()) return setError("Enter the webhook secret before turning online payments on.");
    setBusy(true);
    try {
      apply(await apiFetch<GatewaySettings>("/payments/settings", { schoolId, method: "PUT",
        body: { key_id: keyId.trim(), key_secret: keySecret.trim() || null, webhook_secret: hookSecret.trim() || null, enabled } }));
      toast.success("Online payment settings saved.");
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  if (loadError) return <ErrorState message={loadError} />;
  if (!s) return <LoadingState />;
  const webhookUrl = `${config.apiUrl}${s.webhook_path}`;
  return (
    <section className="rounded-lg border border-line bg-white" data-testid="gateway-settings">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line p-5">
        <div>
          <h2 className="font-semibold">Online payments (Razorpay)</h2>
          <p className="text-sm text-muted">Parents pay fees from the parent portal by UPI, card or net banking. Money goes to the school&apos;s own Razorpay account.</p>
        </div>
        {s.configured && (
          <span className={s.mode === "live" ? "rounded-full bg-leaf-600 px-2.5 py-0.5 text-xs font-medium text-white" : "rounded-full bg-pencil-100 px-2.5 py-0.5 text-xs font-medium"}
            data-testid="gateway-mode">{s.mode === "live" ? "Live" : "Test mode"} · {s.enabled ? "On" : "Off"}</span>
        )}
      </div>
      <div className="grid gap-6 p-5 lg:grid-cols-2">
        <div className="space-y-4">
          <TextField label="Key id" value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="rzp_live_…" autoComplete="off" />
          <TextField label="Key secret" type="password" value={keySecret} onChange={(e) => setKeySecret(e.target.value)} autoComplete="new-password"
            placeholder={s.configured ? "Saved — leave empty to keep it" : ""} hint="Checked with Razorpay when you save. Stored encrypted; it can't be shown again." />
          <TextField label="Webhook secret" type="password" value={hookSecret} onChange={(e) => setHookSecret(e.target.value)} autoComplete="new-password"
            placeholder={s.has_webhook_secret ? "Saved — leave empty to keep it" : ""} hint="The secret you enter when adding the webhook in Razorpay." />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-leaf-600" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} data-testid="gateway-enabled" />
            Let parents pay online
          </label>
          {error && <p className="text-sm text-danger-600" role="alert" data-testid="gateway-error">{error}</p>}
          <Button onClick={save} loading={busy} data-testid="save-gateway">Save</Button>
          {s.updated_at && <p className="text-xs text-muted">Last changed {formatDateTime(s.updated_at)}</p>}
        </div>
        <div className="space-y-3 rounded-md bg-paper p-4 text-sm">
          <p className="flex items-center gap-1.5 font-medium"><ShieldCheck className="size-4 text-leaf-700" /> Setting up Razorpay</p>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>In the Razorpay Dashboard, open <b>Account &amp; Settings → API Keys</b> and generate a key. Copy the key id and secret here. Use test keys first.</li>
            <li>Open <b>Webhooks → Add new webhook</b>, paste this URL, choose a secret and enter it above:
              <span className="mt-1 flex items-center gap-2"><code className="break-all rounded bg-white px-2 py-1 text-xs" data-testid="webhook-url">{webhookUrl}</code>
                <Button size="sm" variant="ghost" aria-label="Copy webhook URL" onClick={() => { void navigator.clipboard?.writeText(webhookUrl).then(() => toast.success("Copied.")); }}><Copy className="size-4" /></Button></span>
            </li>
            <li>Select these events:
              <span className="mt-1 flex flex-wrap gap-1">{s.webhook_events.map((e) => <code key={e} className="rounded bg-white px-1 text-xs">{e}</code>)}</span></li>
            <li>Turn on <b>Let parents pay online</b> and save. Try a test payment from the parent portal.</li>
          </ol>
          <p className="text-xs text-muted">A payment counts only after the server has confirmed it with Razorpay; what the parent&apos;s browser says is never enough on its own.</p>
        </div>
      </div>
    </section>
  );
}
