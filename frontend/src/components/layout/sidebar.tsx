"use client";

import { clsx } from "clsx";
import {
  Bell,
  LibraryBig,
  Bus,
  Boxes,
  CalendarOff,
  CalendarX2,
  UserCheck,
  Banknote,
  MessagesSquare,
  CreditCard,
  UserPlus,
  ClipboardList,
  Award,
  FileBadge,
  BarChart3,
  BookOpen,
  Building2,
  CalendarCheck,
  ChartColumn,
  ChartLine,
  ChartNoAxesCombined,
  CalendarRange,
  CalendarClock,
  Clock3,
  FileCheck2,
  NotebookPen,
  IndianRupee,
  ReceiptIndianRupee,
  Wallet,
  LayoutDashboard,
  Megaphone,
  HeartHandshake,
  IdCard,
  GraduationCap,
  Presentation,
  Settings,
  UserRound,
  Users,
  type LucideIcon,
  Landmark,
  ReceiptText,
  ScrollText,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Permission, PlanFeatureKey } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

/** `permission` omitted = visible to every signed-in user. */
interface NavItem { href: string; label: string; icon: LucideIcon; permission?: Permission; feature?: PlanFeatureKey }

// New modules register here as each phase ships.
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Overview",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/portal", label: "My children", icon: HeartHandshake, permission: "portal:view" },
      { href: "/my", label: "My school record", icon: IdCard, permission: "self:view" },
      { href: "/teaching", label: "My classes", icon: Presentation, permission: "teaching:view" },
      { href: "/teaching/timetable", label: "My timetable", icon: CalendarClock, permission: "teaching:view" },
      { href: "/leave", label: "My leave", icon: CalendarOff, permission: "leave:self" },
      { href: "/notices", label: "Notices", icon: Megaphone, permission: "notices:view" },
      { href: "/notifications", label: "Notifications", icon: Bell },
    ],
  },
  {
    group: "School",
    items: [
      { href: "/students", label: "Students", icon: Users, permission: "students:view" },
      { href: "/enquiries", label: "Enquiries", icon: ClipboardList, permission: "enquiries:view" },
      { href: "/admissions", label: "Admissions", icon: UserPlus, permission: "admissions:view" },
      { href: "/classes", label: "Classes & sections", icon: BookOpen, permission: "classes:view" },
      { href: "/teachers", label: "Teachers", icon: GraduationCap, permission: "teachers:view" },
      { href: "/fees", label: "Fees", icon: IndianRupee, permission: "fees:view" },
      { href: "/fees/collect", label: "Collect fees", icon: Wallet, permission: "fees:collect" },
      { href: "/fees/payments", label: "Payments", icon: ReceiptIndianRupee, permission: "fees:collect" },
      { href: "/fees/online", label: "Online payments", icon: CreditCard, permission: "fees:view" },
      { href: "/timetable", label: "Timetable", icon: Clock3, permission: "timetable:view" },
      { href: "/homework", label: "Homework", icon: NotebookPen, permission: "homework:view" },
      { href: "/exams", label: "Exams", icon: FileCheck2, permission: "exams:view" },
      { href: "/library", label: "Library", icon: LibraryBig, permission: "library:view" },
      { href: "/transport", label: "Transport", icon: Bus, permission: "transport:view" },
      { href: "/inventory", label: "Inventory", icon: Boxes, permission: "inventory:view" },
      { href: "/report-cards", label: "Report cards", icon: Award, permission: "report_cards:manage" },
      { href: "/certificates", label: "Certificates", icon: FileBadge, permission: "certificates:manage" },
      { href: "/id-cards", label: "ID cards", icon: IdCard, permission: "id_cards:manage" },
      { href: "/attendance", label: "Attendance", icon: CalendarCheck, permission: "attendance:view" },
      { href: "/attendance/reports", label: "Attendance reports", icon: ChartColumn, permission: "attendance:mark" },
      { href: "/reports", label: "Reports", icon: BarChart3, permission: "reports:view", feature: "reports" },
      { href: "/analytics", label: "Analytics", icon: ChartLine, permission: "analytics:fees", feature: "analytics" },
      { href: "/communication", label: "Communication", icon: MessagesSquare, permission: "notifications:manage" },
    ],
  },
  {
    group: "Staff",
    items: [
      { href: "/staff-leave", label: "Staff leave", icon: CalendarX2, permission: "hr:manage" },
      { href: "/staff-attendance", label: "Staff attendance", icon: UserCheck, permission: "hr:manage" },
      { href: "/payroll", label: "Payroll", icon: Banknote, permission: "payroll:manage" },
    ],
  },
  {
    group: "Setup",
    items: [{ href: "/sessions", label: "Academic sessions", icon: CalendarRange, permission: "sessions:view" }],
  },
  {
    group: "Platform",
    items: [
      { href: "/admin/schools", label: "Schools", icon: Building2, permission: "platform:schools.manage" },
      { href: "/admin/plans", label: "Plans", icon: CreditCard, permission: "platform:schools.manage" },
      { href: "/admin/invoices", label: "Invoices", icon: ReceiptText, permission: "platform:schools.manage" },
      { href: "/admin/billing", label: "Billing setup", icon: Landmark, permission: "platform:schools.manage" },
      { href: "/admin/audit", label: "Platform audit log", icon: ScrollText, permission: "platform:schools.manage" },
      { href: "/admin/analytics", label: "Platform analytics", icon: ChartNoAxesCombined, permission: "platform:schools.manage" },
    ],
  },
  {
    group: "Account",
    items: [
      { href: "/settings", label: "School settings", icon: Settings, permission: "settings:manage" },
      { href: "/audit-log", label: "Audit log", icon: ScrollText, permission: "audit:view" },
      { href: "/profile", label: "My profile", icon: UserRound },
    ],
  },
];

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { can, hasFeature } = useAuth();
  const shown = (i: NavItem) => (!i.permission || can(i.permission)) && (!i.feature || hasFeature(i.feature));
  // Highlight only the most specific match (e.g. /fees/collect, not also /fees).
  const activeHref = NAV.flatMap((g) => g.items)
    .filter((i) => shown(i) && (pathname === i.href || pathname.startsWith(`${i.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  return (
    <nav className="flex h-full flex-col bg-board-900 text-white/80" aria-label="Main">
      <div className="flex h-[calc(4rem+env(safe-area-inset-top))] items-center gap-2.5 border-b border-white/10 px-5 pt-[env(safe-area-inset-top)]">
        <div className="grid size-8 place-items-center rounded-md bg-pencil-400 text-sm font-bold text-board-950">S</div>
        <span className="font-semibold tracking-tight text-white">School ERP</span>
      </div>
      <div className="flex-1 space-y-6 overflow-y-auto overscroll-contain px-3 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-5">
        {NAV.map(({ group, items }) => {
          const visible = items.filter(shown);
          if (visible.length === 0) return null;
          return (
            <div key={group}>
              <p className="mb-1.5 px-3 text-xs font-medium text-white/65">{group}</p>
              <ul className="space-y-0.5">
                {visible.map(({ href, label, icon: Icon }) => {
                  const active = href === activeHref;
                  return (
                    <li key={href}>
                      <Link
                        href={href}
                        onClick={onNavigate}
                        aria-current={active ? "page" : undefined}
                        className={clsx(
                          "relative flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors lg:py-2",
                          active ? "bg-white/10 font-medium text-white" : "hover:bg-white/5 hover:text-white",
                        )}
                      >
                        {active && <span className="absolute inset-y-1.5 left-0 w-1 rounded-r bg-pencil-400" aria-hidden />}
                        <Icon className="size-4.5" aria-hidden />
                        {label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
