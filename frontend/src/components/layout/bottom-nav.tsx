"use client";

import { clsx } from "clsx";
import {
  Bell, BookOpen, CalendarCheck, CalendarClock, ClipboardCheck, GraduationCap, HeartHandshake, Home, LibraryBig, Megaphone,
  Menu, NotebookPen, ReceiptIndianRupee, Users, Wallet, type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import type { Permission, Role } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

interface Tab { href: string; label: string; icon: LucideIcon; permission?: Permission }
export type Persona = "admin" | "accountant" | "teacher" | "librarian" | "parent" | "student" | "platform";

/** The person's main job in the current school decides the bottom bar (the full menu is under "More"). */
export function personaFor(roles: readonly Role[], isSuperAdmin: boolean): Persona {
  if (roles.includes("school_admin")) return "admin";
  if (roles.includes("accountant")) return "accountant";
  if (roles.includes("teacher")) return "teacher";
  if (roles.includes("librarian")) return "librarian";
  if (roles.includes("parent")) return "parent";
  if (roles.includes("student")) return "student";
  return isSuperAdmin ? "platform" : "parent";
}

const HOME: Tab = { href: "/dashboard", label: "Home", icon: Home };
// Four tabs each, chosen for what that person opens most on a phone.
export const TABS: Record<Persona, Tab[]> = {
  parent: [
    HOME,
    { href: "/portal", label: "Children", icon: HeartHandshake, permission: "portal:view" },
    { href: "/notices", label: "Notices", icon: Megaphone, permission: "notices:view" },
    { href: "/notifications", label: "Alerts", icon: Bell },
  ],
  student: [
    HOME,
    { href: "/my?tab=Homework", label: "Homework", icon: NotebookPen, permission: "self:view" },
    { href: "/my?tab=Timetable", label: "Timetable", icon: CalendarClock, permission: "self:view" },
    { href: "/my?tab=Results", label: "Results", icon: GraduationCap, permission: "self:view" },
  ],
  teacher: [
    HOME,
    { href: "/teaching", label: "My classes", icon: ClipboardCheck, permission: "teaching:view" },
    { href: "/teaching/timetable", label: "Timetable", icon: CalendarClock, permission: "teaching:view" },
    { href: "/homework", label: "Homework", icon: NotebookPen, permission: "homework:view" },
  ],
  admin: [
    HOME,
    { href: "/students", label: "Students", icon: Users, permission: "students:view" },
    { href: "/fees/collect", label: "Collect", icon: Wallet, permission: "fees:collect" },
    { href: "/attendance", label: "Attendance", icon: CalendarCheck, permission: "attendance:view" },
  ],
  accountant: [
    HOME,
    { href: "/fees/collect", label: "Collect", icon: Wallet, permission: "fees:collect" },
    { href: "/fees/payments", label: "Payments", icon: ReceiptIndianRupee, permission: "fees:collect" },
    { href: "/students", label: "Students", icon: Users, permission: "students:view" },
  ],
  librarian: [
    HOME,
    { href: "/library", label: "Library", icon: LibraryBig, permission: "library:view" },
    { href: "/notices", label: "Notices", icon: Megaphone, permission: "notices:view" },
    { href: "/notifications", label: "Alerts", icon: Bell },
  ],
  platform: [HOME, { href: "/admin/schools", label: "Schools", icon: BookOpen, permission: "platform:schools.manage" }],
};

function isActive(href: string, pathname: string, tab: string | null): boolean {
  const [path, query] = href.split("?");
  if (query) return pathname === path && tab === new URLSearchParams(query).get("tab");
  if (path === "/dashboard") return pathname === "/dashboard";
  return pathname === path || pathname.startsWith(`${path}/`);
}

function Bar({ onMore }: { onMore: () => void }) {
  const pathname = usePathname();
  const tab = useSearchParams().get("tab");
  const { can, me, currentSchool } = useAuth();
  const persona = personaFor(currentSchool?.roles ?? [], !!me?.is_super_admin);
  const tabs = TABS[persona].filter((t) => !t.permission || can(t.permission));
  // the most specific match wins (e.g. /teaching/timetable, not also /teaching)
  const active = tabs.filter((t) => isActive(t.href, pathname, tab)).sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <nav aria-label="Quick links" data-testid="bottom-nav" data-persona={persona}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden print:hidden">
      <ul className="mx-auto flex max-w-xl">
        {tabs.map(({ href, label, icon: Icon }) => {
          const on = href === active;
          return (
            <li key={href} className="flex-1">
              <Link href={href} aria-current={on ? "page" : undefined} data-testid={`tab-${label.toLowerCase().replace(/\s+/g, "-")}`}
                className={clsx("flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[0.7rem] font-medium",
                  on ? "text-leaf-700" : "text-muted active:text-ink")}>
                <span className={clsx("grid h-7 w-12 place-items-center rounded-full", on && "bg-leaf-50")}><Icon className="size-5" aria-hidden /></span>
                {label}
              </Link>
            </li>
          );
        })}
        <li className="flex-1">
          <button onClick={onMore} data-testid="tab-more" className="flex min-h-14 w-full flex-col items-center justify-center gap-0.5 px-1 text-[0.7rem] font-medium text-muted active:text-ink">
            <span className="grid h-7 w-12 place-items-center rounded-full"><Menu className="size-5" aria-hidden /></span>
            More
          </button>
        </li>
      </ul>
    </nav>
  );
}

/** Phone and tablet only: a thumb-reach bar with the person's most-used pages, plus the full menu. */
export function BottomNav({ onMore }: { onMore: () => void }) {
  return <Suspense fallback={null}><Bar onMore={onMore} /></Suspense>;
}
