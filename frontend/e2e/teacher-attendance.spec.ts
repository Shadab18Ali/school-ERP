import { expect, test } from "@playwright/test";
import { accessToken, api, runTag, SCHOOL_A, SCHOOL_B, signIn, assignTeacher } from "./helpers";

test.describe.configure({ mode: "serial" });
const tag = runTag();
const names = [`Att One ${tag}`, `Att Two ${tag}`, `Att Three ${tag}`];
let sectionId = "";
let studentTwo = "";

test.beforeAll(async () => {
  const t = await accessToken("ADMIN_A");
  const post = (path: string, body: unknown) => api(path, t, { method: "POST", school: SCHOOL_A(), body });
  const sessions: { id: string; is_current: boolean }[] = await (await api("/sessions", t, { school: SCHOOL_A() })).json();
  const current = sessions.find((s) => s.is_current)!.id;
  await post("/classes/bulk", { classes: [{ name: "Class 7", display_order: 10 }] });
  const cls = (await (await api(`/classes?session_id=${current}`, t, { school: SCHOOL_A() })).json()).items.find((c: { name: string }) => c.name === "Class 7").id;
  await post("/sections/bulk", { academic_session_id: current, class_ids: [cls], names: ["A"] });
  sectionId = (await (await api(`/sections?session_id=${current}&class_id=${cls}`, t, { school: SCHOOL_A() })).json()).items[0].id;
  await assignTeacher(sectionId);
  for (const [i, n] of names.entries()) {
    const st = await (await post("/students", {
      full_name: n, father_name: "Parent", date_of_birth: "2017-02-02", gender: i % 2 ? "female" : "male", mobile: `981230000${i}`,
      enrollment: { academic_session_id: current, class_id: cls, section_id: sectionId, admission_number: `${tag}-A${i + 1}`, admission_date: "2026-04-01" },
    })).json();
    if (i === 1) studentTwo = st.id;
  }
});


