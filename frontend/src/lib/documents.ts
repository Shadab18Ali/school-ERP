/** Certificates, ID cards and their shared settings (Phase 27). Access: school admins (enforced by the API and RLS). */

export type CertificateKind = "bonafide" | "character" | "transfer" | "study" | "custom";
export const CERTIFICATE_KINDS: CertificateKind[] = ["bonafide", "character", "transfer", "study", "custom"];
export const KIND_LABEL: Record<CertificateKind, string> = {
  bonafide: "Bonafide", character: "Character", transfer: "Transfer (TC)", study: "Study", custom: "Custom",
};
export const KIND_HINT: Record<CertificateKind, string> = {
  bonafide: "The student studies here now (passport, bank, scholarship …).",
  character: "Conduct and character, usually when a student leaves.",
  transfer: "When a student leaves the school. One valid TC per student.",
  study: "Classes and years the student studied here.",
  custom: "Anything else: sports, participation, merit …",
};

export interface TemplateField { key: string; label: string; type: "text" | "date"; required: boolean }

export interface CertificateTemplate {
  id: string;
  kind: CertificateKind;
  kind_label: string;
  name: string;
  title: string;
  prefix: string;
  body: string;
  fields: TemplateField[];
  show_logo: boolean;
  show_photo: boolean;
  show_qr: boolean;
  is_active: boolean;
  issued_count: number;
}

export interface Placeholder { key: string; label: string }

export interface Certificate {
  id: string;
  certificate_number: string;
  kind: CertificateKind;
  kind_label: string;
  title: string;
  body: string;
  template_name: string;
  student_id: string;
  student_name: string;
  student_code: string;
  class_section: string | null;
  session_name: string | null;
  purpose: string | null;
  issued_on: string;
  signatory_name: string | null;
  signatory_title: string;
  status: "issued" | "revoked";
  revoked_at: string | null;
  revoke_reason: string | null;
  issued_by_name: string | null;
  created_at: string;
  verify_url: string;
}

export interface CertificateList { items: Certificate[]; total: number; page: number; page_size: number }

export interface DocumentSettings {
  principal_name: string | null;
  signatory_title: string;
  place: string | null;
  accent_color: string;
  card_valid_until: string | null;
  card_back_note: string | null;
  has_signature: boolean;
  school_name: string;
  has_logo: boolean;
  default_card_valid_until: string | null;
}

export type HolderKind = "student" | "teacher" | "staff";
export const HOLDER_LABEL: Record<HolderKind, string> = { student: "Students", teacher: "Teachers", staff: "Staff" };

export interface CardPerson {
  id: string;
  name: string;
  number: string | null;
  detail: string | null;
  has_photo: boolean;
  card: { id: string; card_number: string; valid_until: string; issued_on: string } | null;
}
export interface CardPeople { items: CardPerson[]; total: number; page: number; page_size: number }

export type CardStatus = "active" | "replaced" | "revoked" | "expired";
export const CARD_STATUS_LABEL: Record<CardStatus, string> = { active: "Valid", replaced: "Replaced", revoked: "Revoked", expired: "Expired" };

export interface IdCard {
  id: string;
  holder_kind: HolderKind;
  kind_label: string;
  holder_id: string;
  holder_name: string;
  detail: string | null;
  card_number: string;
  valid_until: string;
  issued_on: string;
  status: CardStatus;
  revoke_reason: string | null;
  revoked_at: string | null;
  issued_by_name: string | null;
}
export interface IdCardList { items: IdCard[]; total: number; page: number; page_size: number }

/** What the public verification page receives (deliberately minimal). */
export interface VerifiedDocument {
  type: "certificate" | "id_card";
  kind: string;
  title?: string;
  number: string;
  name: string;
  detail: string | null;
  issued_on: string;
  valid_until?: string;
  school: string;
  city: string | null;
  status: "valid" | "revoked" | "replaced" | "expired";
  revoked_on?: string | null;
}

/** Splits wording into the pieces shown in the editor preview: {{key}} chips and plain text. */
export function placeholderParts(body: string): { text: string; key?: string }[] {
  const out: { text: string; key?: string }[] = [];
  const re = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
  let last = 0;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m.index > last) out.push({ text: body.slice(last, m.index) });
    out.push({ text: m[0], key: m[1] });
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push({ text: body.slice(last) });
  return out;
}
