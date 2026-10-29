export type Role = "school_admin" | "accountant" | "teacher" | "parent" | "student" | "librarian";
export type SchoolStatus = "active" | "suspended";

/** Mirrors backend app/core/permissions.py. The server decides; the UI only reflects it. */
export type Permission =
  | "dashboard:view"
  | "students:view"
  | "students:manage"
  | "classes:view"
  | "classes:manage"
  | "fees:view"
  | "fees:collect"
  | "attendance:view"
  | "attendance:mark"
  | "reports:view"
  | "settings:manage"
  | "sessions:view"
  | "sessions:manage"
  | "documents:view"
  | "documents:manage"
  | "fee_structures:view"
  | "fee_structures:manage"
  | "notices:view"
  | "notices:manage"
  | "portal:view"
  | "self:view"
  | "teachers:view"
  | "teachers:manage"
  | "teaching:view"
  | "timetable:view"
  | "timetable:manage"
  | "homework:view"
  | "homework:manage"
  | "exams:view"
  | "exams:manage"
  | "marks:enter"
  | "report_cards:manage"
  | "admissions:view"
  | "admissions:manage"
  | "admissions:fee"
  | "enquiries:view"
  | "enquiries:manage"
  | "payments:refund"
  | "notifications:manage"
  | "library:view"
  | "library:manage"
  | "library:fines"
  | "transport:view"
  | "transport:manage"
  | "inventory:view"
  | "inventory:manage"
  | "leave:self"
  | "hr:manage"
  | "payroll:manage"
  | "certificates:manage"
  | "id_cards:manage"
  | "analytics:students"
  | "analytics:fees"
  | "analytics:admissions"
  | "staff_accounts:manage"
  | "audit:view"
  | "fees:cancel"
  | "platform:schools.manage";

export interface Membership {
  school_id: string;
  school_name: string;
  school_code: string;
  school_status: SchoolStatus;
  roles: Role[];
  permissions: Permission[];
  current_session: CurrentSession | null;
  /** "read_only" once the school's subscription has ended (expired or cancelled); worked out by the database */
  access: "full" | "read_only";
  /** on/off features the school's plan includes; null = no subscription recorded (nothing is limited) */
  features: PlanFeatureKey[] | null;
}

export type PlanFeatureKey = "whatsapp" | "reports" | "analytics" | "ai_assistant" | "website_builder";

export interface CurrentSession {
  id: string;
  name: string;
}

export interface Me {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  is_super_admin: boolean;
  platform_permissions: Permission[];
  memberships: Membership[];
}

