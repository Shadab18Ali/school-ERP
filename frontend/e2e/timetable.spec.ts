import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { accessToken, api, assignTeacher, email, runTag, SCHOOL_A, SCHOOL_B, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });
const tag = runTag();
const [X, Y, Z] = [`X${tag}`, `Y${tag}`, `Z${tag}`]; // three sections of Class 9
const room = `R${tag}`;
const otherTeacher = `Tt Other ${tag}`;
const kid = `Tt Kid ${tag}`;
const sec: Record<string, string> = {};
let teacherA = "";
let teacherB = "";
let kidId = "";

test.beforeAll(async () => {
  const t = await accessToken("ADMIN_A");
  const post = (path: string, body?: unknown) => api(path, t, { method: "POST", school: SCHOOL_A(), body });
  const sessions: { id: string; is_current: boolean }[] = await (await api("/sessions", t, { school: SCHOOL_A() })).json();
  const current = sessions.find((s) => s.is_current)!.id;
  await post("/classes/bulk", { classes: [{ name: "Class 9", display_order: 12 }] });
  const cls = (await (await api(`/classes?session_id=${current}`, t, { school: SCHOOL_A() })).json()).items.find((c: { name: string }) => c.name === "Class 9").id;
  await post("/sections/bulk", { academic_session_id: current, class_ids: [cls], names: [X, Y, Z] });
  for (const s of (await (await api(`/sections?session_id=${current}&class_id=${cls}`, t, { school: SCHOOL_A() })).json()).items) sec[s.name] = s.id;

  // TEACHER_A's record teaches Maths in X and Y (not Z); a second teacher teaches Science in X only
  teacherA = (await (await api("/teachers?search=EMP-E2E-A", t, { school: SCHOOL_A() })).json()).items[0].id;
  await assignTeacher(sec[X], { subject: "Mathematics" });
  await assignTeacher(sec[Y], { subject: "Mathematics" });
  const b = await (await post("/teachers", { full_name: otherTeacher, phone: `9${Date.now().toString().slice(-9)}`,
    email: `tt.${tag.toLowerCase()}@example.com`, joining_date: "2024-06-01", subject: "Science" })).json();
  teacherB = b.id;
  expect((await post(`/teachers/${teacherB}/assignments`, { section_id: sec[X], subject: "Science", is_class_teacher: false })).status).toBe(201);

  // a previous run may have left TEACHER_A timetabled; start from a free week
  const old = await (await api(`/timetable/teachers/${teacherA}`, t, { school: SCHOOL_A() })).json();
  for (const c of old.cells) await api(`/timetable/entries/${c.id}`, t, { method: "DELETE", school: SCHOOL_A() });

  const st = await (await post("/students", { full_name: kid, father_name: "Father", date_of_birth: "2012-02-02", gender: "female", mobile: "9444400011",
    enrollment: { academic_session_id: current, class_id: cls, section_id: sec[X], admission_number: `${tag}-TT`, admission_date: "2026-04-01" } })).json();
  kidId = st.id;
});

test.afterAll(async () => {
  const t = await accessToken("ADMIN_A");
  await api(`/students/${kidId}/login`, t, { method: "DELETE", school: SCHOOL_A() });
  const links = await (await api(`/students/${kidId}/guardians`, t, { school: SCHOOL_A() })).json();
  for (const l of links) await api(`/students/${kidId}/guardians/${l.id}`, t, { method: "DELETE", school: SCHOOL_A() });
});

async function openClass(page: Page, section: string) {
  await page.getByLabel("Class", { exact: true }).selectOption({ label: "Class 9" });
  await page.getByLabel("Section", { exact: true }).selectOption({ label: section });
  await expect(page.getByTestId("timetable-title")).toHaveText(`Class 9 – ${section}`);
}

