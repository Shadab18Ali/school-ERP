import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { accessToken, api, runTag, SCHOOL_A, SCHOOL_B, signIn, assignTeacher } from "./helpers";

test.describe.configure({ mode: "serial" });
const tag = runTag();
const mine = `Kid Mine ${tag}`;
const other = `Kid Other ${tag}`;
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const ids: Record<string, string> = {};
const payments: Record<string, string> = {};

test.beforeAll(async () => {
  const t = await accessToken("ADMIN_A");
  const post = (path: string, body: unknown) => api(path, t, { method: "POST", school: SCHOOL_A(), body });
  const sessions: { id: string; is_current: boolean }[] = await (await api("/sessions", t, { school: SCHOOL_A() })).json();
  const current = sessions.find((s) => s.is_current)!.id;
  await post("/classes/bulk", { classes: [{ name: "Class 12", display_order: 15 }] });
  const cls = (await (await api(`/classes?session_id=${current}`, t, { school: SCHOOL_A() })).json()).items.find((c: { name: string }) => c.name === "Class 12").id;
  ids.class = cls;
  await post("/sections/bulk", { academic_session_id: current, class_ids: [cls], names: ["A"] });
  const sec = (await (await api(`/sections?session_id=${current}&class_id=${cls}`, t, { school: SCHOOL_A() })).json()).items[0].id;
  for (const [i, n] of [mine, other].entries()) {
    const st = await (await post("/students", { full_name: n, father_name: "Father", mother_name: "Mother", date_of_birth: "2009-09-09", gender: "female",
      mobile: `97777000${i}${i}`, enrollment: { academic_session_id: current, class_id: cls, section_id: sec, admission_number: `${tag}-K${i}`, admission_date: "2026-04-01" } })).json();
    ids[n] = st.id;
  }
  await post("/fee-heads/bulk", { names: ["Tuition Fee"] });
  const head = (await (await api("/fee-heads", t, { school: SCHOOL_A() })).json()).find((h: { name: string }) => h.name === "Tuition Fee").id;
  const fs = await (await post("/fee-structures", { academic_session_id: current, class_id: cls })).json();
  await post(`/fee-structures/${fs.id}/items`, { fee_head_id: head, amount: "900", frequency: "monthly" });
  const acct = await accessToken("ACCOUNTANT_A");
  for (const n of [mine, other]) {
    const a = await (await api(`/fee-collection/students/${ids[n]}`, acct, { school: SCHOOL_A() })).json();
    const r = await (await api(`/fee-collection/enrollments/${a.enrollment_id}/payments`, acct, { method: "POST", school: SCHOOL_A(),
      body: { idempotency_key: crypto.randomUUID(), payment_date: today, payment_mode: "upi", reference_number: `UTR-${n.slice(4, 8)}`,
        allocations: [{ due_id: a.dues[0].due_id, amount: "900" }] } })).json();
    payments[n] = r.payment.id;
  }
  await assignTeacher(sec);
  const teacher = await accessToken("TEACHER_A");
  const roster = await (await api(`/attendance/roster?section_id=${sec}&date=${today}`, teacher, { school: SCHOOL_A() })).json();
  await api("/attendance/roster", teacher, { method: "PUT", school: SCHOOL_A(), body: { section_id: sec, date: today,
    entries: roster.students.map((s: { enrollment_id: string; full_name: string }) => ({ enrollment_id: s.enrollment_id,
      status: s.full_name === mine ? "absent" : "present", remarks: s.full_name === mine ? "fever" : null })) } });
  await post("/notices", { title: `Parents meeting ${tag}`, body: "Saturday 10 am in the hall.", audience: "parents" });
  await post("/notices", { title: `Class 12 trip ${tag}`, body: "Bring a packed lunch.", audience: "parents", class_ids: [cls] });
  await post("/notices", { title: `Staff briefing ${tag}`, body: "Room 4.", audience: "staff" });
});

