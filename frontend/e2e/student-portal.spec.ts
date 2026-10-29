import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { accessToken, api, runTag, SCHOOL_A, signIn, assignTeacher } from "./helpers";

test.describe.configure({ mode: "serial" });
const tag = runTag();
const me = `Stu Me ${tag}`;
const classmate = `Stu Mate ${tag}`;
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const ids: Record<string, string> = {};
const pays: Record<string, string> = {};

test.beforeAll(async () => {
  const t = await accessToken("ADMIN_A");
  const post = (path: string, body: unknown) => api(path, t, { method: "POST", school: SCHOOL_A(), body });
  const sessions: { id: string; is_current: boolean }[] = await (await api("/sessions", t, { school: SCHOOL_A() })).json();
  const current = sessions.find((s) => s.is_current)!.id;
  await post("/classes/bulk", { classes: [{ name: "Class 4", display_order: 7 }] });
  const cls = (await (await api(`/classes?session_id=${current}`, t, { school: SCHOOL_A() })).json()).items.find((c: { name: string }) => c.name === "Class 4").id;
  await post("/sections/bulk", { academic_session_id: current, class_ids: [cls], names: ["S"] });
  const sec = (await (await api(`/sections?session_id=${current}&class_id=${cls}`, t, { school: SCHOOL_A() })).json()).items.find((s: { name: string }) => s.name === "S").id;
  for (const [i, n] of [me, classmate].entries()) {
    const st = await (await post("/students", { full_name: n, father_name: "Father", date_of_birth: "2016-06-06", gender: "male", mobile: `96666000${i}${i}`,
      enrollment: { academic_session_id: current, class_id: cls, section_id: sec, admission_number: `${tag}-S${i}`, admission_date: "2026-04-01" } })).json();
    ids[n] = st.id;
  }
  await post("/fee-heads/bulk", { names: ["Tuition Fee"] });
  const head = (await (await api("/fee-heads", t, { school: SCHOOL_A() })).json()).find((h: { name: string }) => h.name === "Tuition Fee").id;
  const existing = (await (await api(`/fee-structures?session_id=${current}`, t, { school: SCHOOL_A() })).json()).items.find((x: { class_id: string }) => x.class_id === cls);
  const fsId = existing?.id ?? (await (await post("/fee-structures", { academic_session_id: current, class_id: cls })).json()).id;
  if (!existing) await post(`/fee-structures/${fsId}/items`, { fee_head_id: head, amount: "700", frequency: "monthly" });
  const acct = await accessToken("ACCOUNTANT_A");
  for (const n of [me, classmate]) {
    const a = await (await api(`/fee-collection/students/${ids[n]}`, acct, { school: SCHOOL_A() })).json();
    const r = await (await api(`/fee-collection/enrollments/${a.enrollment_id}/payments`, acct, { method: "POST", school: SCHOOL_A(),
      body: { idempotency_key: crypto.randomUUID(), payment_date: today, payment_mode: "cash", allocations: [{ due_id: a.dues[0].due_id, amount: a.dues[0].balance }] } })).json();
    pays[n] = r.payment.id;
  }
  await assignTeacher(sec);
  const teacher = await accessToken("TEACHER_A");
  const roster = await (await api(`/attendance/roster?section_id=${sec}&date=${today}`, teacher, { school: SCHOOL_A() })).json();
  await api("/attendance/roster", teacher, { method: "PUT", school: SCHOOL_A(), body: { section_id: sec, date: today,
    entries: roster.students.map((s: { enrollment_id: string; full_name: string }) => ({ enrollment_id: s.enrollment_id, status: s.full_name === me ? "leave" : "present",
      remarks: s.full_name === me ? "sports meet" : null })) } });
  await post("/notices", { title: `Science fair ${tag}`, body: "Projects due Friday.", audience: "students" });
  await post("/notices", { title: `Class 4 drawing ${tag}`, body: "Bring crayons.", audience: "students", class_ids: [cls] });
  await post("/notices", { title: `PTM ${tag}`, body: "Parents only.", audience: "parents" });
});