test("set up the school day and subjects; overlapping periods are refused", async ({ page }) => {
  await signIn(page, "ADMIN_A", "/timetable");
  await expect(page.getByRole("heading", { level: 1, name: "Timetable" })).toBeVisible();
  await page.getByRole("tab", { name: "Setup" }).click();
  await expect(page.getByTestId("periods-table").or(page.getByTestId("generate-day"))).toBeVisible();
  if (await page.getByTestId("generate-day").isVisible()) {
    await page.getByTestId("generate-periods").click(); // defaults: 8 × 40 min from 08:00, lunch after period 4
  }
  const rows = page.getByTestId("periods-table").locator("tbody tr");
  await expect(rows).toHaveCount(9);
  await expect(page.getByTestId("period-row-1")).toContainText("08:00 – 08:40");
  await expect(page.getByTestId("period-row-5")).toContainText("Lunch");
  await expect(page.getByTestId("period-row-6")).toContainText("Period 5");

  await page.getByRole("button", { name: "Add period" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Order").fill("20");
  await d.getByLabel("Starts").fill("08:10");
  await d.getByLabel("Ends").fill("08:30");
  await d.getByTestId("save-period").click();
  await expect(d.getByTestId("period-error")).toHaveText("This overlaps period 1 (08:00 – 08:40).");
  await d.getByRole("button", { name: "Cancel" }).click();

  await page.getByTestId("add-common-subjects").click();
  await expect(page.getByTestId("subject-Mathematics")).toBeVisible();
  await page.getByLabel("Subject name").fill(`Robotics ${tag}`);
  await page.getByLabel("Code").fill(`RB${tag}`);
  await page.getByTestId("add-subject").click();
  await expect(page.getByTestId(`subject-Robotics ${tag}`)).toContainText(`RB${tag}`);
  await page.getByLabel("Subject name").fill(`robotics ${tag}`);
  await page.getByTestId("add-subject").click();
  await expect(page.getByText("A subject with this name already exists.")).toBeVisible();
});

test("fill a class timetable; teacher and room clashes are shown and refused", async ({ page }) => {
  await signIn(page, "ADMIN_A", "/timetable");
  await openClass(page, X);
  await page.getByTestId("slot-1-1").getByRole("button").click();
  const d = page.getByRole("dialog");
  await expect(d.getByRole("heading", { name: "Monday · Period 1" })).toBeVisible();
  await d.getByLabel("Subject").selectOption({ label: "Mathematics" });
  await d.getByLabel("Teacher").selectOption(teacherA);
  await expect(d.getByLabel("Teacher").locator("option")).toHaveCount(3); // "No teacher" + the two teachers assigned to X
  await d.getByLabel("Room").fill(room);
  await expect(d.getByTestId("slot-free")).toBeVisible();
  await d.getByTestId("save-slot").click();
  await expect(d).toHaveCount(0);
  await expect(page.getByTestId("slot-1-1")).toContainText("Mathematics");
  await expect(page.getByTestId("slot-1-1")).toContainText(`E2E Teacher A · ${room}`);

  // Science with the other teacher in Monday period 2, same room is fine at a different time
  await page.getByTestId("slot-1-2").getByRole("button").click();
  await d.getByLabel("Subject").selectOption({ label: "Science" });
  await d.getByLabel("Teacher").selectOption(teacherB);
  await d.getByLabel("Room").fill(room);
  await d.getByTestId("save-slot").click();
  await expect(page.getByTestId("slot-1-2")).toContainText(`${otherTeacher} · ${room}`);

  // Section Y, Monday period 1: TEACHER_A is already in X, and so is the room
  await openClass(page, Y);
  await page.getByTestId("slot-1-1").getByRole("button").click();
  await d.getByLabel("Subject").selectOption({ label: "Mathematics" });
  await d.getByLabel("Teacher").selectOption(teacherA);
  await expect(d.getByTestId("slot-conflicts")).toContainText(`E2E Teacher A is already teaching Class 9 – ${X} in Period 1 on Monday.`);
  await expect(d.getByTestId("save-slot")).toBeDisabled();
  await d.getByLabel("Teacher").selectOption("");
  await d.getByLabel("Room").fill(room.toLowerCase()); // rooms match regardless of case
  await expect(d.getByTestId("slot-conflicts")).toContainText(`Room ${room} is already used by Class 9 – ${X} in Period 1 on Monday.`);
  await expect(d.getByTestId("save-slot")).toBeDisabled();
  await d.getByLabel("Room").fill(`${room}-B`);
  await expect(d.getByTestId("slot-free")).toBeVisible();
  await d.getByTestId("save-slot").click();
  await expect(page.getByTestId("slot-1-1")).toContainText(`${room}-B`);

  // TEACHER_A also teaches Y on Tuesday period 1
  await page.getByTestId("slot-2-1").getByRole("button").click();
  await d.getByLabel("Subject").selectOption({ label: "Mathematics" });
  await d.getByLabel("Teacher").selectOption(teacherA);
  await d.getByTestId("save-slot").click();
  await expect(page.getByTestId("slot-2-1")).toContainText("E2E Teacher A");

  // lunch has no slots to click
  await expect(page.getByTestId("slot-1-5")).toHaveCount(0);

  // Changing a lesson and clearing a slot
  await page.getByTestId("slot-1-1").getByRole("button").click();
  await d.getByLabel("Subject").selectOption({ label: "English" });
  await d.getByTestId("save-slot").click();
  await expect(page.getByTestId("slot-1-1")).toContainText("English");
  await page.getByTestId("slot-1-1").getByRole("button").click();
  await d.getByTestId("clear-slot").click();
  await expect(page.getByTestId("slot-1-1")).not.toContainText("English");
});

test("the database refuses every clash even when the screen is bypassed", async () => {
  const t = await accessToken("ADMIN_A");
  const setup = await (await api("/timetable/setup", t, { school: SCHOOL_A() })).json();
  const p1 = setup.periods.find((p: { period_number: number }) => p.period_number === 1).id;
  const lunch = setup.periods.find((p: { is_break: boolean }) => p.is_break).id;
  const subj = (n: string) => setup.subjects.find((s: { name: string }) => s.name === n).id;
  const entry = (body: Record<string, unknown>) => api("/timetable/entries", t, { method: "POST", school: SCHOOL_A(),
    body: { day_of_week: 1, period_id: p1, subject_id: subj("Hindi"), ...body } });

  // same class, two subjects at once
  let r = await entry({ section_id: sec[X] });
  expect(r.status).toBe(409);
  expect((await r.json()).detail).toBe(`Class 9 – ${X} already has Mathematics in Period 1 on Monday.`);
  // same teacher in two classes at once
  await assignTeacher(sec[Z]);
  r = await entry({ section_id: sec[Z], teacher_id: teacherA });
  expect(r.status).toBe(409);
  expect((await r.json()).detail).toBe(`E2E Teacher A is already teaching Class 9 – ${X} in Period 1 on Monday.`);
  // same room twice
  r = await entry({ section_id: sec[Z], room: ` ${room.toLowerCase()} ` });
  expect(r.status).toBe(409);
  expect((await r.json()).detail).toBe(`Room ${room} is already used by Class 9 – ${X} in Period 1 on Monday.`);
  // a teacher not assigned to the class, and a lesson in the lunch break
  r = await entry({ section_id: sec[Z], teacher_id: teacherB, day_of_week: 4 });
  expect(r.status).toBe(409);
  expect((await r.json()).detail).toBe("That teacher isn't assigned to this class. Assign them under Teachers first.");
  r = await entry({ section_id: sec[Z], period_id: lunch });
  expect(r.status).toBe(409);
  // Z is free again for the access test below
  const admin = await (await api(`/teachers/${teacherA}`, t, { school: SCHOOL_A() })).json();
  const a = admin.assignments.find((x: { section_id: string }) => x.section_id === sec[Z]);
  expect((await api(`/teachers/${teacherA}/assignments/${a.id}`, t, { method: "DELETE", school: SCHOOL_A() })).ok).toBe(true);
});

test("teacher timetable and printable PDFs", async ({ page }) => {
  await signIn(page, "ADMIN_A", "/timetable");
  await page.getByRole("tab", { name: "Teacher timetable" }).click();
  await page.getByLabel("Teacher").selectOption(teacherA);
  const grid = page.getByTestId("teacher-timetable");
  await expect(grid.getByTestId("slot-1-1")).toContainText(`Class 9 – ${X}`);
  await expect(grid.getByTestId("slot-2-1")).toContainText(`Class 9 – ${Y}`);
  await expect(page.getByText("2 lessons a week")).toBeVisible();
  const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByTestId("timetable-pdf").click()]);
  expect(readFileSync((await pdf.path())!).subarray(0, 5).toString()).toBe("%PDF-");

  await page.getByRole("tab", { name: "Class timetable" }).click();
  await openClass(page, X);
  const [pdf2] = await Promise.all([page.waitForEvent("download"), page.getByTestId("timetable-pdf").click()]);
  expect(pdf2.suggestedFilename()).toMatch(/\.pdf$/);
  expect(readFileSync((await pdf2.path())!).subarray(0, 5).toString()).toBe("%PDF-");
  // printing hides the menu and controls
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
  await expect(page.getByTestId("timetable-pdf")).toBeHidden();
  await expect(page.getByTestId("timetable-grid")).toBeVisible();
});