export interface School {
  id: string;
  name: string;
  code: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string;
  timezone: string;
  logo_url: string | null;
  postal_code: string | null;
  registration_number: string | null;
  affiliation_board: string | null;
  affiliation_number: string | null;
  udise_code: string | null;
  established_year: number | null;
  status: SchoolStatus;
  created_at: string;
  updated_at: string;
  admin_count: number;
  // in the platform's schools list
  plan_name?: string | null;
  subscription_state?: string | null;
  current_period_end?: string | null;
  trial_ends_at?: string | null;
  students_active?: number | null;
  staff?: number | null;
  max_students?: number | null;
  last_activity_at?: string | null;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface PlatformStats {
  total_schools: number;
  active_schools: number;
  suspended_schools: number;
  total_users: number;
}

export interface CurrentSchool {
  school: School;
  roles: Role[];
  permissions: Permission[];
  is_super_admin: boolean;
  current_session: CurrentSession | null;
}

export interface AcademicSession {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  is_current: boolean;
  is_archived: boolean;
  archived_at: string | null;
  created_at: string;
  usage: { table: string; count: number }[];
}

export interface SchoolAdmin {
  user_id: string;
  full_name: string;
  email: string;
  status: "active" | "disabled";
  added_at: string;
}

export const ROLE_LABELS: Record<Role, string> = {
  school_admin: "School admin",
  accountant: "Accountant",
  teacher: "Teacher",
  parent: "Parent",
  student: "Student",
  librarian: "Librarian",
};

export type RecordStatus = "active" | "inactive" | "deleted";

export interface SectionBrief {
  id: string;
  name: string;
  is_active: boolean;
  capacity: number | null;
  student_count: number;
}

export interface SchoolClass {
  id: string;
  name: string;
  display_order: number;
  is_active: boolean;
  is_deleted: boolean;
  deleted_at: string | null;
  created_at: string;
  sections: SectionBrief[];
  student_count: number;
  capacity_total: number | null;
}

export interface ClassList {
  session: CurrentSession | null;
  session_archived: boolean;
  items: SchoolClass[];
  total_students: number;
}

export interface Section {
  id: string;
  class_id: string;
  class_name: string;
  class_is_active: boolean;
  academic_session_id: string;
  session_name: string;
  name: string;
  capacity: number | null;
  room: string | null;
  is_active: boolean;
  is_deleted: boolean;
  student_count: number;
  created_at: string;
}

export interface BulkResult {
  created: number;
  skipped: string[];
}

export type Gender = "male" | "female" | "other";
export type StudentStatus = "active" | "inactive";

export const GENDER_LABELS: Record<Gender, string> = { male: "Male", female: "Female", other: "Other" };

export interface Enrollment {
  id: string;
  academic_session_id: string;
  session_name: string;
  session_is_current: boolean;
  session_is_archived: boolean;
  class_id: string;
  class_name: string;
  section_id: string;
  section_name: string;
  admission_number: string;
  admission_date: string;
}

export interface StudentListItem {
  id: string;
  student_code: string;
  full_name: string;
  father_name: string | null;
  mother_name: string | null;
  gender: Gender;
  date_of_birth: string;
  mobile: string;
  status: StudentStatus;
  photo_url: string | null;
  enrollment: Enrollment;
}

export interface StudentList extends Paginated<StudentListItem> {
  session_id: string | null;
  session_name: string | null;
}

export interface StudentDetail {
  id: string;
  student_code: string;
  full_name: string;
  father_name: string | null;
  mother_name: string | null;
  date_of_birth: string;
  gender: Gender;
  mobile: string;
  alternate_mobile: string | null;
  address: string | null;
  photo_url: string | null;
  status: StudentStatus;
  status_reason: string | null;
  created_at: string;
  updated_at: string;
  enrollments: Enrollment[];
  current_enrollment: Enrollment | null;
}

export type DocumentType =
  | "birth_certificate" | "previous_marksheet" | "transfer_certificate"
  | "address_proof" | "student_id_document" | "other";

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  birth_certificate: "Birth certificate",
  previous_marksheet: "Previous marksheet",
  transfer_certificate: "Transfer certificate",
  address_proof: "Address proof",
  student_id_document: "Student ID document",
  other: "Other",
};

export interface StudentDocument {
  id: string;
  document_type: DocumentType;
  title: string | null;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
  uploaded_by_name: string | null;
}

export type FeeFrequency = "monthly" | "quarterly" | "half_yearly" | "yearly" | "one_time";

export const FREQUENCY_LABELS: Record<FeeFrequency, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  half_yearly: "Half-yearly",
  yearly: "Yearly",
  one_time: "One-time",
};

/** Money arrives from the API as exact decimal strings, e.g. "1500.00". */
export type Money = string;

export interface FeeHead {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  used_in: number;
}

export interface FeeTotals {
  item_count: number;
  annual_compulsory: Money;
  annual_optional: Money;
  monthly_compulsory: Money;
  one_time_compulsory: Money;
}

export interface FeeStructureSummary {
  id: string;
  academic_session_id: string;
  session_name: string;
  session_is_archived: boolean;
  class_id: string;
  class_name: string;
  name: string | null;
  is_active: boolean;
  copied_from_id: string | null;
  totals: FeeTotals;
}

export interface FeeItem {
  id: string;
  fee_head_id: string;
  fee_head_name: string;
  amount: Money;
  frequency: FeeFrequency;
  is_optional: boolean;
  billing_months: number[] | null;
  due_month: number | null;
  sort_order: number;
  occurrences: number;
  annual_amount: Money;
  due_months: string[];
}

export interface ScheduleMonth {
  month: string;
  compulsory: Money;
  optional: Money;
  lines: { fee_item_id: string; fee_head_name: string; amount: Money; is_optional: boolean }[];
}

