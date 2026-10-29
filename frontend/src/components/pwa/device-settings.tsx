"use client";

import { BellOff, BellRing, Download, Smartphone, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { currentSubscription, disablePush, enablePush, fingerprint, pushState, type PushConfig, type PushState } from "@/lib/push-client";
import { usePwa } from "@/providers/pwa-provider";

interface Device {
  id: string; fingerprint: string; device_label: string | null; show_preview: boolean;
  created_at: string; last_seen_at: string; last_success_at: string | null; failing: boolean;
}

const STATE_TEXT: Record<PushState, string> = {
  on: "On. School notifications appear on this device even when the app is closed.",
  off: "Off on this device. You still see everything under the bell in the app.",
  blocked: "Blocked for this site. To allow them, open the browser's site settings (the icon next to the address) and allow notifications, then come back here.",
  unsupported: "This browser can't show notifications. Use Chrome, Edge, Firefox or Samsung Internet, or the installed app.",
  "ios-needs-install": "On iPhone and iPad, notifications work in the installed app: add this site to your Home Screen (Share → Add to Home Screen), open it from there, then turn them on.",
  "server-off": "Notifications to devices aren't set up on this server yet. Ask the school's administrator.",
};

/** My profile → This device: install, notifications on/off, lock-screen privacy, a test, and other devices. */
export function DeviceSettings() {
  const toast = useToast();
  const { installed, canPrompt, iosInstall, promptInstall } = usePwa();
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [state, setState] = useState<PushState | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [mine, setMine] = useState<string | null>(null); // this device's fingerprint
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    let cfg: PushConfig | null = null;
    try { cfg = await apiFetch<PushConfig>("/push/config"); } catch { /* offline */ }
    setConfig(cfg);
    setState(await pushState(cfg));
    const sub = await currentSubscription().catch(() => null);
    setMine(sub ? await fingerprint(sub.endpoint) : null);
    try { setDevices(await apiFetch<Device[]>("/push/subscriptions")); } catch { setDevices([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const here = devices.find((d) => d.fingerprint === mine) ?? null;
  const others = devices.filter((d) => d.fingerprint !== mine);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try { await fn(); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); await load(); }
  }

  if (!state) return <p className="text-sm text-muted">Checking this device…</p>;
  return (
    <div className="space-y-5 text-sm">
      <div className="flex items-start gap-3">
        <Smartphone className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
        <div className="flex-1">
          <p className="font-medium">App</p>
          <p className="text-muted" data-testid="install-state">
            {installed ? "Installed — you're using the app." : canPrompt ? "Not installed. Install it for a home-screen icon and a full-screen app."
              : iosInstall ? "Not installed. In Safari: Share → Add to Home Screen." : "Open this site in Chrome, Edge or Safari on your phone to install it."}
          </p>
          {!installed && canPrompt && (
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => void promptInstall()}><Download className="size-4" /> Install app</Button>
          )}
        </div>
      </div>
      <div className="flex items-start gap-3">
        {state === "on" ? <BellRing className="mt-0.5 size-5 shrink-0 text-leaf-700" aria-hidden /> : <BellOff className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />}
        <div className="flex-1">
          <p className="font-medium">Notifications on this device</p>
          <p className="text-muted" data-testid="push-state" data-state={state}>{STATE_TEXT[state]}</p>
          {state === "off" && config?.enabled && (
            <Button size="sm" className="mt-2" loading={busy === "on"} data-testid="push-on"
              onClick={() => run("on", async () => {
                const s = await enablePush(config);
                if (s === "on") toast.success("Notifications are on for this device.");
              })}>Turn on</Button>
          )}
          {state === "on" && (
            <div className="mt-2 space-y-3">
              {here && (
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-0.5 size-4 accent-leaf-600" checked={!here.show_preview} data-testid="push-hide-details"
                    disabled={busy === "preview"}
                    onChange={(e) => {
                      const hide = e.target.checked; // shown at once; put back if saving fails
                      setDevices((ds) => ds.map((d) => (d.id === here.id ? { ...d, show_preview: !hide } : d)));
                      void run("preview", async () => {
                        await apiFetch(`/push/subscriptions/${here.id}`, { method: "PATCH", body: { show_preview: !hide } });
                      });
                    }} />
                  <span>Hide details on the lock screen<span className="block text-xs text-muted">Shows only “new notification from your school” — useful on a shared or family phone.</span></span>
                </label>
              )}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" loading={busy === "test"} data-testid="push-test"
                  onClick={() => run("test", async () => {
                    const sub = await currentSubscription();
                    const r = await apiFetch<{ sent: number }>("/push/test", { method: "POST", body: { endpoint: sub?.endpoint ?? null } });
                    if (r.sent) toast.success("Test sent. It should appear in a moment.");
                    else toast.error("The test couldn't be delivered. Turn notifications off and on again.");
                  })}>Send a test</Button>
                <Button size="sm" variant="ghost" loading={busy === "off"} data-testid="push-off"
                  onClick={() => run("off", async () => { await disablePush(); toast.success("Notifications are off for this device."); })}>Turn off</Button>
              </div>
            </div>
          )}
        </div>
      </div>
      {others.length > 0 && (
        <div>
          <p className="font-medium">Your other devices with notifications</p>
          <ul className="mt-2 divide-y divide-line rounded-md border border-line" data-testid="other-devices">
            {others.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{d.device_label ?? "A device"}</span>
                  <span className="block text-xs text-muted">Last used {formatDateTime(d.last_seen_at)}{d.failing ? " · not reachable lately" : ""}</span>
                </span>
                <Button size="sm" variant="ghost" aria-label={`Stop notifications on ${d.device_label ?? "this device"}`} loading={busy === d.id}
                  onClick={() => run(d.id, async () => { await apiFetch(`/push/subscriptions/${d.id}`, { method: "DELETE" }); })}><Trash2 className="size-4" /></Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
