import { crc32, deflateSync } from "node:zlib";
import { expect, type Page } from "@playwright/test";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Run backend/scripts/create_test_accounts.py first (see README).`);
  return v;
}

export const PASSWORD = () => required("E2E_PASSWORD");
export const API_URL = () => (process.env.E2E_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/+$/, "");
export const SCHOOL_A = () => required("E2E_SCHOOL_A_ID");
export const SCHOOL_B = () => required("E2E_SCHOOL_B_ID");
/** a school only the subscription-billing tests use (its subscription may end, making it read-only) */
export const SCHOOL_C = () => required("E2E_SCHOOL_C_ID");

export type Account = "SUPER" | "ADMIN_A" | "ACCOUNTANT_A" | "TEACHER_A" | "PARENT_A" | "STUDENT_A" | "LIBRARIAN_A" | "ADMIN_B" | "ADMIN_C";
export const email = (who: Account) => required(`E2E_${who}_EMAIL`);

export async function signIn(page: Page, who: Account, path = "/dashboard") {
  await page.goto(path === "/dashboard" ? "/login" : path);
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email").fill(email(who));
  await page.getByLabel("Password").fill(PASSWORD());
  await page.getByTestId("sign-in").click();
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByTestId("user-menu")).toBeVisible();
}

/** Access token straight from Supabase Auth, for API-level checks. */
export async function accessToken(who: Account): Promise<string> {
  const url = required("NEXT_PUBLIC_SUPABASE_URL").replace(/\/+$/, "");
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: required("NEXT_PUBLIC_SUPABASE_ANON_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ email: email(who), password: PASSWORD() }),
  });
  if (!res.ok) throw new Error(`Sign-in for ${who} failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token as string;
}

export async function api(path: string, token: string, init: { method?: string; school?: string; body?: unknown } = {}) {
  return fetch(`${API_URL()}/api/v1${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.school ? { "X-School-Id": init.school } : {}),
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

/** A unique tag per test run, for names that must not collide. */
export const runTag = () => Date.now().toString(36).slice(-5).toUpperCase();

/** Builds a real PNG (solid colour) without extra dependencies. */
export function png(width = 64, height = 64): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x2f)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}


/** A small, valid one-page PDF (correct xref offsets), built without dependencies. */
export function minimalPdf(): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// ---------------------------------------------------------------- Phase 14
// Teachers reach only the sections assigned to them. The seed gives TEACHER_A a
// staff record (EMP-E2E-A); tests assign it the sections they need, through the API.
let teacherRecordId: string | null = null;

export async function assignTeacher(sectionId: string, opts: { subject?: string; classTeacher?: boolean } = {}) {
  const t = await accessToken("ADMIN_A");
  if (!teacherRecordId) {
    const list = await (await api("/teachers?search=EMP-E2E-A", t, { school: SCHOOL_A() })).json();
    teacherRecordId = list.items.find((x: { employee_id: string }) => x.employee_id === "EMP-E2E-A").id;
  }
  const res = await api(`/teachers/${teacherRecordId}/assignments`, t, {
    method: "POST", school: SCHOOL_A(),
    body: { section_id: sectionId, subject: opts.subject ?? null, is_class_teacher: !!opts.classTeacher },
  });
  if (res.status !== 201 && res.status !== 409) throw new Error(`assignTeacher failed: ${res.status} ${await res.text()}`);
}

export async function assignTeacherForStudent(studentId: string) {
  const t = await accessToken("ADMIN_A");
  const s = await (await api(`/students/${studentId}`, t, { school: SCHOOL_A() })).json();
  await assignTeacher(s.current_enrollment.section_id);
}

export async function assignTeacherForClass(className: string) {
  const t = await accessToken("ADMIN_A");
  const classes = await (await api("/classes", t, { school: SCHOOL_A() })).json();
  const c = classes.items.find((x: { name: string }) => x.name === className);
  await assignTeacher(c.sections[0].id);
}
