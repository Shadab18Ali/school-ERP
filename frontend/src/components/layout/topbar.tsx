"use client";

import { ChevronDown, LogOut, Menu, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { NotificationBell } from "@/components/notifications/bell";
import { useAuth } from "@/providers/auth-provider";

function UserMenu() {
  const { me, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  const initials = (me?.full_name || me?.email || "?").split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="user-menu"
        className="flex items-center gap-2 rounded-md p-1 pr-2 hover:bg-ink/5"
      >
        <span className="grid size-9 place-items-center rounded-full bg-leaf-50 text-sm font-semibold text-leaf-700" aria-hidden>{initials}</span>
        <span className="hidden text-left sm:block">
          <span className="block text-sm font-medium leading-tight">{me?.full_name || me?.email}</span>
          <span className="block text-xs text-muted">{me?.is_super_admin ? "Platform admin" : me?.email}</span>
        </span>
        <ChevronDown className="size-4 text-muted" aria-hidden />
        <span className="sr-only">Account menu</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-40 mt-1 w-56 overflow-hidden rounded-md border border-line bg-white py-1 shadow-lg">
          <div className="border-b border-line px-3 py-2 sm:hidden">
            <p className="truncate text-sm font-medium">{me?.full_name}</p>
            <p className="truncate text-xs text-muted">{me?.email}</p>
          </div>
          <Link role="menuitem" href="/profile" onClick={() => setOpen(false)} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-paper">
            <UserRound className="size-4" aria-hidden /> My profile
          </Link>
          <button
            role="menuitem"
            data-testid="sign-out"
            disabled={busy}
            onClick={async () => { setBusy(true); await signOut(); }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-paper disabled:text-muted"
          >
            <LogOut className="size-4" aria-hidden /> {busy ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { me, activeSchools, currentSchool, setCurrentSchoolId } = useAuth();

  return (
    <header className="sticky top-0 z-30 flex h-[calc(4rem+env(safe-area-inset-top))] items-center gap-3 border-b border-line bg-white/95 px-4 pt-[env(safe-area-inset-top)] backdrop-blur sm:px-6">
      <button onClick={onMenu} className="grid size-11 place-items-center rounded-md text-muted hover:bg-ink/5 lg:hidden" aria-label="Open menu">
        <Menu className="size-5" />
      </button>

      {activeSchools.length > 1 ? (
        <label className="flex min-w-0 items-center gap-2 text-sm">
          <span className="sr-only">Current school</span>
          <select
            value={currentSchool?.school_id ?? ""}
            onChange={(e) => setCurrentSchoolId(e.target.value)}
            className="h-9 max-w-[16rem] truncate rounded-md border border-line bg-white px-2 text-sm"
          >
            {activeSchools.map((m) => (
              <option key={m.school_id} value={m.school_id}>{m.school_name}</option>
            ))}
          </select>
        </label>
      ) : currentSchool ? (
        <p className="truncate text-sm font-medium" data-testid="current-school">{currentSchool.school_name}</p>
      ) : me?.is_super_admin ? (
        <p className="text-sm font-medium">Platform administration</p>
      ) : null}

      {currentSchool && (
        <span
          className="hidden shrink-0 rounded-full border border-line px-2.5 py-1 text-xs font-medium text-muted sm:inline"
          data-testid="header-session"
          title="Current academic session"
        >
          {currentSchool.current_session ? `Session ${currentSchool.current_session.name}` : "No current session"}
        </span>
      )}

      <div className="ml-auto flex items-center gap-1"><NotificationBell /><UserMenu /></div>
    </header>
  );
}