export interface FeeStructureDetail extends FeeStructureSummary {
  notes: string | null;
  items: FeeItem[];
  schedule: ScheduleMonth[];
}

export interface FeeStructureList {
  session: CurrentSession | null;
  session_archived: boolean;
  items: FeeStructureSummary[];
  classes_without_structure: { id: string; name: string }[];
}

export type PaymentMode = "cash" | "upi" | "bank_transfer" | "cheque" | "other";
export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  cash: "Cash", upi: "UPI", bank_transfer: "Bank transfer", cheque: "Cheque", other: "Other",
};
/** Every mode a receipt can have; "online" receipts come only from the payment gateway. */
export type RecordedMode = PaymentMode | "online";
export const MODE_LABELS: Record<RecordedMode, string> = { ...PAYMENT_MODE_LABELS, online: "Online payment" };
export const REFERENCE_LABELS: Partial<Record<PaymentMode, string>> = {
  upi: "UPI transaction ID", bank_transfer: "Bank reference (UTR)", cheque: "Cheque number", other: "Reference",
};

export interface FeeTotalsOut { total: Money; paid: Money; outstanding: Money; overdue: Money }

export interface Due {
  due_id: string;
  fee_item_id: string;
  fee_head_name: string;
  frequency: FeeFrequency;
  is_optional: boolean;
  due_month: string;
  amount: Money;
  paid: Money;
  balance: Money;
}

export interface PaymentSummary {
  id: string;
  receipt_number: string;
  payment_date: string;
  amount: Money;
  payment_mode: RecordedMode;
  reference_number: string | null;
  balance_after: Money;
  received_by_name: string | null;
  created_at: string;
  cancelled_at?: string | null; // refunded: the receipt no longer counts
  cancel_reason?: string | null;
}

export interface PaymentDetail extends PaymentSummary {
  remarks: string | null;
  student_id: string;
  student_name: string;
  student_code: string;
  class_section: string;
  admission_number: string;
  session_name: string;
  lines: { fee_head_name: string; due_month: string; frequency: FeeFrequency; amount: Money }[];
}

export interface StudentFeeAccount {
  student_id: string;
  student_name: string;
  student_code: string;
  status: StudentStatus;
  enrollment_id: string | null;
  session_id: string | null;
  session_name: string | null;
  session_is_archived: boolean;
  class_section: string | null;
  admission_number: string | null;
  has_structure: boolean;
  structure_active: boolean;
  totals: FeeTotalsOut;
  dues: Due[];
  optional_fees: { fee_item_id: string; fee_head_name: string; amount: Money; frequency: FeeFrequency; opted_in: boolean }[];
  payments: PaymentSummary[];
}

export interface StudentBalanceRow {
  student_id: string;
  enrollment_id: string;
  student_name: string;
  student_code: string;
  class_section: string;
  admission_number: string;
  status: StudentStatus;
  totals: FeeTotalsOut;
}

export type AttendanceStatus = "present" | "absent" | "leave";
export const ATTENDANCE_LABELS: Record<AttendanceStatus, string> = { present: "Present", absent: "Absent", leave: "Leave" };

export interface AttendanceCounts { present: number; absent: number; leave: number; unmarked: number; percentage: string | null }

export interface RosterStudent {
  enrollment_id: string;
  student_id: string;
  full_name: string;
  student_code: string;
  admission_number: string;
  status: AttendanceStatus | null;
  remarks: string | null;
  updated_at: string | null;
}

export interface Roster {
  section_id: string;
  section_name: string;
  class_name: string;
  session_id: string;
  session_name: string;
  date: string;
  editable: boolean;
  reason: string | null;
  students: RosterStudent[];
  counts: AttendanceCounts;
}

export interface AttendanceTotals {
  enrollment_id: string; student_id: string; full_name: string; student_code: string; admission_number: string;
  present: number; absent: number; leave: number; marked: number; percentage: string | null;
}
export interface AttendanceDay { date: string; present: number; absent: number; leave: number; marked: number; percentage: string | null }

