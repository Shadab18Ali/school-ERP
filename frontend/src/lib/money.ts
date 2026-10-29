/**
 * Display helpers only. Amounts are calculated and summed in the database and
 * arrive as exact decimal strings; the browser formats them, never adds them up.
 */
const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2, minimumFractionDigits: 0 });

export function formatINR(amount: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === "") return "—";
  const n = Number(amount);
  return Number.isFinite(n) ? inr.format(n) : amount;
}

/** Up to 8 digits and 2 decimals, e.g. "1500" or "1500.50". */
export const AMOUNT_PATTERN = /^\d{1,8}(\.\d{1,2})?$/;

export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Calendar months (1-12) a session covers, in session order (e.g. Apr..Mar). */
export function sessionMonths(start: string, end: string): number[] {
  const out: number[] = [];
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  const ey = Number(end.slice(0, 4));
  const em = Number(end.slice(5, 7));
  while ((y < ey || (y === ey && m <= em)) && out.length < 24) {
    if (!out.includes(m)) out.push(m);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

export function monthLabel(isoMonth: string): string {
  const [y, m] = isoMonth.split("-");
  return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
}

/** Exact decimal string → whole paise (integers, so no float error). Only for validation/preview. */
export function toPaise(amount: string): number | null {
  const m = amount.trim().match(/^(\d{1,8})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export function paiseToAmount(paise: number): string {
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, "0")}`;
}
