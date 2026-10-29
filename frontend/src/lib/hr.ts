// ------------------------------------------------------------------ leave
export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";
export const LEAVE_STATUS_LABEL: Record<LeaveStatus, string> = { pending: "Pending", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled" };

export interface LeaveType {
  id: string; name: string; code: string; annual_days: string | null; is_paid: boolean; allow_half_day: boolean; is_active: boolean; applications: number;
}
export interface Leave {
  id: string; teacher_id: string; staff_name: string; employee_id: string; leave_type_id: string; leave_type: string; leave_code: string;
  is_paid: boolean; academic_session_id: string; session_name: string; start_date: string; end_date: string; half_day: boolean; days: string;
  reason: string; status: LeaveStatus; applied_at: string; applied_by_name: string | null; applied_by: string | null;
  decided_at: string | null; decided_by_name: string | null; decision_note: string | null; cancelled_at: string | null;
}
export interface LeaveList { items: Leave[]; total: number; page: number; page_size: number; pending: number }
export interface Balance {
  leave_type_id: string; name: string; code: string; is_paid: boolean; allowance: string | null; used: string; pending: string; available: string | null;
}
export interface SessionOption { id: string; name: string; start_date: string; end_date: string; is_current: boolean }
export interface MyLeave {
  staff: { id: string; full_name: string; employee_id: string } | null; session: { id: string; name: string } | null;
  sessions: SessionOption[]; balances: Balance[]; items: Leave[];
}
export interface StaffLeave { staff: { id: string; full_name: string; employee_id: string; status: string }; session: { id: string; name: string } | null; balances: Balance[]; items: Leave[] }
export interface StaffMember { id: string; full_name: string; employee_id: string; subject: string | null; joining_date: string; has_login: boolean }
export interface BalanceCell { teacher_id: string; leave_type_id: string; allowance: string | null; overridden: boolean; used: string; pending: string }
export interface BalanceMatrix {
  session: { id: string; name: string } | null;
  types: { id: string; name: string; code: string; annual_days: string | null; is_paid: boolean }[];
  staff: (StaffMember & { balances: Record<string, BalanceCell> })[];
}

// ------------------------------------------------------------------ settings, holidays, attendance
export interface HrSettings { weekly_offs: number[]; lop_basis: "working_days" | "calendar_days"; unmarked_as: "present" | "absent" }
export interface Holiday { id: string; holiday_on: string; name: string }
export const WEEKDAYS: [number, string][] = [[1, "Monday"], [2, "Tuesday"], [3, "Wednesday"], [4, "Thursday"], [5, "Friday"], [6, "Saturday"], [7, "Sunday"]];

export type AttendanceStatus = "present" | "absent" | "half_day";
export const ATTENDANCE_LABEL: Record<AttendanceStatus, string> = { present: "Present", absent: "Absent", half_day: "Half day" };
export interface AttendanceRow {
  teacher_id: string; full_name: string; employee_id: string; joining_date: string; status: AttendanceStatus | null; note: string | null;
  leave_id: string | null; leave_code: string | null; leave_type: string | null; leave_half_day: boolean | null; leave_paid: boolean | null;
}
export interface AttendanceDay { date: string; working: boolean; holiday: string | null; locked: boolean; future: boolean; items: AttendanceRow[] }
export interface AttendanceMonth { month: string; items: { teacher_id: string; full_name: string; employee_id: string; present_days: number; absent_days: number; half_days: number }[] }

// ------------------------------------------------------------------ payroll
export type Calc = "fixed" | "percent_basic";
export interface Component { id: string; name: string; kind: "earning" | "deduction"; calc: Calc; default_value: string; is_active: boolean; display_order: number; used: number }
export interface StructureItem { structure_id: string; component_id: string; name: string; kind: "earning" | "deduction"; calc: Calc; value: string; amount: string }
export interface Structure { id: string; effective_from: string; basic: string; note: string | null; created_at: string; locked: boolean; items: StructureItem[]; gross: string; deductions: string; net: string }
export interface SalaryStaff { id: string; full_name: string; employee_id: string; subject: string | null; joining_date: string; structure_id: string | null; effective_from: string | null; basic: string | null; gross?: string; net?: string }
export interface StaffSalary {
  staff: { id: string; full_name: string; employee_id: string; subject: string | null; joining_date: string; status: string };
  structures: Structure[];
  payslips: { id: string; month: string; gross_earned: string; total_deductions: string; adjustments_total: string; net_pay: string; lop_days: string; status: RunStatus; run_id: string }[];
}

export type RunStatus = "draft" | "finalized" | "paid";
export const RUN_STATUS_LABEL: Record<RunStatus, string> = { draft: "Draft", finalized: "Finalized", paid: "Paid" };
export type PaymentMode = "bank_transfer" | "cheque" | "cash" | "upi";
export const PAYMENT_MODE_LABEL: Record<PaymentMode, string> = { bank_transfer: "Bank transfer", cheque: "Cheque", cash: "Cash", upi: "UPI" };
export interface Run {
  id: string; month: string; status: RunStatus; generated_at: string; finalized_at: string | null; finalized_by_name: string | null;
  paid_on: string | null; payment_mode: PaymentMode | null; payment_reference: string | null; reopen_note: string | null;
  staff: number; gross: string; deductions: string; adjustments: string; net: string; lop: string;
}
export interface SlipRow {
  id: string; teacher_id: string; employee_id: string; staff_name: string; basic: string; gross_full: string; gross_earned: string;
  lop_days: string; lop_amount: string; total_deductions: string; adjustments_total: string; net_pay: string; working_days: number;
  present_days: string; absent_days: string; half_days: string; paid_leave_days: string; unpaid_leave_days: string; unmarked_days: string; not_joined_days: string;
}
export interface RunDetail extends Run {
  payslips: SlipRow[]; month_end: string; can_finalize_from: string; without_salary: { id: string; full_name: string; employee_id: string }[]; pending_leave: number;
}
export interface Adjustment { id: string; label: string; amount: string; created_at: string; created_by_name: string | null }
export interface Payslip extends SlipRow {
  run_id: string; month: string; structure_id: string | null; earnings: { name: string; full: number; earned: number }[]; deductions: { name: string; amount: number }[];
  calendar_days: number; basis_days: number; run_status: RunStatus; paid_on: string | null; payment_mode: PaymentMode | null;
  subject: string | null; joining_date: string | null; adjustments: Adjustment[];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-09-01" -> "September 2026". */
export function monthName(iso: string): string {
  const [y, m] = iso.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
}
/** "2.5" -> "2½", "1" -> "1", "0" -> "0" (days). */
export function days(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  const whole = Math.trunc(n);
  return n - whole === 0.5 ? `${whole === 0 ? "" : whole}½` : String(n);
}
export const plural = (n: number | string, word: string) => `${days(n)} ${word}${Number(n) === 1 ? "" : "s"}`;