export interface PortalChild {
  student_id: string;
  full_name: string;
  student_code: string;
  relationship: string;
  photo_url: string | null;
  class_section: string | null;
  session_name: string | null;
  attendance_percentage: string | null;
  outstanding: string | null;
}

export interface PortalProfile extends PortalChild {
  date_of_birth: string;
  gender: Gender;
  father_name: string | null;
  mother_name: string | null;
  mobile: string;
  address: string | null;
  admission_number: string | null;
  admission_date: string | null;
  status: StudentStatus;
}

export type NoticeAudience = "everyone" | "parents" | "students" | "staff";
export interface Notice {
  id: string;
  title: string;
  body: string;
  audience: NoticeAudience;
  class_ids: string[] | null;
  class_names: string[];
  is_pinned: boolean;
  publish_at: string;
  expires_at: string | null;
  state: "scheduled" | "live" | "expired";
  created_at: string;
}

export interface Guardian { id: string; user_id: string; full_name: string | null; email: string | null; relationship: string; created_at: string }

export type TeacherStatus = "active" | "inactive";

export interface TeacherSummary {
  id: string;
  employee_id: string;
  full_name: string;
  phone: string;
  email: string;
  qualification: string | null;
  subject: string | null;
  joining_date: string;
  staff_type: "teaching" | "non_teaching";
  designation: string | null;
  status: TeacherStatus;
  photo_url: string | null;
  has_login: boolean;
  assigned_sections: number;
}

export interface TeacherAssignment {
  id: string;
  section_id: string;
  class_id: string;
  class_name: string;
  section_name: string;
  academic_session_id: string;
  session_name: string;
  session_is_current: boolean;
  session_is_archived: boolean;
  subject: string | null;
  is_class_teacher: boolean;
}

export interface TeacherDetail extends TeacherSummary {
  address: string | null;
  status_reason: string | null;
  login: { linked: boolean; email: string | null; library_duty: boolean };
  assignments: TeacherAssignment[];
  created_at: string;
}

export interface MyClass {
  section_id: string;
  class_id: string;
  class_name: string;
  section_name: string;
  session_name: string;
  subjects: string[];
  is_class_teacher: boolean;
  students: number;
  marked_today: number;
  attendance_percentage: string | null;
}

