import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { accessToken, api, runTag, SCHOOL_A, SCHOOL_B, signIn, assignTeacher } from "./helpers";

test.describe.configure({ mode: "serial" });
const tag = runTag();
const inr = (v: string | number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(Number(v));
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
let sectionId = "";
let enrollments: { enrollment_id: string; student_id: string; full_name: string }[] = [];
let receipt = "";

test.beforeAll(async () => {
  const t = await accessToken("ADMIN_A");
  const post = (path: string, body: unknown) => api(path, t, { method: "POST", school: SCHOOL_A(), body });
  const sessions: { id: string; is_current: boolean }[] = await (await api("/sessions", t, { school: SCHOOL_A() })).json();
  const current = sessions.find((s) => s.is_current)!.id;
  await post("/classes/bulk", { classes: [{ name: "Class 11", display_order: 14 }] });
  const cls = (await (await api(`/classes?session_id=${current}`, t, { school: SCHOOL_A() })).json()).items.find((c: { name: string }) => c.name === "Class 11").id;
  await post("/sections/bulk", { academic_session_id: current, class_ids: [cls], names: ["A"] });
  sectionId = (await (await api(`/sections?session_id=${current}&class_id=${cls}`, t, { school: SCHOOL_A() })).json()).items[0].id;
  await assignTeacher(sectionId);
  for (const [i, n] of ["Rep Alpha", "Rep Beta", "Rep Gamma"].entries()) {
    await post("/students", { full_name: `${n} ${tag}`, father_name: "Parent", date_of_birth: "2010-03-03", gender: i === 1 ? "female" : "male",
      mobile: `98989000${i}${i}`, enrollment: { academic_session_id: current, class_id: cls, section_id: sectionId, admission_number: `${tag}-R${i}`, admission_date: "2026-04-01" } });
  }
  await post("/fee-heads/bulk", { names: ["Tuition Fee"] });
  const head = (await (await api("/fee-heads", t, { school: SCHOOL_A() })).json()).find((h: { name: string }) => h.name === "Tuition Fee").id;
  const fs = await (await post("/fee-structures", { academic_session_id: current, class_id: cls })).json();
  await post(`/fee-structures/${fs.id}/items`, { fee_head_id: head, amount: "1200", frequency: "monthly" });
  const roster = await (await api(`/attendance/roster?section_id=${sectionId}&date=${today}`, t, { school: SCHOOL_A() })).json();
  enrollments = roster.students;
});

test.describe("dashboard", () => {
  test("KPIs match the database, and change by exactly what is recorded", async ({ page }) => {
    const admin = await accessToken("ADMIN_A");
    const before = await (await api("/dashboard", admin, { school: SCHOOL_A() })).json();

    // record ₹700 today and mark two absences today
    const acct = await accessToken("ACCOUNTANT_A");
    const acc = await (await api(`/fee-collection/students/${enrollments[0].student_id}`, acct, { school: SCHOOL_A() })).json();
    const pay = await (await api(`/fee-collection/enrollments/${acc.enrollment_id}/payments`, acct, {
      method: "POST", school: SCHOOL_A(),
      body: { idempotency_key: crypto.randomUUID(), payment_date: today, payment_mode: "cash", allocations: [{ due_id: acc.dues[0].due_id, amount: "700" }] },
    })).json();
    receipt = pay.payment.receipt_number;
    const teacher = await accessToken("TEACHER_A");
    await api("/attendance/roster", teacher, { method: "PUT", school: SCHOOL_A(), body: { section_id: sectionId, date: today,
      entries: enrollments.map((e, i) => ({ enrollment_id: e.enrollment_id, status: i === 0 ? "present" : "absent" })) } });

    const after = await (await api("/dashboard", admin, { school: SCHOOL_A() })).json();
    expect(Number(after.fees.today) - Number(before.fees.today)).toBe(700);
    expect(after.fees.today_receipts - before.fees.today_receipts).toBe(1);
    expect(Number(after.fees.collected) - Number(before.fees.collected)).toBe(700);
    expect(after.attendance.absent - before.attendance.absent).toBe(2);
    expect(after.attendance.present - before.attendance.present).toBe(1);

    await signIn(page, "ADMIN_A", "/dashboard");
    await expect(page.getByTestId("kpi-students")).toHaveText(after.students.total_students.toLocaleString("en-IN"));
    await expect(page.getByTestId("kpi-classes")).toHaveText(String(after.students.total_classes));
    await expect(page.getByTestId("kpi-today")).toHaveText(inr(after.fees.today));
    await expect(page.getByTestId("kpi-collected")).toHaveText(inr(after.fees.collected));
    await expect(page.getByTestId("kpi-pending")).toHaveText(inr(after.fees.pending));
    await expect(page.getByTestId("kpi-present-absent")).toHaveText(`${after.attendance.present} / ${after.attendance.absent}`);
    for (const title of ["Monthly fee collection", "Attendance trend", "Student enrollment"]) {
      await expect(page.getByRole("figure", { name: title }).locator("svg.recharts-surface").first()).toBeVisible();
    }
    await expect(page.getByRole("figure", { name: "Student enrollment" })).toContainText("Class 11");
  });

  test("each role sees only its blocks", async ({ page }) => {
    await signIn(page, "TEACHER_A", "/dashboard");
    await expect(page.getByTestId("kpi-attendance")).toBeVisible();
    await expect(page.getByTestId("kpi-collected")).toHaveCount(0);
    const acct = await page.context().browser()!.newPage();
    await signIn(acct, "ACCOUNTANT_A", "/dashboard");
    await expect(acct.getByTestId("kpi-today")).toBeVisible();
    await expect(acct.getByTestId("kpi-attendance")).toHaveCount(0);
    await acct.close();
  });
});

test.describe("reports", () => {
  test("student report: search, then CSV / Excel / PDF exports", async ({ page }) => {
    await signIn(page, "ADMIN_A", "/reports?report=students");
    await page.getByLabel("Search").fill(`Rep Beta ${tag}`);
    await expect(page.getByTestId("report-summary")).toContainText("1 row");
    await expect(page.getByTestId("report-table")).toContainText(`${tag}-R1`);

    const grab = async (name: string) => {
      const [d] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name }).click()]);
      return { name: d.suggestedFilename(), bytes: readFileSync((await d.path())!) };
    };
    const csv = await grab("CSV");
    expect(csv.name).toMatch(/^students-\d{8}\.csv$/);
    expect(csv.bytes.toString("utf-8")).toContain(`Rep Beta ${tag}`);
    expect(csv.bytes.toString("utf-8").split("\n")).toHaveLength(3); // header + 1 row + final newline
    const xlsx = await grab("Excel");
    expect(xlsx.name).toMatch(/\.xlsx$/);
    expect(xlsx.bytes.subarray(0, 2).toString()).toBe("PK");
    const pdf = await grab("PDF");
    expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("fee reports: collection by mode, pending fees, payment history", async ({ page }) => {
    await signIn(page, "ACCOUNTANT_A", "/reports?report=fee-collection");
    await page.getByLabel("Group by").selectOption("mode");
    await expect(page.getByTestId("report-table")).toContainText("Cash");
    await expect(page.getByTestId("report-totals")).toContainText("Total");

    await page.getByRole("tab", { name: "Pending fees" }).click();
    await page.getByLabel("Class").selectOption({ label: "Class 11" });
    await expect(page.getByTestId("report-summary")).toContainText("3 rows");
    await expect(page.getByTestId("report-totals")).toBeVisible();

    await page.getByRole("tab", { name: "Payment history" }).click();
    await page.getByLabel("Search").fill(receipt);
    await expect(page.getByTestId("report-summary")).toContainText("1 row");
    await expect(page.getByTestId("report-table")).toContainText("₹700");
  });

  test("attendance report: students below a threshold", async ({ page }) => {
    await signIn(page, "TEACHER_A", "/reports?report=attendance");
    await page.getByLabel("Class").selectOption({ label: "Class 11" });
    await page.getByLabel("From").fill(today);
    await page.getByLabel("To").fill(today); // same day the attendance was marked (robust across midnight)
    await page.getByLabel("Attendance below").selectOption("75");
    await expect(page.getByTestId("report-summary")).toContainText("2 rows"); // the two absent today
    await expect(page.getByTestId("report-table")).not.toContainText("Rep Alpha");
  });

  test("pagination, roles and school isolation", async ({ page }) => {
    const admin = await accessToken("ADMIN_A");
    const p1 = await (await api("/reports/students?page=1&page_size=1", admin, { school: SCHOOL_A() })).json();
    const p2 = await (await api("/reports/students?page=2&page_size=1", admin, { school: SCHOOL_A() })).json();
    expect(p1.total).toBeGreaterThanOrEqual(3);
    expect(p1.rows[0].student_code).not.toBe(p2.rows[0].student_code);
    // "below 75%" means a known low percentage: students with no marked days aren't listed
    const teacherToken = await accessToken("TEACHER_A");
    const classes = await (await api("/classes", teacherToken, { school: SCHOOL_A() })).json();
    const c11 = classes.items.find((c: { name: string }) => c.name === "Class 11").id;
    const empty = await (await api(`/reports/attendance?class_id=${c11}&date_from=2026-04-01&date_to=2026-04-02&below=75`, teacherToken, { school: SCHOOL_A() })).json();
    expect(empty.total).toBe(0);

    await signIn(page, "TEACHER_A", "/reports");
    await expect(page.getByRole("tab", { name: "Attendance" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Payment history" })).toHaveCount(0);
    const [teacher, acct, adminB] = await Promise.all([accessToken("TEACHER_A"), accessToken("ACCOUNTANT_A"), accessToken("ADMIN_B")]);
    expect((await api("/reports/payments", teacher, { school: SCHOOL_A() })).status).toBe(403);
    expect((await api("/reports/attendance", acct, { school: SCHOOL_A() })).status).toBe(403);
    expect((await api("/reports/students?format=csv", teacher, { school: SCHOOL_A() })).status).toBe(200);
    const b = await (await api(`/reports/students?search=${tag}`, adminB, { school: SCHOOL_B() })).json();
    expect(b.total ?? 0).toBe(0); // School B never sees School A's students
    expect((await api("/reports/students", adminB, { school: SCHOOL_A() })).status).toBe(403);
  });
});
