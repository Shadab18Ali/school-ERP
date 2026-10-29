export type VehicleType = "bus" | "mini_bus" | "van" | "car" | "other";
export type VehicleStatus = "active" | "maintenance" | "retired";
export type StaffRole = "driver" | "attendant";
export type Trip = "both" | "pickup" | "drop";
export type Frequency = "monthly" | "quarterly" | "half_yearly" | "yearly";
export type AssignState = "current" | "future" | "ended" | "all";

export const VEHICLE_TYPE_LABEL: Record<VehicleType, string> = { bus: "Bus", mini_bus: "Mini bus", van: "Van", car: "Car", other: "Other" };
export const VEHICLE_STATUS_LABEL: Record<VehicleStatus, string> = { active: "In service", maintenance: "In maintenance", retired: "Retired" };
export const TRIP_LABEL: Record<Trip, string> = { both: "Pickup and drop", pickup: "Pickup only", drop: "Drop only" };
export const FREQUENCY_LABEL: Record<Frequency, string> = { monthly: "a month", quarterly: "a quarter", half_yearly: "a half-year", yearly: "a year" };
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const VEHICLE_DOCS = [
  ["registration_certificate", "Registration certificate (RC)"], ["insurance", "Insurance"], ["pollution_certificate", "Pollution certificate (PUC)"],
  ["fitness_certificate", "Fitness certificate"], ["permit", "Permit"], ["road_tax", "Road tax"], ["other", "Other"],
] as const;
export const STAFF_DOCS = [
  ["driving_license", "Driving licence"], ["police_verification", "Police verification"], ["medical_certificate", "Medical certificate"],
  ["id_proof", "ID proof"], ["address_proof", "Address proof"], ["other", "Other"],
] as const;

export interface TransportDoc {
  id: string; doc_type: string; label: string; title: string | null; number: string | null; issued_on: string | null; valid_until: string | null;
  file_name: string; mime_type: string; size_bytes: number; created_at: string; uploaded_by_name: string | null; state: "valid" | "expiring" | "expired";
}

export interface Vehicle {
  id: string; registration_number: string; vehicle_type: VehicleType; make_model: string | null; seating_capacity: number;
  manufacture_year: number | null; ownership: "school" | "contracted"; contractor_name: string | null; status: VehicleStatus; notes: string | null;
  routes: number; route_names: string | null; riders: number | null; documents_expired: number; documents_missing: number;
}
export interface VehicleDetail extends Vehicle {
  documents: TransportDoc[]; required_missing: string[];
  route_list: { id: string; name: string; code: string | null; status: string; riders: number }[];
}

export interface Staff {
  id: string; role: StaffRole; full_name: string; phone: string; alternate_phone?: string | null; license_number?: string | null;
  license_valid_until?: string | null; date_of_birth?: string | null; address?: string | null; joined_on?: string | null;
  status: "active" | "inactive"; notes?: string | null; route_names: string | null; documents?: number;
}
export interface StaffDetail extends Omit<Staff, "documents"> { documents: TransportDoc[] }

export interface Zone {
  id: string; name: string; amount: string; frequency: Frequency; billing_months: number[] | null; due_month: number | null;
  is_active: boolean; fee_head: string; stops: number; riders: number;
}

export interface Stop {
  id: string; name: string; landmark: string | null; sequence: number; pickup_time: string | null; drop_time: string | null;
  fare_zone_id: string; fare_zone: string; fare: string; fare_frequency: Frequency; riders: number; used: boolean;
}
export interface Route {
  id: string; name: string; code: string | null; status: "active" | "inactive"; notes: string | null;
  vehicle_id: string | null; registration_number: string | null; vehicle_type: VehicleType | null; seating_capacity: number | null; vehicle_status: VehicleStatus | null;
  driver_id: string | null; driver_name: string | null; driver_phone: string | null; driver_license_valid_until: string | null;
  attendant_id: string | null; attendant_name: string | null; attendant_phone: string | null;
  riders: number; stops: number; first_pickup: string | null;
}
export interface RouteDetail extends Route { stop_list: Stop[] }
export interface RouteSheet extends Route { stop_list: (Stop & { students: Assignment[] })[] }

export interface Assignment {
  id: string; student_id: string; student_name: string; student_code: string; mobile: string; student_status: string; class_section: string | null;
  academic_session_id: string; route_id: string; route_name: string; route_code: string | null; stop_id: string; stop_name: string; stop_sequence: number;
  pickup_time: string | null; drop_time: string | null; fare_zone: string; fare: string; fare_frequency: Frequency; trip: Trip;
  start_date: string; end_date: string | null; charge_fee: boolean; notes: string | null; is_current: boolean;
}
export interface AssignmentList { items: Assignment[]; total: number; page: number; page_size: number }

export interface ComplianceItem { kind: "expired" | "expiring" | "missing"; what: string; owner: string; owner_kind: "vehicle" | "staff"; owner_id: string; date: string | null }

export interface TransportDashboard {
  vehicles: number; vehicles_in_maintenance: number; seats: number; routes: number; stops: number; drivers: number; attendants: number;
  students: number; documents_expired: number; documents_expiring: number; licenses_expiring: number; routes_full: number;
  fees: { billed: string; due_till_now: string; collected: string; overdue: string }; session_name: string | null; compliance: ComplianceItem[];
}

export interface FamilyTrip {
  id: string; start_date: string; end_date: string | null; trip: Trip; charge_fee: boolean; is_current: boolean;
  route_name: string; route_code: string | null; stop_name: string; landmark: string | null; pickup_time: string | null; drop_time: string | null;
  fare_zone: string; fare: string | null; fare_frequency: Frequency; registration_number: string | null; vehicle_type: VehicleType | null;
  driver_name: string | null; driver_phone: string | null; attendant_name: string | null; attendant_phone: string | null;
}
export interface FamilyTransport { current: FamilyTrip | null; upcoming: FamilyTrip[]; history: FamilyTrip[] }

/** "07:10" -> "7:10 am" */
export function clock(t: string | null): string {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** Registration numbers are stored compact (DL1PC1234); show them grouped the usual way (DL 1P C 1234) when they follow it. */
export function showReg(r: string | null): string {
  if (!r) return "—";
  const m = /^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/.exec(r);
  return m ? [m[1], m[2], m[3], m[4]].filter(Boolean).join(" ") : r;
}

export function billingText(z: Pick<Zone, "frequency" | "billing_months" | "due_month">): string {
  if (z.frequency !== "monthly") return `${FREQUENCY_LABEL[z.frequency]}, from ${MONTHS[(z.due_month ?? 1) - 1]}`;
  if (!z.billing_months) return "every month";
  const off = MONTHS.map((_, i) => i + 1).filter((m) => !z.billing_months!.includes(m)).map((m) => MONTHS[m - 1]);
  return `every month except ${off.join(", ")}`;
}
