const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** Formats an ISO date (YYYY-MM-DD) or timestamp for display, e.g. "1 Apr 2026". */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(d.getTime()) ? "—" : dateFmt.format(d);
}

/** Suggests the Indian academic year that starts in `startYear`: 1 Apr – 31 Mar, named "2026-27". */
export function suggestSession(startYear: number) {
  return {
    name: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
    start_date: `${startYear}-04-01`,
    end_date: `${startYear + 1}-03-31`,
  };
}

/** Whole years between an ISO date of birth and today. */
export function ageFrom(dob: string): number {
  const d = new Date(`${dob}T00:00:00`);
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) age--;
  return age;
}

/** Today's date as YYYY-MM-DD in the user's timezone. */
export function todayISO(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** "+919876543210" -> "+91 98765 43210"; "9876543210" -> "98765 43210". Display only. */
export function formatPhone(p: string | null | undefined): string {
  if (!p) return "—";
  const m = p.match(/^(\+\d{1,3})?(\d{5})(\d{5})$/);
  return m ? [m[1], m[2], m[3]].filter(Boolean).join(" ") : p;
}

const dateTimeFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
/** A timestamp in the viewer's own time zone, e.g. "12 Oct 2026, 5:00 pm". */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : dateTimeFmt.format(d);
}

/** Value for <input type="datetime-local"> from an ISO timestamp, in local time. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
