/** The platform (super admin) and subscription billing: plans and what they include, subscriptions,
 * invoices, payments, usage, system analytics. Amounts arrive as exact decimal strings (or numbers the
 * database computed); a subscription's status is worked out by the database from its records — the
 * browser only formats what it is given. */

/** Where a subscription stands (never stored: derived from the plan, dates, invoices and payments). */
export type SubStatus = "none" | "trialing" | "active" | "cancelling" | "grace" | "expired" | "cancelled";
export type InvoiceState = "open" | "overdue" | "partly_paid" | "paid" | "void";
export type BillingCycle = "monthly" | "yearly";
export type FeatureKey = "students" | "teachers" | "storage_mb" | "whatsapp" | "reports" | "analytics" | "ai_assistant" | "website_builder";

export interface PlanFeature {
  key: FeatureKey; label: string; kind: "limit" | "feature"; unit: string | null; description: string; enforced_by: string; available: boolean;
}
export interface Entitlement { included: boolean; limit?: number | null }

export interface Plan {
  id: string; code: string; name: string; description: string | null;
  price_monthly: string; price_yearly: string; trial_days: number; grace_period_days: number;
  features: string[]; entitlements: Partial<Record<FeatureKey, Entitlement>>;
  is_active: boolean; display_order: number; schools: number; created_at: string; updated_at: string;
}

/** private.subscription_status, as JSON */
export interface StatusInfo {
  status: SubStatus; access: "full" | "read_only";
  plan_id?: string; plan_name?: string; billing_cycle?: BillingCycle; price?: number;
  started_on?: string; trial_ends_at?: string | null; on_trial?: boolean;
  paid_through?: string | null; ever_paid?: boolean; current_period?: { start: string; end: string } | null;
  grace_until?: string | null; grace_period_days?: number;
  cancel_at_period_end?: boolean; cancelled_at?: string | null;
  open_invoices?: number; balance_due?: number;
}

export interface SubscriptionFacts {
  plan_id: string; plan_name: string; plan_code: string; plan_is_active: boolean; highlights: string[];
  trial_days: number; grace_period_days: number; billing_cycle: BillingCycle;
  agreed_price: string | null; plan_price: string;
  started_on: string; trial_ends_at: string | null; cancel_at_period_end: boolean; cancelled_at: string | null; cancel_reason: string | null;
  billing_gstin: string | null; notes?: string | null; updated_at: string;
}

export interface Invoice {
  id: string; invoice_number: string; kind: "subscription" | "renewal" | "imported"; plan_name: string; billing_cycle: BillingCycle;
  period_start: string; period_end: string; subtotal: string; tax_amount: string; total: string;
  issued_on: string; due_on: string; voided_at: string | null; void_reason: string | null; state: InvoiceState; paid: string;
}
export interface PlatformInvoice {
  id: string; invoice_number: string; school_id: string; school_name: string; kind: string; plan_name: string;
  period_start: string; period_end: string; total: string; issued_on: string; due_on: string; state: InvoiceState; paid: string;
}
export interface SubPayment {
  id: string; invoice_id: string; invoice_number: string; amount: string; refunded_amount: string;
  method: "razorpay" | "bank_transfer" | "upi" | "cheque" | "cash" | "other" | "imported"; method_detail: string | null; reference: string | null;
  gateway_payment_id: string | null; source: "manual" | "checkout" | "webhook" | "imported"; paid_on: string; refunded_at: string | null;
}
export interface EntitlementRow {
  key: FeatureKey; label: string; kind: "limit" | "feature"; unit: string | null; available: boolean; included: boolean; limit: number | null;
}
export interface SubEvent {
  id: number; action: string; plan_name: string; billing_cycle: BillingCycle; price: string | null; trial_ends_at: string | null;
  details: { previous?: Record<string, unknown>; reason?: string | null } | null; changed_at: string; changed_by: string | null;
}

export interface SubscriptionView {
  status: StatusInfo; subscription: SubscriptionFacts | null; invoices: Invoice[]; payments: SubPayment[]; entitlements: EntitlementRow[];
  history?: SubEvent[]; issued_invoice?: string | null;
}
export interface SchoolBilling extends SubscriptionView { usage: Usage; online_payments: boolean }

export interface UsageEntitlement { label: string; kind: "limit" | "feature"; unit: string | null; available: boolean; included: boolean; limit: number | null }
export interface Usage {
  school_id: string;
  session: { id: string; name: string } | null;
  students: { active: number; total: number; enrolled_this_session: number };
  teachers: number;
  people: { school_admins: number; accountants: number; teachers: number; librarians: number; parents: number; students: number; staff: number };
  classes: number; sections: number;
  last_30_days: { from: string; to: string; attendance_days: number; receipts: number; collected: number; notifications: number; whatsapp_sent: number; actions: number };
  last_activity_at: string | null; storage_bytes: number | null; storage_source: "storage" | "file_records";
  entitlements: Partial<Record<FeatureKey, UsageEntitlement>> | null;
  over_limits: { students: boolean; teachers: boolean; storage_mb: boolean };
}

