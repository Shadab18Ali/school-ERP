"use client";

import { BellRing, Download, Share, SquarePlus, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { personaFor, type Persona } from "@/components/layout/bottom-nav";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { APP_NAME } from "@/lib/pwa";
import { enablePush, pushState, type PushConfig, type PushState } from "@/lib/push-client";
import { useAuth } from "@/providers/auth-provider";
import { usePwa } from "@/providers/pwa-provider";

const DISMISS_DAYS = 30;
const KEY = { install: "erp.dismiss.install", push: "erp.dismiss.push" } as const;

// Why it's worth installing — in each person's own terms.
const INSTALL_PITCH: Record<Persona, string> = {
  parent: "Your child's attendance, fees, homework and school notices, one tap away — and a notification the moment something new comes in.",
  student: "Homework, timetable and results one tap away, and a reminder when new homework is set.",
  teacher: "Your classes, attendance, timetable and homework from your phone, with alerts for notices and leave decisions.",
  admin: "Students, fee collection, attendance and the day's numbers from your phone — opens straight to the dashboard.",
  accountant: "Collect fees, find receipts and check dues from your phone — opens straight to the dashboard.",
  librarian: "Issue and return books and check overdue loans from your phone.",
  platform: "Open the platform's school administration from your home screen.",
};
const PUSH_PITCH: Record<Persona, string> = {
  parent: "Know straight away about fee receipts, absences, results and notices — even when the app is closed.",
  student: "Get a reminder for new homework, results and school notices.",
  teacher: "Hear about notices and your leave decisions as they happen.",
  admin: "Hear about new admissions, payments and leave requests as they happen.",
  accountant: "Hear about payments and refunds as they happen.",
  librarian: "Hear about overdue books and notices as they happen.",
  platform: "Hear about platform events as they happen.",
};

function dismissed(key: string): boolean {
  try {
    const at = Number(localStorage.getItem(key) || 0);
    return Date.now() - at < DISMISS_DAYS * 86_400_000;
  } catch { return false; }
}
function dismiss(key: string) {
  try { localStorage.setItem(key, String(Date.now())); } catch { /* private mode */ }
}

function Shell({ icon: Icon, title, children, onClose, testId }: {
  icon: typeof Download; title: string; children: React.ReactNode; onClose: () => void; testId: string;
}) {
  return (
    <section className="relative mb-6 flex gap-4 rounded-lg border border-leaf-600/30 bg-leaf-50 p-4 pr-12 sm:p-5 sm:pr-12" data-testid={testId}>
      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-board-900 text-pencil-400"><Icon className="size-5" aria-hidden /></span>
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold">{title}</h2>
        {children}
      </div>
      <button onClick={onClose} aria-label="Not now" data-testid={`${testId}-dismiss`}
        className="absolute right-2 top-2 grid size-10 place-items-center rounded-md text-muted hover:bg-white/60"><X className="size-4" /></button>
    </section>
  );
}

/**
 * Dashboard card: first "Install the app" (where the browser allows it, or the iPhone steps), then — once
 * it can work — "Turn on notifications". Each can be put off for 30 days; nothing is ever asked without a tap.
 */
export function GetTheApp() {
  const { canPrompt, installed, iosInstall, promptInstall } = usePwa();
  const { me, currentSchool } = useAuth();
  const toast = useToast();
  const persona = personaFor(currentSchool?.roles ?? [], !!me?.is_super_admin);
  const [hidden, setHidden] = useState({ install: true, push: true });
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [push, setPush] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [iosSteps, setIosSteps] = useState(false);

  const refresh = useCallback(async () => {
    let cfg: PushConfig | null = null;
    try { cfg = await apiFetch<PushConfig>("/push/config"); } catch { /* offline */ }
    setConfig(cfg);
    setPush(await pushState(cfg));
  }, []);
  useEffect(() => { setHidden({ install: dismissed(KEY.install), push: dismissed(KEY.push) }); void refresh(); }, [refresh]);

  const showInstall = !installed && !hidden.install && (canPrompt || iosInstall);
  const showPush = !showInstall && !hidden.push && push === "off" && !!config?.enabled;

  if (showInstall) {
    return (
      <Shell icon={Download} title={`Get the ${APP_NAME} app`} testId="install-card"
        onClose={() => { dismiss(KEY.install); setHidden((h) => ({ ...h, install: true })); }}>
        <p className="mt-0.5 text-sm text-muted">{INSTALL_PITCH[persona]} No app store needed, and it takes almost no space.</p>
        {iosInstall ? (
          iosSteps ? (
            <ol className="mt-3 space-y-2 text-sm" data-testid="ios-steps">
              {[
                <>Tap <Share className="mx-0.5 inline size-4 align-[-3px]" aria-label="Share" /> <strong>Share</strong> in Safari&apos;s toolbar.</>,
                <>Choose <SquarePlus className="mx-0.5 inline size-4 align-[-3px]" aria-hidden /> <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</>,
                <>Open it from your Home Screen to turn on notifications.</>,
              ].map((text, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-white text-xs font-semibold">{i + 1}</span>
                  <span className="pt-0.5">{text}</span>
                </li>
              ))}
            </ol>
          ) : <Button size="sm" className="mt-3" onClick={() => setIosSteps(true)} data-testid="ios-how">Show me how</Button>
        ) : (
          <Button size="sm" className="mt-3" data-testid="install-app" onClick={async () => {
            const outcome = await promptInstall();
            if (outcome === "accepted") toast.success("Installed. Find it on your home screen.");
          }}><Download className="size-4" /> Install app</Button>
        )}
      </Shell>
    );
  }
  if (showPush) {
    return (
      <Shell icon={BellRing} title="Turn on notifications on this device" testId="push-card"
        onClose={() => { dismiss(KEY.push); setHidden((h) => ({ ...h, push: true })); }}>
        <p className="mt-0.5 text-sm text-muted">{PUSH_PITCH[persona]} You can turn them off any time in My profile.</p>
        <Button size="sm" className="mt-3" loading={busy} data-testid="push-enable" onClick={async () => {
          setBusy(true);
          try {
            const s = await enablePush(config!);
            setPush(s);
            if (s === "on") toast.success("Notifications are on for this device.");
            else if (s === "blocked") toast.error("Notifications are blocked for this site. Allow them in the browser's site settings.");
          } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
        }}><BellRing className="size-4" /> Turn on</Button>
      </Shell>
    );
  }
  return null;
}
