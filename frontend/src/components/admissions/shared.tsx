import { clsx } from "clsx";
import { type AdmissionStatus, STATUS_LABEL } from "@/lib/public-api";

export const STATUS_ORDER: AdmissionStatus[] = ["submitted", "under_review", "verified", "approved", "fee_paid", "enrolled", "rejected"];

/** Staff wording (the public pages use STATUS_LABEL as is). */
const STAFF_LABEL: Partial<Record<AdmissionStatus, string>> = { submitted: "New", rejected: "Rejected", enrolled: "Student created" };
export const staffLabel = (s: AdmissionStatus) => STAFF_LABEL[s] ?? STATUS_LABEL[s];

export function AdmissionStatusBadge({ status }: { status: AdmissionStatus }) {
  return (
    <span data-testid="admission-status" className={clsx("inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
      status === "rejected" ? "bg-danger-50 text-danger-600"
        : status === "enrolled" ? "bg-leaf-600 text-white"
          : status === "submitted" ? "bg-pencil-100 text-ink"
            : "bg-leaf-50 text-leaf-700")}>
      {staffLabel(status)}
    </span>
  );
}

export interface AdmissionWindowRow {
  class_id: string; class_name: string; window_id: string | null; is_open: boolean; seats: number | null;
  admission_fee: string | null; last_date: string | null; instructions: string | null; applications: number; admitted: number;
}
export interface AdmissionListItem {
  id: string; application_number: string; status: AdmissionStatus; student_name: string; date_of_birth: string; gender: string;
  contact_phone: string; parent_name: string | null; class_name: string; session_name: string; submitted_at: string; updated_at: string; documents: number;
}
export interface AdmissionDetail {
  id: string; application_number: string; status: AdmissionStatus;
  student_name: string; date_of_birth: string; gender: string; blood_group: string | null;
  father_name: string | null; father_phone: string | null; father_occupation: string | null;
  mother_name: string | null; mother_phone: string | null; mother_occupation: string | null;
  contact_phone: string; contact_email: string | null;
  address_line: string; city: string; state: string; postal_code: string;
  previous_school: string | null; previous_class: string | null; previous_board: string | null;
  review_note: string | null; rejection_reason: string | null;
  academic_session_id: string; session_name: string; session_is_archived: boolean; class_id: string; class_name: string;
  has_photo: boolean; submitted_at: string;
  fee_due: string | null; fee_amount: string | null; fee_paid_amount: string | null; fee_payment_mode: string | null;
  fee_paid_on: string | null; fee_reference: string | null; fee_receipt_number: string | null;
  seats: number | null; seats_taken: number; student_id: string | null; student_code: string | null;
  documents: { id: string; document_type: string; label: string; file_name: string; mime_type: string; size_bytes: number }[];
  timeline: { from: AdmissionStatus | null; to: AdmissionStatus; note: string | null; at: string; by: string | null }[];
  parent_invite_error?: string | null;
}
