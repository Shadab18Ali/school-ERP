import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { accessToken, api, runTag, SCHOOL_A, SCHOOL_B, signIn } from "./helpers";

/**
 * Analytics, seen through the class filter on a class made only for this test, so every figure is
 * known exactly: 3 students (2 girls, 1 boy) in a 4-seat section, today's attendance 2 present + 1
 * absent, ₹2,000 paid by UPI today, 2 enquiries of which 1 became a student.
 * (Named to run after the specs that build the school's standard classes and fee heads from scratch.)
 */
const tag = runTag();
const className = `AN ${tag}`;
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const inr = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(n);
let classId = "";
let sessionStart = "";

test.beforeAll(async () => {
  const t = await accessToken("ADMIN_A");
  const call = (path: string, method = "GET", body?: unknown) => api(path, t, { method, school: SCHOOL_A(), body });
  const sessions: { id: string; is_current: boolean; start_date: string }[] = await (await call("/sessions")).json();
  const cur = sessions.find((s) => s.is_current)!;
  sessionStart = cur.start_date;
  await call("/classes/bulk", "POST", { classes: [{ name: className, display_order: 40 }] });
  classId = (await (await call(`/classes?session_id=${cur.id}`)).json()).items.find((c: { name: string }) => c.name === className).id;
  await call("/sections/bulk", "POST", { academic_session_id: cur.id, class_ids: [classId], names: ["A"] });
  const section = (await (await call(`/sections?session_id=${cur.id}&class_id=${classId}`)).json()).items[0].id;
  expect((await call(`/sections/${section}`, "PATCH", { capacity: 4 })).status).toBe(200);
  for (const [i, [n, g]] of [["Meera", "female"], ["Tara", "female"], ["Vivek", "male"]].entries()) {
    const r = await call("/students", "POST", { full_name: `${n} ${tag}`, father_name: "Parent", date_of_birth: "2015-02-02", gender: g,
      mobile: `96${String(Date.now()).slice(-6)}${i}${i}`.slice(0, 10), enrollment: { academic_session_id: cur.id, class_id: classId, section_id: section, admission_number: `${tag}-A${i}`, admission_date: cur.start_date } });
    expect(r.status, await r.clone().text()).toBe(201);
  }
  // its own fee head (other specs expect the school's standard heads not to exist yet)
  await call("/fee-heads/bulk", "POST", { names: [`AN Fee ${tag}`] });
  const head = (await (await call("/fee-heads")).json()).find((h: { name: string }) => h.name === `AN Fee ${tag}`).id;
  const fs = await (await call("/fee-structures", "POST", { academic_session_id: cur.id, class_id: classId })).json();
  await call(`/fee-structures/${fs.id}/items`, "POST", { fee_head_id: head, amount: "1000", frequency: "monthly" });

  const roster = await (await call(`/attendance/roster?section_id=${section}&date=${today}`)).json();
  await call("/attendance/roster", "PUT", { section_id: section, date: today,
    entries: roster.students.map((s: { enrollment_id: string }, i: number) => ({ enrollment_id: s.enrollment_id, status: i === 2 ? "absent" : "present" })) });

  const acct = await accessToken("ACCOUNTANT_A");
  const acc = await (await api(`/fee-collection/students/${roster.students[0].student_id}`, acct, { school: SCHOOL_A() })).json();
  const pay = await api(`/fee-collection/enrollments/${acc.enrollment_id}/payments`, acct, { method: "POST", school: SCHOOL_A(),
    body: { idempotency_key: crypto.randomUUID(), payment_date: today, payment_mode: "upi", reference_number: `UPI${tag}`,
      allocations: acc.dues.slice(0, 2).map((d: { due_id: string }) => ({ due_id: d.due_id, amount: "1000" })) } });
  expect(pay.status, await pay.clone().text()).toBe(201);

  for (const [i, status] of ["new", "admitted"].entries()) {
    const e = await (await api("/enquiries", acct, { method: "POST", school: SCHOOL_A(), body: {
      parent_name: `Enq Parent ${i}`, student_name: `Enq Child ${tag} ${i}`, phone: `95${String(Date.now()).slice(-7)}${i}`, class_id: classId, source: i ? "website" : "walk_in" } })).json();
    if (status !== "new") await api(`/enquiries/${e.id}`, acct, { method: "PATCH", school: SCHOOL_A(), body: { status } });
  }
});

async function chooseClass(page: Page) {
  await page.getByTestId("filter-class").selectOption({ label: className });
}

