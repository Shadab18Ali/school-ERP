export type CopyStatus = "available" | "issued" | "lost" | "damaged" | "withdrawn";
export type FineStatus = "none" | "unpaid" | "paid" | "waived";
export type ReturnCondition = "good" | "damaged" | "lost";
export type PaymentMode = "cash" | "upi" | "card" | "bank_transfer" | "cheque";
export type LoanState = "open" | "overdue" | "returned" | "fines_unpaid" | "fines_settled" | "all";

export const COPY_STATUS_LABEL: Record<CopyStatus, string> = {
  available: "Available", issued: "Issued", lost: "Lost", damaged: "Damaged", withdrawn: "Withdrawn",
};
export const COPY_STATUS_TONE: Record<CopyStatus, string> = {
  available: "bg-leaf-50 text-leaf-700", issued: "bg-pencil-100 text-ink", lost: "bg-danger-50 text-danger-600",
  damaged: "bg-danger-50 text-danger-600", withdrawn: "bg-ink/5 text-muted",
};
export const FINE_STATUS_LABEL: Record<FineStatus, string> = { none: "No fine", unpaid: "Unpaid", paid: "Paid", waived: "Waived" };
export const CONDITION_LABEL: Record<ReturnCondition, string> = { good: "Good", damaged: "Damaged", lost: "Lost" };
export const MODE_LABEL: Record<PaymentMode, string> = {
  cash: "Cash", upi: "UPI", card: "Card", bank_transfer: "Bank transfer", cheque: "Cheque",
};
export const LOAN_STATE_LABEL: Record<LoanState, string> = {
  open: "On loan", overdue: "Overdue", returned: "Returned", fines_unpaid: "Fines to collect", fines_settled: "Fines settled", all: "All",
};

export interface Book {
  id: string; title: string; subtitle: string | null; isbn: string | null; publisher: string | null; edition: string | null;
  publication_year: number | null; language: string | null; category_id: string | null; category: string | null;
  shelf_location: string | null; description: string | null; is_active: boolean; created_at: string; authors: string[];
  copies: number; available: number; issued: number;
}
export interface Copy {
  id: string; accession_number: string; status: CopyStatus; price: string | null; acquired_on: string | null; note: string | null;
  times_issued: number; loan: { id: string; borrower_name: string; borrower_class: string | null; due_date: string } | null;
}
export interface BookDetail extends Book { copy_list: Copy[]; can_manage: boolean }
export interface Category { id: string; name: string; books: number }

export interface Loan {
  id: string; copy_id: string; accession_number: string; book_id: string; title: string;
  student_id: string | null; teacher_id: string | null; borrower_kind: "student" | "staff";
  borrower_name: string; borrower_code: string | null; borrower_class: string | null;
  issued_on: string; due_date: string; returned_on: string | null; return_condition: ReturnCondition | null; renewals: number;
  fine_per_day: string; grace_days: number; max_fine: string | null;
  fine_amount: string; book_charge: string; fine_status: FineStatus; fine_paid_amount: string | null; fine_paid_at: string | null;
  fine_payment_mode: PaymentMode | null; fine_reference: string | null; fine_receipt_number: string | null;
  fine_waived_at: string | null; fine_waive_reason: string | null; note: string | null;
  amount_due: string; issued_by_name: string | null; returned_by_name: string | null;
  is_open: boolean; is_overdue: boolean; days_overdue: number;
}
export interface LoanList { items: Loan[]; total: number; page: number; page_size: number }

export interface Borrower {
  kind: "student" | "staff"; id: string; name: string; code: string | null; detail: string | null;
  open_loans: number; overdue: number; fines_due: string;
}
export interface BorrowerDetail extends Borrower {
  max_books: number; loan_days: number; is_active: boolean; blocked: string[]; history: Loan[];
}

export interface LibrarySettings {
  loan_days_student: number; loan_days_staff: number; max_books_student: number; max_books_staff: number;
  fine_per_day: string; grace_days: number; max_fine: string | null; max_renewals: number;
  block_when_overdue: boolean; block_when_fines_due: boolean; configured: boolean; updated_at: string | null;
}

export interface LibraryDashboard {
  titles: number; copies: number; available: number; issued: number; overdue: number; damaged: number; lost: number;
  borrowers: number; issued_today: number; returned_today: number;
  fines_unpaid: string; fines_unpaid_count: number; fines_accruing: string; fines_collected_month: string;
  fines_collected_total: string; fines_waived_total: string; fine_per_day: string;
  by_category: { name: string; copies: number; issued: number }[];
  top_books: { id: string; title: string; loans: number }[];
}

export interface CopyLookup {
  id: string; accession_number: string; status: CopyStatus; price: string | null; book_id: string; title: string;
  authors: string; book_active: boolean; loan: Loan | null;
}

export interface StudentLibrary {
  current: Loan[]; history: Loan[]; amount_due: string;
  rules: { loan_days_student: number; max_books_student: number; fine_per_day: string; grace_days: number; max_fine: string | null };
}

/** What is owed on a loan, in words. */
export function owedText(l: Loan): string | null {
  const n = Number(l.amount_due);
  if (l.is_open) return n > 0 ? `fine so far` : null;
  return l.fine_status === "unpaid" ? "to pay" : null;
}

/** ISBN-10 or -13 -> ISBN-13 (same rules as the server), or null if it isn't valid. */
export function isbn13(raw: string): string | null {
  const s = raw.replace(/[\s-]/g, "").toUpperCase();
  const check13 = (d: string) => (10 - ([...d].reduce((t, c, i) => t + Number(c) * (i % 2 ? 3 : 1), 0) % 10)) % 10;
  if (/^[0-9]{9}[0-9X]$/.test(s)) {
    const total = [...s].reduce((t, c, i) => t + (c === "X" ? 10 : Number(c)) * (10 - i), 0);
    if (total % 11) return null;
    const d = "978" + s.slice(0, 9);
    return d + check13(d);
  }
  if (/^97[89][0-9]{10}$/.test(s)) return check13(s.slice(0, 12)) === Number(s[12]) ? s : null;
  return null;
}

/** 9780306406157 -> 978-0306406157 (simple, readable grouping without registration-group tables). */
export function showIsbn(isbn: string | null): string {
  return isbn ? `${isbn.slice(0, 3)}-${isbn.slice(3)}` : "";
}
