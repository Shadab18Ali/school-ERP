import { config } from "@/lib/config";

/** Calls the public (no-login) API. Never sends a session token. */
export async function publicFetch<T>(path: string, init: { method?: string; body?: FormData | object } = {}): Promise<T> {
  const isForm = typeof FormData !== "undefined" && init.body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`${config.apiUrl}${config.apiPrefix}${path}`, {
      method: init.method ?? "GET",
      headers: init.body && !isForm ? { "Content-Type": "application/json" } : undefined,
      body: init.body === undefined ? undefined : isForm ? (init.body as FormData) : JSON.stringify(init.body),
      credentials: "omit",
    });
  } catch {
    throw new Error("Couldn't reach the school's server. Check your internet connection and try again.");
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.detail;
    throw new Error(typeof detail === "string" ? detail : res.status === 429 ? "Too many attempts. Please wait a little and try again." : "Something went wrong. Please try again.");
  }
  return data as T;
}

export interface AdmissionWindow {
  window_id: string; session_id: string; session_name: string; class_id: string; class_name: string;
  admission_fee: number | string; last_date: string | null; instructions: string | null; seats_left: number | null;
}
export interface AdmissionForm {
  school: { name: string; code: string; address: string | null; city: string | null; state: string | null; phone: string | null; email: string | null; logo_url: string | null };
  windows: AdmissionWindow[];
}
export type AdmissionStatus = "submitted" | "under_review" | "verified" | "approved" | "rejected" | "fee_paid" | "enrolled";
export interface ApplicantStatus {
  application_number: string; status: AdmissionStatus; student_name: string; class_name: string; session_name: string; submitted_at: string;
  rejection_reason: string | null; fee_amount: number | string | null; fee_paid_on: string | null; fee_receipt_number: string | null;
  instructions: string | null; school_name: string; school_phone: string | null; school_email: string | null;
  timeline: { status: AdmissionStatus; at: string; note: string | null }[];
}
export const STATUS_LABEL: Record<AdmissionStatus, string> = {
  submitted: "Application received", under_review: "Under review", verified: "Documents verified", approved: "Approved",
  rejected: "Not approved", fee_paid: "Admission fee paid", enrolled: "Admission complete",
};
export const inr = (v: number | string | null | undefined) =>
  v === null || v === undefined ? "—" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(v));
