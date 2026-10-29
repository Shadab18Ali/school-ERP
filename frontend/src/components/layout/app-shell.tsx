"use client";

import { Lock } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { APP_NAME, isStandalone } from "@/lib/pwa";
import { useAuth } from "@/providers/auth-provider";
import { BottomNav } from "./bottom-nav";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

/** In the installed app, the first load continues the system splash screen instead of a blank page. */
function LaunchScreen() {
  return (
    <div className="fixed inset-0 grid place-items-center bg-board-900" data-testid="launch-screen" role="status" aria-label="Loading">
      <div className="flex flex-col items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icons/icon-192.png" alt="" width={96} height={96} className="size-24 rounded-[22%]" />
        <p className="text-lg font-semibold text-white">{APP_NAME}</p>
        <span className="mt-2 size-5 animate-spin rounded-full border-2 border-white/30 border-t-pencil-400" aria-hidden />
      </div>
    </div>
  );
}

/** The school's subscription has ended: say so on every page, and where to fix it. */
function ReadOnlyBanner() {
  const { currentSchool, readOnly, can } = useAuth();
  if (!readOnly || !currentSchool) return null;
  return (
    <div className="mb-6 flex flex-wrap items-start gap-3 rounded-lg border border-danger-600/30 bg-danger-50 px-4 py-3 text-sm" role="status" data-testid="read-only-banner">
      <Lock className="mt-0.5 size-4 shrink-0 text-danger-600" aria-hidden />
      <p className="flex-1">
        <span className="font-medium">{currentSchool.school_name}&apos;s subscription has ended.</span>{" "}
        Records can be viewed and downloaded, but nothing can be added or changed until it is renewed.
      </p>
      {can("settings:manage")
        ? <Link href="/settings" className="font-medium text-danger-600 underline underline-offset-2">Plan and billing</Link>
        : <span className="text-muted">Your school administrator can renew it.</span>}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const { me, loading, error, refresh } = useAuth();
  useEffect(() => setStandalone(isStandalone()), []);
  useEffect(() => {
    if (!menuOpen) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [menuOpen]);

  if (loading && !me) return standalone ? <LaunchScreen /> : <div className="min-h-screen"><LoadingState label="Loading your account…" /></div>;
  if (error && !me) return <div className="min-h-screen"><ErrorState message={error} onRetry={refresh} /></div>;

  return (
    <div className="min-h-screen lg:pl-64 print:pl-0">
      <aside className="fixed inset-y-0 left-0 hidden w-64 lg:block print:hidden"><Sidebar /></aside>
      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" data-testid="menu-drawer">
          <div className="absolute inset-0 bg-board-950/50" onClick={() => setMenuOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-xl"><Sidebar onNavigate={() => setMenuOpen(false)} /></aside>
        </div>
      )}
      <div className="print:hidden"><Topbar onMenu={() => setMenuOpen(true)} /></div>
      {/* room at the bottom for the phone's tab bar (and the home indicator) */}
      <main className="mx-auto max-w-7xl px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 lg:py-8 print:max-w-none print:p-0"><ReadOnlyBanner />{children}</main>
      <BottomNav onMore={() => setMenuOpen(true)} />
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
