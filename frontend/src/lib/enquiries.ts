export type EnquiryStatus = "new" | "contacted" | "follow_up" | "interested" | "application" | "approved" | "rejected" | "admitted";
export type EnquirySource = "walk_in" | "phone_call" | "website" | "social_media" | "newspaper" | "hoarding" | "referral" | "school_event" | "other";

export const ENQUIRY_STATUSES: EnquiryStatus[] = ["new", "contacted", "follow_up", "interested", "application", "approved", "rejected", "admitted"];
export const ENQUIRY_STATUS_LABEL: Record<EnquiryStatus, string> = {
  new: "New", contacted: "Contacted", follow_up: "Follow-up", interested: "Interested",
  application: "Application", approved: "Approved", rejected: "Rejected", admitted: "Admitted",
};
export const ENQUIRY_SOURCES: [EnquirySource, string][] = [
  ["walk_in", "Walk-in"], ["phone_call", "Phone call"], ["website", "Website"], ["social_media", "Social media"],
  ["newspaper", "Newspaper"], ["hoarding", "Hoarding / banner"], ["referral", "Referral"], ["school_event", "School event"], ["other", "Other"],
];
export const SOURCE_LABEL = Object.fromEntries(ENQUIRY_SOURCES) as Record<EnquirySource, string>;
export const isClosed = (s: EnquiryStatus) => s === "rejected" || s === "admitted";

export interface Enquiry {
  id: string; enquiry_number: string; enquiry_date: string; parent_name: string; student_name: string; phone: string; email: string | null;
  class_id: string | null; class_name: string | null; source: EnquirySource; source_detail: string | null; status: EnquiryStatus;
  follow_up_date: string | null; notes: string | null; application_id: string | null; application_number: string | null; application_status: string | null;
  academic_session_id: string; session_name: string; session_is_archived: boolean; created_at: string; updated_at: string; last_activity_at: string | null;
}
export interface EnquiryActivity {
  kind: "created" | "status" | "follow_up" | "note" | "linked" | "unlinked";
  from: EnquiryStatus | null; to: EnquiryStatus | null; follow_up_date: string | null; note: string | null; at: string; by: string | null;
}
export interface Duplicate { id: string; enquiry_number: string; student_name: string; status: EnquiryStatus; session_name: string; enquiry_date: string }
export interface EnquiryDetail extends Enquiry { activities: EnquiryActivity[]; duplicates: Duplicate[] }
export interface Pipeline {
  session: { id: string; name: string; is_archived: boolean } | null;
  total: number; open: number; new_last_7_days: number; admitted: number; conversion_rate: number | null; win_rate: number | null;
  by_status: { status: EnquiryStatus; label: string; count: number }[];
  funnel: { stage: string; label: string; count: number }[];
  follow_ups: { overdue: number; today: number; next_7_days: number; not_scheduled: number };
  by_source: { source: EnquirySource; label: string; total: number; admitted: number; rejected: number; conversion_rate: number | null }[];
  by_class: { class_name: string; total: number; open: number; admitted: number }[];
  monthly: { month: string; enquiries: number; admitted: number }[];
  due: Enquiry[];
}

/** Local date (not UTC) as YYYY-MM-DD, plus n days. */
export function dayFromToday(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** wa.me needs the country code; a bare 10-digit number is taken as Indian (+91). */
export function whatsappLink(phone: string, text?: string): string {
  const digits = phone.replace(/\D/g, "");
  const full = phone.startsWith("+") ? digits : digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${full}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}