export interface TimetablePeriod { id: string; period_number: number; label: string | null; start_time: string; end_time: string; is_break: boolean; in_use: number }
export interface TimetableCell {
  id: string; day_of_week: number; period_id: string; subject_id: string; subject_name: string; subject_code: string | null;
  teacher_id: string | null; teacher_name: string | null; room: string | null; section_id: string; class_name: string; section_name: string;
}
export interface TimetableGrid {
  kind: "class" | "teacher"; title: string; session_id: string | null; session_name: string | null; session_is_archived: boolean;
  periods: TimetablePeriod[]; days: number[]; cells: TimetableCell[];
}
export interface Subject { id: string; name: string; code: string | null; is_active: boolean; periods_per_week: number }
export const DAY_NAMES: Record<number, string> = { 1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday", 5: "Friday", 6: "Saturday", 7: "Sunday" };

// ---------------------------------------------------------------- Phase 16: homework
export type HomeworkKind = "homework" | "assignment";
export interface HomeworkFile { id: string; file_name: string; mime_type: string; size_bytes: number }
export interface HomeworkSummary {
  id: string; kind: HomeworkKind; title: string; subject_id: string | null; subject_name: string | null; section_id: string;
  class_name: string; section_name: string; due_at: string; max_marks: string | null; allow_late: boolean; teacher_name: string | null;
  created_at: string; attachment_count: number; is_closed: boolean;
}
export interface StaffHomework extends HomeworkSummary { students: number; submitted: number; reviewed: number; can_manage: boolean }
export interface HomeworkDetail extends StaffHomework {
  description: string; session_name: string; session_is_archived: boolean; attachments: HomeworkFile[];
}
export interface HomeworkSubmission {
  id: string; answer: string; submitted_at: string; is_late: boolean; marks: string | null; feedback: string | null;
  reviewed_at: string | null; files: HomeworkFile[];
}
export interface RosterRow {
  student_id: string; full_name: string; admission_number: string; submission_id: string | null; submitted_at: string | null;
  is_late: boolean; marks: string | null; reviewed: boolean; file_count: number;
}
export type HomeworkStatus = "pending" | "submitted" | "late" | "reviewed" | "missing";
export interface StudentHomework extends HomeworkSummary { status: HomeworkStatus; marks: string | null; submitted_at: string | null }
export interface StudentHomeworkDetail extends StudentHomework {
  description: string; attachments: HomeworkFile[]; submission: HomeworkSubmission | null; can_submit: boolean; session_is_archived: boolean;
}
export interface SettableSection { section_id: string; class_name: string; section_name: string; subjects: string[] }

// ---------------------------------------------------------------- Phase 17: exams
export type ExamStatus = "draft" | "scheduled" | "published";
export interface ExamType { id: string; name: string; is_active: boolean; exams: number }
export interface GradeBand { grade: string; min_percentage: string; remark: string | null }
export interface ExamSummary {
  id: string; name: string; status: ExamStatus; type_name: string; results_published_at: string | null; papers: number; classes: number;
  first_date: string | null; last_date: string | null; marks_entered: number; marks_expected: number;
}
export interface ExamPaper {
  id: string; class_id: string; class_name: string; subject_id: string; subject_name: string; exam_date: string; start_time: string;
  end_time: string; max_marks: string; pass_marks: string; entered?: number; students?: number;
}
export interface ExamDetail {
  id: string; name: string; status: ExamStatus; results_published_at: string | null; exam_type_id: string; type_name: string;
  academic_session_id: string; session_name: string; session_is_archived: boolean; session_start: string; session_end: string; papers: ExamPaper[];
  report_card_template_id: string | null;
}
export interface ExamSection { section_id: string; class_id: string; class_name: string; section_name: string; papers: number; students: number; entered: number; expected: number }
export interface MarksRow { enrollment_id: string; student_id: string; full_name: string; admission_number: string; marks: string | null; absent: boolean; entered: boolean }
export interface MarksSheet { exam: ExamDetail; paper: ExamPaper; section: { id: string; label: string }; can_enter: boolean; students: MarksRow[] }
export type ResultStatus = "pass" | "fail" | "incomplete";
export interface SubjectResult {
  subject: string; exam_date: string; max_marks: string; pass_marks: string; marks: string | null; absent: boolean; entered: boolean;
  grade: string | null; passed: boolean | null;
}
export interface StudentExamResult {
  student_id: string; full_name: string; admission_number: string; total: string | null; max_total: string; percentage: string | null;
  grade: string | null; result: ResultStatus; rank: number | null; subjects: SubjectResult[];
}
export interface SectionResults {
  exam: ExamDetail; section: { id: string; label: string }; papers: ExamPaper[];
  summary: { pass: number; fail: number; incomplete: number; students: number; average: string | null; highest: string | null };
  rows: StudentExamResult[];
}
export interface StudentExam extends Omit<ExamDetail, "papers"> {
  papers: ExamPaper[]; result: StudentExamResult | null; out_of?: number; section_id: string; teacher_remarks?: string | null; principal_remarks?: string | null;
}

// ---------------------------------------------------------------- Phase 18: report cards
export interface ReportCardTemplate {
  id: string; name: string; is_default: boolean; has_signature: boolean; exams_using: number;
  layout: "classic" | "modern"; accent_color: string; title: string;
  show_logo: boolean; show_photo: boolean; show_rank: boolean; show_attendance: boolean; show_subject_grades: boolean;
  show_pass_marks: boolean; show_grade_scale: boolean; show_teacher_remarks: boolean; show_principal_remarks: boolean;
  signature_1: string | null; signature_2: string | null; signature_3: string | null; principal_name: string | null; footer_note: string | null;
}
export interface RemarksRow {
  enrollment_id: string; student_id: string; full_name: string; admission_number: string; teacher_remarks: string | null;
  principal_remarks: string | null; percentage: string | null; grade: string | null; result: ResultStatus | null;
}
export interface RemarksSheet { exam: ExamDetail; section: { id: string; label: string }; can_edit_teacher: boolean; can_edit_principal: boolean; students: RemarksRow[] }