test.describe("student portal", () => {
  test("admin creates the student's login (and can't use a staff email)", async ({ page }) => {
    await signIn(page, "ADMIN_A", `/students/${ids[me]}`);
    const card = page.getByTestId("student-login-card");
    await card.getByRole("button", { name: "Create login" }).click();
    await card.getByLabel("Student's email").fill(process.env.E2E_TEACHER_A_EMAIL!);
    await card.getByTestId("confirm-student-login").click();
    await expect(card.getByRole("alert")).toContainText("belongs to a teacher account");
    await card.getByLabel("Student's email").fill(process.env.E2E_STUDENT_A_EMAIL!);
    await card.getByTestId("confirm-student-login").click();
    await expect(card).toContainText(process.env.E2E_STUDENT_A_EMAIL!);
  });

  test("the student sees their own profile, attendance, fees, receipts and notices", async ({ page }) => {
    await signIn(page, "STUDENT_A", "/dashboard");
    await expect(page.locator('a[data-testid^="child-"]')).toContainText(me);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "My school record", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: me })).toBeVisible();
    await expect(page.getByTestId("portal-profile")).toContainText(`${tag}-S0`);

    await page.getByRole("tab", { name: "Attendance" }).click();
    await expect(page.getByTestId("portal-attendance")).toContainText("sports meet");

    await page.getByRole("tab", { name: "Fees" }).click();
    await expect(page.getByTestId("portal-payments").getByRole("listitem")).toHaveCount(1);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Download receipt/ }).click()]);
    expect(readFileSync((await download.path())!).subarray(0, 5).toString()).toBe("%PDF-");

    await page.getByRole("tab", { name: "Notices" }).click();
    const list = page.getByTestId("notice-list");
    await expect(list).toContainText(`Science fair ${tag}`);
    await expect(list).toContainText(`Class 4 drawing ${tag}`);
    await expect(list).not.toContainText(`PTM ${tag}`);

    await page.getByRole("tab", { name: "Timetable", exact: true }).click();
    await expect(page.getByTestId("timetable-panel")).toBeVisible(); // real timetable (Phase 15)
    for (const t of ["Homework", "Assignments"]) {
      await page.getByRole("tab", { name: t, exact: true }).click();
      await expect(page.getByTestId("homework-empty")).toBeVisible(); // real lists (Phase 16)
    }
    for (const t of ["Exams", "Results"]) {
      await page.getByRole("tab", { name: t, exact: true }).click();
      await expect(page.getByTestId("exams-empty")).toBeVisible(); // real exams (Phase 17): nothing for this class
    }
  });

  test("nothing about any other student is reachable", async ({ page }) => {
    await signIn(page, "STUDENT_A", `/portal/${ids[classmate]}`);
    await expect(page.getByTestId("access-denied")).toBeVisible();
    await page.goto("/students");
    await expect(page.getByTestId("access-denied")).toBeVisible();

    const s = await accessToken("STUDENT_A");
    expect((await api(`/my/payments/${pays[classmate]}/receipt.pdf`, s, { school: SCHOOL_A() })).status).toBe(404);
    for (const path of [`/portal/children/${ids[classmate]}`, `/portal/children/${ids[me]}`, `/students/${ids[classmate]}`, `/students/${ids[me]}`,
                        `/fee-collection/students/${ids[me]}`, `/fee-payments/${pays[classmate]}/receipt.pdf`, `/attendance/students/${ids[me]}`,
                        "/reports/students", `/students/${ids[me]}/login`, `/students/${ids[me]}/guardians`]) {
      expect((await api(path, s, { school: SCHOOL_A() })).status, path).toBe(403);
    }
    const mine = await (await api("/my", s, { school: SCHOOL_A() })).json();
    expect(mine.full_name).toBe(me);
  });

  test("removing the login removes access", async ({ page }) => {
    const t = await accessToken("ADMIN_A");
    await api(`/students/${ids[me]}/login`, t, { method: "DELETE", school: SCHOOL_A() });
    await signIn(page, "STUDENT_A", "/my");
    await expect(page.getByRole("heading", { level: 1, name: "My school record" })).toBeVisible();
    await expect(page.getByText("No student record is linked to your account yet.")).toBeVisible();
  });
});