test.describe("attendance (teacher)", () => {
  test("mark a class: all present, then exceptions; saving is ONE request", async ({ page }) => {
    await signIn(page, "TEACHER_A", "/attendance");
    await expect(page.getByRole("heading", { level: 1, name: "Mark attendance" })).toBeVisible();
    await page.getByLabel("Class").selectOption({ label: "Class 7" });
    await page.getByLabel("Date").fill("2026-07-01");
    await expect(page.getByRole("heading", { level: 2, name: "Class 7 – A · 1 Jul 2026" })).toBeVisible();
    await expect(page.getByTestId("roster").getByRole("listitem")).toHaveCount(3);
    await expect(page.getByTestId("live-counts")).toContainText("3 not marked");

    await page.getByRole("button", { name: "Mark all present" }).click();
    await page.getByLabel(`Absent: ${names[1]}`).check({ force: true });
    await page.getByLabel(`Leave: ${names[2]}`).check({ force: true });
    await page.getByLabel(`Remark for ${names[2]}`).fill("fever");
    await expect(page.getByTestId("live-counts")).toHaveText("1 present · 1 absent · 1 leave");
    await expect(page.getByTestId("unsaved")).toHaveText("3 unsaved");

    const apiCalls: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/api/v1/")) apiCalls.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    await page.getByTestId("save-attendance").click();
    await expect(page.getByText("Attendance saved: 3 new, 0 changed.")).toBeVisible();
    const writes = apiCalls.filter((c) => !c.startsWith("OPTIONS") && !c.startsWith("GET"));
    expect(writes).toEqual(["PUT /api/v1/attendance/roster"]); // the whole class in one request
    expect(apiCalls.filter((c) => c.startsWith("GET"))).toEqual([]); // and no follow-up reloads
  });

  test("saved marks reload; editing sends only the changed student", async ({ page }) => {
    await signIn(page, "TEACHER_A", `/attendance?section=${sectionId}&date=2026-07-01`);
    await expect(page.getByLabel(`Absent: ${names[1]}`)).toBeChecked();
    await expect(page.getByLabel(`Leave: ${names[2]}`)).toBeChecked();
    await expect(page.getByLabel(`Remark for ${names[2]}`)).toHaveValue("fever");

    await page.getByLabel(`Present: ${names[1]}`).check({ force: true });
    await expect(page.getByTestId("unsaved")).toHaveText("1 unsaved");
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/attendance/roster") && r.method() === "PUT"),
      page.getByTestId("save-attendance").click(),
    ]);
    expect(req.postDataJSON().entries).toHaveLength(1);
    await expect(page.getByText("Attendance saved: 0 new, 1 changed.")).toBeVisible();
    await expect(page.getByTestId("live-counts")).toHaveText("2 present · 0 absent · 1 leave");

    // a second day, all present
    await page.getByLabel("Date").fill("2026-07-02");
    await expect(page.getByRole("heading", { level: 2, name: "Class 7 – A · 2 Jul 2026" })).toBeVisible();
    await expect(page.getByTestId("live-counts")).toContainText("3 not marked");
    await page.getByRole("button", { name: "Mark all present" }).click();
    await page.getByTestId("save-attendance").click();
    await expect(page.getByText("Attendance saved: 3 new, 0 changed.")).toBeVisible();
  });

  test("future and out-of-session dates are read-only", async ({ page }) => {
    await signIn(page, "TEACHER_A", `/attendance?section=${sectionId}&date=2099-01-01`);
    await expect(page.getByTestId("readonly-reason")).toHaveText("Attendance can't be marked for a future date.");
    await expect(page.getByTestId("save-attendance")).toHaveCount(0);
    await page.goto(`/attendance?section=${sectionId}&date=2026-03-15`);
    await expect(page.getByTestId("readonly-reason")).toHaveText("That date is outside session 2026-27.");
  });

  test("two saves of the same day at once still leave one record per student", async () => {
    const t = await accessToken("TEACHER_A");
    const roster = await (await api(`/attendance/roster?section_id=${sectionId}&date=2026-07-03`, t, { school: SCHOOL_A() })).json();
    const body = (status: string) => ({ section_id: sectionId, date: "2026-07-03",
      entries: roster.students.map((s: { enrollment_id: string }) => ({ enrollment_id: s.enrollment_id, status })) });
    const [a, b] = await Promise.all([
      api("/attendance/roster", t, { method: "PUT", school: SCHOOL_A(), body: body("present") }),
      api("/attendance/roster", t, { method: "PUT", school: SCHOOL_A(), body: body("absent") }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const after = await (await api(`/attendance/monthly?section_id=${sectionId}&month=2026-07`, t, { school: SCHOOL_A() })).json();
    const day3 = after.days.find((d: { date: string }) => d.date === "2026-07-03");
    expect(day3.marked).toBe(3); // not 6
  });
});

test.describe("attendance reports", () => {
  test("daily, monthly, class and student views", async ({ page }) => {
    await signIn(page, "TEACHER_A", "/attendance/reports");
    await page.getByLabel("Date").fill("2026-07-01");
    const daily = page.getByTestId("daily-Class 7-A");
    await expect(daily).toContainText("3"); // students
    await expect(daily).toContainText("66.7%"); // 2 of 3 present after the edit

    await page.getByRole("tab", { name: "monthly" }).click();
    await page.getByLabel("Class").selectOption({ label: "Class 7" });
    await page.getByLabel("Month").fill("2026-07");
    const three = page.getByTestId(`monthly-${tag}-A3`);
    await expect(three).toContainText("L"); // leave on 1 July
    await expect(page.getByTestId("monthly-grid")).toBeVisible();

    await page.getByRole("tab", { name: "class" }).click();
    await page.getByLabel("From").fill("2026-07-01");
    await page.getByLabel("To").fill("2026-07-02");
    await expect(page.getByTestId("class-overall")).toContainText("2 days marked");
    await expect(page.getByTestId(`class-${tag}-A3`)).toContainText("50.0%"); // leave + present
    await expect(page.getByTestId(`class-${tag}-A1`)).toContainText("100.0%");

    await page.getByRole("link", { name: names[2] }).click();
    await expect(page.getByTestId("student-attendance")).toBeVisible();
    await expect(page.getByTestId("student-attendance")).toContainText("fever");
  });
});

test.describe("attendance: access", () => {
  test("accountants and parents can't mark attendance; other schools are refused", async ({ page }) => {
    await signIn(page, "ACCOUNTANT_A", "/attendance");
    await expect(page.getByTestId("access-denied")).toBeVisible();
    const parent = await page.context().browser()!.newPage();
    await signIn(parent, "PARENT_A", "/attendance");
    await expect(parent.getByTestId("access-denied")).toBeVisible(); // parents see attendance in the portal
    await expect(parent.getByRole("button", { name: "Mark all present" })).toHaveCount(0);
    await parent.close();
    const [acct, adminB] = await Promise.all([accessToken("ACCOUNTANT_A"), accessToken("ADMIN_B")]);
    expect((await api(`/attendance/roster?section_id=${sectionId}&date=2026-07-01`, acct, { school: SCHOOL_A() })).status).toBe(403);
    expect((await api(`/attendance/roster?section_id=${sectionId}&date=2026-07-01`, adminB, { school: SCHOOL_B() })).status).toBe(404);
    expect((await api(`/attendance/students/${studentTwo}`, adminB, { school: SCHOOL_B() })).status).toBe(404);
  });
});