export interface BillingSettings {
  legal_name: string; gstin: string | null; address: string; state: string; email: string | null; phone: string | null;
  invoice_prefix: string; tax_label: string; tax_rate: string; renewal_lead_days: number; payment_due_days: number; updated_at?: string;
}
export interface BillingSettingsView {
  settings: BillingSettings | null;
  online_payments: { enabled: boolean; webhook_secret_set: boolean; key_id: string | null; webhook_path: string };
}
export interface WebhookEvent { id: number; event_id: string; kind: string; order_id: string | null; payment_id: string | null; outcome: string; received_at: string }

export interface PlatformAnalytics {
  as_of: string;
  schools: { total: number; active: number; inactive: number; added_this_month: number; active_last_7_days: number; active_last_30_days: number;
    without_subscription: number; without_admin: number };
  people: { students_active: number; staff: number; parents: number; student_logins: number; accounts: number };
  subscriptions: {
    by_state: Partial<Record<SubStatus, number>>; mrr: number; arr: number;
    by_plan: { plan: string; plan_id: string; is_active: boolean; schools: number; paying: number; mrr: number }[];
    renewals_due: { school_id: string; school: string; plan: string; state: SubStatus; date: string }[];
    needs_attention: { school_id: string; school: string; plan: string; state: SubStatus; date: string }[];
  };
  billing: { invoiced_this_month: number; collected_this_month: number; outstanding: number; overdue: number; open_invoices: number };
  growth: { month: string; new_schools: number; schools: number; new_students: number; fees_collected: number; receipts: number;
    subscription_revenue: number; active_schools: number }[];
  largest_schools: { school_id: string; school: string; status: string; students: number; staff: number }[];
  over_limits: { school_id: string; school: string; plan: string; students: number; max_students: number | null; teachers: number; max_teachers: number | null }[];
}

export const STATUS_LABEL: Record<SubStatus, string> = {
  none: "No plan", trialing: "Trial", active: "Active", cancelling: "Ends at period end", grace: "Payment due", expired: "Expired", cancelled: "Cancelled",
};
/** good / warning / serious / neutral — always shown with an icon and the label, never colour alone */
export const STATUS_TONE: Record<SubStatus, "good" | "warning" | "serious" | "neutral"> = {
  none: "neutral", trialing: "neutral", active: "good", cancelling: "warning", grace: "warning", expired: "serious", cancelled: "serious",
};
export const INVOICE_LABEL: Record<InvoiceState, string> = { open: "Due", overdue: "Overdue", partly_paid: "Part paid", paid: "Paid", void: "Cancelled" };
export const INVOICE_TONE: Record<InvoiceState, "good" | "warning" | "serious" | "neutral"> = {
  open: "warning", overdue: "serious", partly_paid: "warning", paid: "good", void: "neutral",
};
export const CYCLE_LABEL: Record<BillingCycle, string> = { monthly: "Monthly", yearly: "Yearly" };
export const METHOD_LABEL: Record<SubPayment["method"], string> = {
  razorpay: "Online (Razorpay)", bank_transfer: "Bank transfer", upi: "UPI", cheque: "Cheque", cash: "Cash", other: "Other", imported: "Recorded earlier",
};
export const EVENT_LABEL: Record<string, string> = {
  started: "Started", changed: "Changed", cancelled: "Cancelled", reactivated: "Reactivated",
  "set to end at period end": "Set to end at period end", resumed: "Resumed",
};

/** Starting points for a new plan: a name and which features are switched on. Prices, limits, trial and
 * grace days are always entered by the platform — nothing about money or numbers is assumed. */
export const PLAN_TEMPLATES: { code: string; name: string; on: FeatureKey[]; note: string }[] = [
  { code: "BASIC", name: "Basic", on: [], note: "The core school records; no extras." },
  { code: "PROFESSIONAL", name: "Professional", on: ["whatsapp", "reports", "analytics"], note: "Adds WhatsApp, reports and analytics." },
  { code: "ENTERPRISE", name: "Enterprise", on: ["whatsapp", "reports", "analytics", "ai_assistant", "website_builder"], note: "Everything, including modules still to come." },
];

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A limit as words: "500 students", "2 GB" or "No limit". */
export function limitText(e: { kind: string; unit: string | null; limit?: number | null } | undefined): string {
  if (!e || e.limit === null || e.limit === undefined) return "No limit";
  if (e.unit === "MB") return e.limit >= 1024 && e.limit % 1024 === 0 ? `${(e.limit / 1024).toLocaleString("en-IN")} GB` : `${e.limit.toLocaleString("en-IN")} MB`;
  return `${e.limit.toLocaleString("en-IN")} ${e.unit ?? ""}`.trim();
}
