"use client";

import { RefreshCw, WifiOff } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isIos, isStandalone } from "@/lib/pwa";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface PwaContextValue {
  /** The browser offers its own install dialog (Android/desktop Chromium). */
  canPrompt: boolean;
  /** Already running as the installed app. */
  installed: boolean;
  /** iPhone/iPad in Safari: installing is "Share → Add to Home Screen". */
  iosInstall: boolean;
  online: boolean;
  promptInstall: () => Promise<"accepted" | "dismissed" | "unavailable">;
}

const PwaContext = createContext<PwaContextValue | null>(null);
const UPDATE_KEY = "erp.sw-update";

/** Service worker registration, the "new version" prompt, the offline banner and the install prompt. */
export function PwaProvider({ children }: { children: ReactNode }) {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [iosInstall, setIosInstall] = useState(false);
  const [online, setOnline] = useState(true);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    setInstalled(isStandalone());
    setIosInstall(isIos() && !isStandalone());
    setOnline(navigator.onLine);
    const onPrompt = (e: Event) => { e.preventDefault(); setDeferred(e as BeforeInstallPromptEvent); };
    const onInstalled = () => { setDeferred(null); setInstalled(true); };
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  useEffect(() => {
    // `next dev` rebuilds constantly; caching would only get in the way there
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    let timer: number | undefined;
    // reload only when the person chose "Reload" on the update banner — never on a first visit,
    // when the worker simply starts looking after the page (that would wipe a half-filled form)
    const onController = () => {
      if (sessionStorage.getItem(UPDATE_KEY) === "1") { sessionStorage.removeItem(UPDATE_KEY); window.location.reload(); }
    };
    navigator.serviceWorker.addEventListener("controllerchange", onController);
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      const track = (sw: ServiceWorker | null) => {
        if (!sw) return;
        const check = () => { if (sw.state === "installed" && navigator.serviceWorker.controller) setWaiting(sw); };
        check();
        sw.addEventListener("statechange", check);
      };
      track(reg.waiting);
      reg.addEventListener("updatefound", () => track(reg.installing));
      // installed apps can stay open for days: look for a new version now and then
      timer = window.setInterval(() => void reg.update().catch(() => undefined), 60 * 60 * 1000);
    }).catch(() => undefined);
    return () => { window.clearInterval(timer); navigator.serviceWorker.removeEventListener("controllerchange", onController); };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferred) return "unavailable" as const;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    setDeferred(null);
    return outcome;
  }, [deferred]);

  const value = useMemo(() => ({ canPrompt: !!deferred, installed, iosInstall, online, promptInstall }),
    [deferred, installed, iosInstall, online, promptInstall]);

  return (
    <PwaContext.Provider value={value}>
      {!online && (
        <div role="status" data-testid="offline-banner"
          className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-2 bg-ink px-4 pb-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] text-center text-sm text-white print:hidden">
          <WifiOff className="size-4 shrink-0" aria-hidden />
          You&apos;re offline. What&apos;s on screen stays; changes can&apos;t be saved until you reconnect.
        </div>
      )}
      {children}
      {waiting && (
        <div role="status" data-testid="update-banner"
          className="fixed inset-x-3 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-[60] mx-auto flex max-w-md items-center gap-3 rounded-lg bg-board-900 px-4 py-3 text-sm text-white shadow-lg lg:bottom-6 print:hidden">
          <RefreshCw className="size-4 shrink-0" aria-hidden />
          <span className="flex-1">A new version of the app is ready.</span>
          <button onClick={() => { sessionStorage.setItem(UPDATE_KEY, "1"); waiting.postMessage({ type: "SKIP_WAITING" }); }}
            className="min-h-11 rounded-md bg-pencil-400 px-3 font-semibold text-board-950">Reload</button>
        </div>
      )}
    </PwaContext.Provider>
  );
}

export function usePwa(): PwaContextValue {
  const ctx = useContext(PwaContext);
  if (!ctx) throw new Error("usePwa must be used inside PwaProvider");
  return ctx;
}