test.describe("parent portal", () => {
  test("admin links the parent to ONE child", async ({ page }) => {
    await signIn(page, "ADMIN_A", `/students/${ids[mine]}`);
    const card = page.getByTestId("guardians-card");
    await card.getByRole("button", { name: "Link parent" }).click();
    await card.getByLabel("Parent's email").fill(process.env.E2E_PARENT_A_EMAIL!);
    await card.getByLabel("Parent's name").fill("Parent A");
    await card.getByLabel("Relationship").selectOption("mother");
    await card.getByTestId("confirm-link").click();
    await expect(card).toContainText(process.env.E2E_PARENT_A_EMAIL!);
  });

  test("the parent sees their child's profile, attendance, fees, receipts and notices", async ({ page }) => {
    await signIn(page, "PARENT_A", "/portal");
    await expect(page.getByRole("heading", { level: 1, name: "My children" })).toBeVisible();
    await expect(page.locator('[data-testid^="child-"]').filter({ hasText: tag })).toHaveCount(1);
    await expect(page.getByText(other)).toHaveCount(0);
    await page.getByRole("link", { name: new RegExp(mine) }).click();

    await expect(page.getByRole("heading", { level: 1, name: mine })).toBeVisible();
    await expect(page.getByTestId("portal-profile")).toContainText(`${tag}-K0`);

    await page.getByRole("tab", { name: "Attendance" }).click();
    await expect(page.getByTestId("portal-attendance-pct")).toHaveText("0.0%");
    await expect(page.getByTestId("portal-attendance")).toContainText("fever");

    await page.getByRole("tab", { name: "Fees" }).click();
    await expect(page.getByTestId("portal-fee-total")).toHaveText("₹10,800");
    await expect(page.getByTestId("portal-fee-paid")).toHaveText("₹900");
    await expect(page.getByTestId("portal-fee-pending")).toHaveText("₹9,900");
    await expect(page.getByTestId("portal-payments").getByRole("listitem")).toHaveCount(1);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Download receipt/ }).click()]);
    expect(readFileSync((await download.path())!).subarray(0, 5).toString()).toBe("%PDF-");

    await page.getByRole("tab", { name: "Notices" }).click();
    const notices = page.getByTestId("notice-list");
    await expect(notices).toContainText(`Parents meeting ${tag}`);
    await expect(notices).toContainText(`Class 12 trip ${tag}`); // their child's class
    await expect(notices).not.toContainText(`Staff briefing ${tag}`);

    await page.getByRole("tab", { name: "Timetable" }).click();
    await expect(page.getByTestId("timetable-panel")).toBeVisible(); // real timetable (Phase 15)
    await page.getByRole("tab", { name: "Homework" }).click();
    await expect(page.getByTestId("homework-empty")).toBeVisible(); // real homework list (Phase 16), nothing set yet
    await page.getByRole("tab", { name: "Exam results" }).click();
    await expect(page.getByTestId("exams-empty")).toBeVisible(); // real exams (Phase 17): nothing for this class
  });

  test("another student's information is never reachable", async ({ page }) => {
    await signIn(page, "PARENT_A", `/portal/${ids[other]}`);
    await expect(page.getByText("We couldn't find this child on your account.")).toBeVisible();
    await page.goto("/students");
    await expect(page.getByTestId("access-denied")).toBeVisible();

    const p = await accessToken("PARENT_A");
    for (const path of [`/portal/children/${ids[other]}`, `/portal/children/${ids[other]}/attendance`, `/portal/children/${ids[other]}/fees`,
                        `/portal/children/${ids[other]}/payments/${payments[other]}/receipt.pdf`,
                        `/portal/children/${ids[mine]}/payments/${payments[other]}/receipt.pdf`]) {
      expect((await api(path, p, { school: SCHOOL_A() })).status, path).toBe(404);
    }
    for (const path of [`/students/${ids[other]}`, `/fee-collection/students/${ids[other]}`, `/fee-payments/${payments[other]}/receipt.pdf`,
                        `/attendance/students/${ids[other]}`, `/reports/students`, `/students/${ids[mine]}/guardians`]) {
      expect((await api(path, p, { school: SCHOOL_A() })).status, path).toBe(403);
    }
    expect((await api(`/portal/children/${ids[mine]}`, p, { school: SCHOOL_B() })).status).toBe(403); // not their school
  });

  test("a new notice reaches the parent; scheduled and staff notices don't", async ({ page }) => {
    await signIn(page, "ADMIN_A", "/notices");
    await page.getByRole("button", { name: "New notice" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("Title").fill(`Fee reminder ${tag}`);
    await d.getByLabel("Notice").fill("Please clear pending fees by the 10th.");
    await d.getByLabel("Who can see it").selectOption("parents");
    await d.getByTestId("save-notice").click();
    await expect(page.getByTestId("manage-notices")).toContainText(`Fee reminder ${tag}`);
    const t = await accessToken("ADMIN_A");
    await api("/notices", t, { method: "POST", school: SCHOOL_A(), body: { title: `Future ${tag}`, body: "Later", audience: "parents",
      publish_at: new Date(Date.now() + 86400000 * 3).toISOString() } });

    const parent = await page.context().browser()!.newPage();
    await signIn(parent, "PARENT_A", "/notices");
    await expect(parent.getByTestId("notice-list")).toContainText(`Fee reminder ${tag}`);
    await expect(parent.getByTestId("notice-list")).not.toContainText(`Future ${tag}`);
    await expect(parent.getByTestId("notice-list")).not.toContainText(`Staff briefing ${tag}`);
    await expect(parent.getByRole("button", { name: "New notice" })).toHaveCount(0);
    await parent.close();
  });

  test("unlinking removes access immediately", async ({ page }) => {
    const t = await accessToken("ADMIN_A");
    const links = await (await api(`/students/${ids[mine]}/guardians`, t, { school: SCHOOL_A() })).json();
    await api(`/students/${ids[mine]}/guardians/${links[0].id}`, t, { method: "DELETE", school: SCHOOL_A() });
    await signIn(page, "PARENT_A", "/portal");
    await expect(page.getByText("No children linked yet")).toBeVisible();
    expect((await api(`/portal/children/${ids[mine]}`, await accessToken("PARENT_A"), { school: SCHOOL_A() })).status).toBe(404);
  });
});
