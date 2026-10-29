/**
 * School analytics: the shapes the API returns (every figure computed in the database, see
 * migration 0028) and display helpers. The browser only formats and draws these numbers; it
 * never adds them up.
 */
import { MONTH_NAMES } from "@/lib/money";

export type AnalyticsTab = "students" | "fees" | "admissions";

export interface SessionRef { id: string; name: string; start_date: string; end_date: string }
export interface Window { from: string | null; to: string | null }

export interface StudentAnalytics {
  session: SessionRef | null;
  window: Window;
  enrollment: {
    kpis: { students: number; enrolled_all: number; left: number; new_students: number; boys: number; girls: number; other: number };
    trend: { session_id: string; session: string; current: boolean; enrolled: number; new_students: number; continuing: number }[];
    admissions_by_month: { month: string; new_students: number }[];
  };
  strength: {
    sections: number; average_section: number | null; capacity: number | null; fill_percent: number | null;
    classes: {
      class_id: string; class: string; students: number; boys: number; girls: number; other: number; sections: number;
      capacity: number | null; fill_percent: number | null;
      detail: { section_id: string; section: string; students: number; boys: number; girls: number; capacity: number | null }[];
    }[];
  };
  attendance: {
    from: string; to: string; days_marked: number; present: number; absent: number; leave: number; percent: number | null;
    students_counted: number;
    monthly: { month: string; present: number; absent: number; leave: number; percent: number | null }[];
    daily: { date: string; marked: number; percent: number | null }[];
    by_class: { class_id: string; class: string; marked: number; percent: number | null }[];
    bands: { band: string; students: number }[];
  };
  performance: {
    exams: { id: string; name: string; status: string; has_marks: boolean; first_date: string | null }[];
    exam_id: string | null; exam_name: string | null;
    students: number; complete: number; incomplete: number; average_percent: number | null;
    passed: number; failed: number; pass_rate: number | null;
    by_class: { class_id: string; class: string; students: number; average_percent: number | null; pass_rate: number | null }[];
    by_subject: { subject_id: string; subject: string; sat: number; absent: number; average_percent: number | null; pass_rate: number | null }[];
    grades: { grade: string; min_percent: number; students: number }[];
    trend: { exam_id: string; exam: string; students: number; average_percent: number | null; pass_rate: number | null }[];
  };
}

export interface FeeAnalytics {
  session: SessionRef | null;
  previous_session: { id: string; name: string } | null;
  window: Window;
  kpis: {
    collected: number; receipts: number; cancelled: number; cancelled_receipts: number; billed: number; due_to_date: number;
    paid_to_date: number; collection_rate: number | null; outstanding: number; overdue: number; students_with_dues: number;
  };
  monthly: { month: string; collected: number; receipts: number; previous: number | null; in_window: boolean }[];
  by_class: { class_id: string; class: string; billed: number; due_to_date: number; collected: number; outstanding: number; overdue: number; collection_rate: number | null }[];
  by_method: { method: string; amount: number; receipts: number }[];
  online_methods: { method: string; amount: number; receipts: number }[];
  by_head: { fee_head: string; billed: number; outstanding: number; overdue: number }[];
  aging: { bucket: string; amount: number }[];
  outstanding_trend: { month: string; due: number; outstanding: number }[];
}

export interface AdmissionAnalytics {
  session: SessionRef | null;
  window: Window;
  kpis: {
    enquiries: number; enquiries_to_application: number; enquiries_admitted: number; enquiries_open: number; follow_ups_overdue: number;
    applications: number; applications_pending: number; applications_approved: number; applications_rejected: number; applications_enrolled: number;
    admissions: number; admissions_online: number; admissions_direct: number; enquiry_conversion: number | null; application_conversion: number | null;
  };
  monthly: { month: string; enquiries: number; applications: number; admissions: number }[];
  enquiry_funnel: { stage: string; count: number }[];
  application_funnel: { stage: string; count: number }[];
  by_source: { source: string; enquiries: number; admitted: number; conversion: number | null }[];
  by_status: { status: string; enquiries: number }[];
  application_status: { status: string; applications: number }[];
  by_class: { class_id: string; class: string; enquiries: number; applications: number; admissions: number }[];
}

/**
 * Validated categorical palette (dataviz validator: lightness band, chroma floor, adjacent CVD ΔE ≥ 16,
 * normal-vision floor; slots 5–6 are under 3:1 contrast so every chart also has labels and a table).
 * Assigned in this fixed order, never cycled; a series keeps its slot whatever else is shown.
 */
export const SERIES = ["#1d7f5b", "#2a78d6", "#eb6834", "#6250d6", "#eda100", "#e87ba4"] as const;
/** One hue, light → dark, for ordered stages (funnels, attendance bands, how late a due is). */
export const RAMP = ["#7fbf9f", "#4f9f7c", "#1d7f5b", "#155f44"] as const;
export const INK = "#1a2321";
export const MUTED = "#5d6b67";
export const GRID = "#e8ecea";

export const monthShort = (iso: string) => `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(2, 4)}`;
export const dayShort = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]}`;

const inr0 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2, minimumFractionDigits: 0 });
const int = new Intl.NumberFormat("en-IN");

export const fmtInt = (n: number | null | undefined) => (n === null || n === undefined ? "—" : int.format(n));
/** "1 receipt", "3 receipts" */
export const plural = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;
export const fmtPct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n}%`);
export const fmtMoney = (n: number | null | undefined) => (n === null || n === undefined ? "—" : inr2.format(n));
/** Rupees in Indian short form for axes and tiles: ₹950, ₹12.5K, ₹3.4L, ₹1.2Cr. */
export function fmtMoneyShort(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const a = Math.abs(n);
  const s = n < 0 ? "-" : "";
  if (a >= 1e7) return `${s}₹${trim(a / 1e7)}Cr`;
  if (a >= 1e5) return `${s}₹${trim(a / 1e5)}L`;
  if (a >= 1e3) return `${s}₹${trim(a / 1e3)}K`;
  return inr0.format(n);
}
const trim = (x: number) => (x >= 100 ? x.toFixed(0) : x.toFixed(1).replace(/\.0$/, ""));

export const METHOD_LABEL: Record<string, string> = {
  cash: "Cash", upi: "UPI", bank_transfer: "Bank transfer", cheque: "Cheque", other: "Other", online: "Online payment",
  card: "Card", netbanking: "Net banking", wallet: "Wallet", emi: "EMI", paylater: "Pay later", unknown: "Not reported",
};
export const methodLabel = (m: string) => METHOD_LABEL[m] ?? m.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** A table as CSV (Excel-friendly: BOM, quoted cells, formula-looking text defused). */
export function toCsv(columns: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [columns, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function downloadCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Date-range presets for the filter row (the database clamps the range to the session). */
export type RangePreset = "session" | "this_month" | "last_3" | "last_6" | "custom";
export function presetRange(p: RangePreset, today: string): { from: string; to: string } | null {
  if (p === "session" || p === "custom") return null;
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const back = p === "this_month" ? 0 : p === "last_3" ? 2 : 5;
  const d = new Date(Date.UTC(y, m - 1 - back, 1));
  return { from: d.toISOString().slice(0, 10), to: today };
}