test("teachers see their own week and only their classes' timetables", async ({ page }) => {
  await signIn(page, "TEACHER_A", "/teaching/timetable");
  await expect(page.getByRole("heading", { level: 1, name: "My timetable" })).toBeVisible();
  await expect(page.getByTestId("slot-1-1")).toContainText(`Class 9 – ${X}`);
  await expect(page.getByTestId("slot-2-1")).toContainText(`Class 9 – ${Y}`);
  const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByTestId("timetable-pdf").click()]);
  expect(readFileSync((await pdf.path())!).subarray(0, 5).toString()).toBe("%PDF-");

  await page.goto(`/teaching/${sec[X]}`);
  await page.getByRole("tab", { name: "Timetable", exact: true }).click();
  await expect(page.getByTestId("slot-1-2")).toContainText(otherTeacher); // the whole class week, read-only
  await expect(page.getByTestId("slot-1-2").getByRole("button")).toHaveCount(0);

  await page.goto("/timetable");
  await expect(page.getByRole("tab", { name: "Setup" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Teacher timetable" })).toHaveCount(0);
  await openClass(page, X); // only their own classes are offered (Z is not)
  await expect(page.getByLabel("Section", { exact: true }).locator("option", { hasText: Z })).toHaveCount(0);
  await expect(page.getByTestId("slot-1-1").getByRole("button")).toHaveCount(0);

  const t = await accessToken("TEACHER_A");
  expect((await api(`/timetable/sections/${sec[Z]}`, t, { school: SCHOOL_A() })).status).toBe(404);
  expect((await api(`/timetable/sections/${sec[Z]}/pdf`, t, { school: SCHOOL_A() })).status).toBe(404);
  expect((await api(`/timetable/teachers/${teacherB}`, t, { school: SCHOOL_A() })).status).toBe(403);
  expect((await api("/timetable/entries", t, { method: "POST", school: SCHOOL_A(), body: {} })).status).toBe(403);
});

test("parents and students see only their own class timetable", async ({ page }) => {
  const t = await accessToken("ADMIN_A");
  expect((await api(`/students/${kidId}/login`, t, { method: "PUT", school: SCHOOL_A(), body: { email: email("STUDENT_A") } })).status).toBe(200);
  expect((await api(`/students/${kidId}/guardians`, t, { method: "POST", school: SCHOOL_A(),
    body: { email: email("PARENT_A"), full_name: "E2E Parent A", relationship: "guardian" } })).status).toBe(201);

  await signIn(page, "STUDENT_A", "/my");
  await page.getByRole("tab", { name: "Timetable", exact: true }).click();
  await expect(page.getByTestId("timetable-title")).toHaveText(`Class 9 – ${X}`);
  await expect(page.getByTestId("slot-1-2")).toContainText("Science");
  await expect(page.getByTestId("slot-1-2").getByRole("button")).toHaveCount(0);
  const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByTestId("timetable-pdf").click()]);
  expect(readFileSync((await pdf.path())!).subarray(0, 5).toString()).toBe("%PDF-");
  await page.goto("/timetable");
  await expect(page.getByTestId("access-denied")).toBeVisible();

  const [student, parent, acct, adminB] = await Promise.all([accessToken("STUDENT_A"), accessToken("PARENT_A"), accessToken("ACCOUNTANT_A"), accessToken("ADMIN_B")]);
  expect((await api("/my/timetable", student, { school: SCHOOL_A() })).status).toBe(200);
  expect((await api(`/timetable/sections/${sec[Y]}`, student, { school: SCHOOL_A() })).status).toBe(403);
  expect((await api(`/portal/children/${kidId}/timetable`, parent, { school: SCHOOL_A() })).status).toBe(200);
  expect((await api(`/timetable/sections/${sec[Y]}`, parent, { school: SCHOOL_A() })).status).toBe(403);
  expect((await api(`/timetable/sections/${sec[X]}`, acct, { school: SCHOOL_A() })).status).toBe(200); // office staff may view
  expect((await api("/timetable/check", acct, { method: "POST", school: SCHOOL_A(), body: {} })).status).toBe(403);
  expect((await api(`/timetable/sections/${sec[X]}`, adminB, { school: SCHOOL_B() })).status).toBe(404); // other school

  const page2 = await page.context().browser()!.newPage();
  try {
    await signIn(page2, "PARENT_A", `/portal/${kidId}`);
    await page2.getByRole("tab", { name: "Timetable" }).click();
    await expect(page2.getByTestId("timetable-title")).toHaveText(`Class 9 – ${X}`);
    await expect(page2.getByTestId("slot-1-2")).toContainText("Science");
    await expect(page2.getByTestId("slot-2-1")).toHaveText(""); // Tuesday's lesson is section Y's, not this child's
  } finally { await page2.close(); }
});