test("students tab: enrollment, class strength, attendance — exact for the class, with table view and CSV", async ({ page }) => {
  await signIn(page, "ADMIN_A", "/analytics");
  await expect(page.getByRole("heading", { level: 1, name: "Analytics" })).toBeVisible();
  await expect(page.getByTestId("analytics-students")).toBeVisible();
  await chooseClass(page);
  await expect(page).toHaveURL(new RegExp(`class=${classId}`));
  await expect(page.getByTestId("kpi-students")).toContainText("3");
  await expect(page.getByTestId("kpi-students")).toContainText("2 girls · 1 boy");
  await expect(page.getByTestId("kpi-new")).toContainText("3");
  await expect(page.getByTestId("kpi-fill")).toContainText("75%");

  // the chart's figures as a table, and the same table as CSV
  await page.getByTestId("chart-strength-table").click();
  const row = page.getByTestId("chart-strength").getByRole("row", { name: new RegExp(className) });
  await expect(row).toContainText("3");
  await expect(row).toContainText("75%");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("chart-strength-csv").click()]);
  expect(download.suggestedFilename()).toBe("students-in-each-class.csv");
  const csv = await readFile(await download.path(), "utf8");
  expect(csv).toContain("Class,Students,Girls,Boys,Other,Sections,Seats,Filled");
  expect(csv).toContain(`${className},3,2,1,0,1,4,75`);

  // today's attendance for the class: 2 of 3 present
  await page.getByTestId("filter-period").selectOption("custom");
  await page.getByTestId("filter-from").fill(today);
  await page.getByTestId("filter-to").fill(today);
  await expect(page.getByTestId("kpi-attendance")).toContainText("66.7%");
  await expect(page.getByTestId("kpi-below75")).toContainText("1");
});

test("fees tab: collected, outstanding and methods match the reports", async ({ page }) => {
  await signIn(page, "ADMIN_A", `/analytics?tab=fees&class=${classId}`);
  await expect(page.getByTestId("analytics-fees")).toBeVisible();
  await expect(page.getByTestId("kpi-collected")).toContainText("₹2K");
  await expect(page.getByTestId("kpi-collected")).toContainText("₹2,000 · 1 receipt");

  const t = await accessToken("ADMIN_A");
  const pending = await (await api(`/reports/pending-fees?class_id=${classId}`, t, { school: SCHOOL_A() })).json();
  await expect(page.getByTestId("kpi-outstanding")).toContainText(`${inr(Number(pending.totals.outstanding))} · 3 students`);

  await page.getByTestId("chart-methods-table").click();
  await expect(page.getByTestId("chart-methods").getByRole("row", { name: /UPI/ })).toContainText("₹2,000");

  // a period without the payment
  await page.getByTestId("filter-period").selectOption("custom");
  await page.getByTestId("filter-from").fill(sessionStart);
  await page.getByTestId("filter-to").fill(sessionStart);
  if (sessionStart !== today) await expect(page.getByTestId("kpi-collected")).toContainText("₹0");
  await expect(page.getByTestId("analytics-scope")).toContainText("–");
});

test("admissions tab: enquiries and conversion for the class", async ({ page }) => {
  await signIn(page, "ADMIN_A", `/analytics?tab=admissions&class=${classId}`);
  await expect(page.getByTestId("analytics-admissions")).toBeVisible();
  await expect(page.getByTestId("kpi-enquiries")).toContainText("2");
  await expect(page.getByTestId("kpi-admissions")).toContainText("3");
  await expect(page.getByTestId("kpi-conversion")).toContainText("50%");
  await page.getByTestId("chart-sources-table").click();
  await expect(page.getByTestId("chart-sources").getByRole("row", { name: /Website/ })).toContainText("100%");
});

test("who sees what: accountant gets fees and admissions only; teacher, parent and other schools are refused", async ({ page }) => {
  await signIn(page, "ACCOUNTANT_A", "/analytics?tab=students");
  await expect(page.getByTestId("analytics-tab-students")).toHaveCount(0);
  await expect(page.getByTestId("analytics-tab-fees")).toBeVisible();
  await expect(page.getByTestId("analytics-tab-admissions")).toBeVisible();
  await expect(page.getByTestId("analytics-fees")).toBeVisible();   // fell back to a tab they may see

  const acct = await accessToken("ACCOUNTANT_A");
  expect((await api("/analytics/students", acct, { school: SCHOOL_A() })).status).toBe(403);
  for (const who of ["TEACHER_A", "PARENT_A", "STUDENT_A"] as const) {
    const tk = await accessToken(who);
    for (const tab of ["students", "fees", "admissions"]) expect((await api(`/analytics/${tab}`, tk, { school: SCHOOL_A() })).status, `${who} ${tab}`).toBe(403);
  }
  const adminB = await accessToken("ADMIN_B");
  expect((await api("/analytics/fees", adminB, { school: SCHOOL_A() })).status).toBe(403);
  expect((await api(`/analytics/fees?class_id=${classId}`, adminB, { school: SCHOOL_B() })).status).toBe(404);

});

test("a teacher can't open analytics", async ({ page }) => {
  await signIn(page, "TEACHER_A", "/analytics");
  await expect(page.getByTestId("access-denied")).toBeVisible();
});
