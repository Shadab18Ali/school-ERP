import { expect, test } from "@playwright/test";
import { accessToken, api, assignTeacher, png, runTag, SCHOOL_A, SCHOOL_B, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });
const tag = runTag();
const mine = [`Tch Mine One ${tag}`, `Tch Mine Two ${tag}`];
const other = `Tch Other ${tag}`;
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const ids: Record<string, string> = {};
let mySection = "";
let otherSection = "";
let newTeacherId = "";

test.beforeAll(async () => {
  const t = await accessToken("ADMIN_A");
  const post = (path: string, body: unknown) => api(path, t, { method: "POST", school: SCHOOL_A(), body });
  const sessions: { id: string; is_current: boolean }[] = await (await api("/sessions", t, { school: SCHOOL_A() })).json();
  const current = sessions.find((s) => s.is_current)!.id;
  await post("/classes/bulk", { classes: [{ name: "Class 3", display_order: 6 }, { name: "Class 8", display_order: 11 }] });
  const classes = (await (await api(`/classes?session_id=${current}`, t, { school: SCHOOL_A() })).json()).items;
  const c3 = classes.find((c: { name: string }) => c.name === "Class 3").id;
  const c8 = classes.find((c: { name: string }) => c.name === "Class 8").id;
  await post("/sections/bulk", { academic_session_id: current, class_ids: [c3, c8], names: ["T"] });
  const secs = (await (await api(`/sections?session_id=${current}`, t, { school: SCHOOL_A() })).json()).items;
  mySection = secs.find((s: { class_id: string; name: string }) => s.class_id === c3 && s.name === "T").id;
  otherSection = secs.find((s: { class_id: string; name: string }) => s.class_id === c8 && s.name === "T").id;
  for (const [i, [n, cls, sec]] of ([[mine[0], c3, mySection], [mine[1], c3, mySection], [other, c8, otherSection]] as const).entries()) {
    const st = await (await post("/students", { full_name: n, father_name: "Father", date_of_birth: "2017-03-03", gender: i ? "female" : "male",
      mobile: `95555000${i}${i}`, enrollment: { academic_session_id: current, class_id: cls, section_id: sec, admission_number: `${tag}-T${i}`, admission_date: "2026-04-01" } })).json();
    ids[n] = st.id;
  }
});

test.describe("teacher management (admin)", () => {
  test("add a teacher: automatic Employee ID, validation, duplicate email refused", async ({ page }) => {
    await signIn(page, "ADMIN_A", "/teachers");
    await expect(page.getByRole("heading", { level: 1, name: "Teachers" })).toBeVisible();
    await page.getByRole("button", { name: "Add teacher" }).click();
    const d = page.getByRole("dialog");
    await d.getByTestId("save-teacher").click();
    await expect(d.getByText("Enter the teacher's name.")).toBeVisible();
    await d.getByLabel(/^Full name/).fill(`Meera Iyer ${tag}`);
    await d.getByLabel(/^Phone/).fill("+91 98765 12345");
    await d.getByLabel(/^Email/).fill(`meera.${tag.toLowerCase()}@example.com`);
    await d.getByLabel("Qualification").fill("M.Sc, B.Ed");
    await d.getByLabel("Subject").fill("Science");
    await d.getByLabel(/^Joining date/).fill("2023-06-01");
    await d.getByLabel("Address").fill("12 Ring Road, Delhi");
    await d.getByTestId("save-teacher").click();
    await expect(page).toHaveURL(/\/teachers\/[0-9a-f-]{36}$/);
    newTeacherId = page.url().split("/").pop()!;
    await expect(page.getByRole("heading", { level: 1, name: `Meera Iyer ${tag}` })).toBeVisible();
    await expect(page.getByTestId("teacher-summary")).toContainText(/EMP\d{4} · Science · M\.Sc, B\.Ed/);

    // the same email again is refused by the server
    await page.goto("/teachers");
    await page.getByRole("button", { name: "Add teacher" }).click();
    await d.getByLabel(/^Full name/).fill("Another Person");
    await d.getByLabel(/^Phone/).fill("9876512399");
    await d.getByLabel(/^Email/).fill(`MEERA.${tag}@example.com`);
    await d.getByLabel(/^Joining date/).fill("2024-01-01");
    await d.getByTestId("save-teacher").click();
    await expect(d.getByTestId("teacher-form-error")).toHaveText("A teacher with this email already exists.");
  });

  test("edit details, upload a photo, assign classes with one class teacher per section", async ({ page }) => {
    await signIn(page, "ADMIN_A", `/teachers/${newTeacherId}`);
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByRole("dialog").getByLabel("Qualification").fill("M.Sc, B.Ed, CTET");
    await page.getByRole("dialog").getByTestId("save-teacher").click();
    await expect(page.getByTestId("teacher-summary")).toContainText("CTET");

    await page.getByTestId("teacher-photo-input").setInputFiles({ name: "t.png", mimeType: "image/png", buffer: png(400, 300) });
    await expect(page.getByTestId("student-photo")).toBeVisible();

    // TEACHER_A is class teacher of Class 3-T; Meera gets Science there but can't also be class teacher
    await assignTeacher(mySection, { subject: "Maths", classTeacher: true });
    const card = page.getByTestId("assignments-card");
    await card.getByRole("button", { name: "Assign class" }).click();
    await card.getByLabel("Class", { exact: true }).selectOption({ label: "Class 3" });
    await card.getByLabel("Section", { exact: true }).selectOption({ label: "T" });
    await card.getByLabel(/^Subject/).fill("Science");
    await card.getByLabel(/Class teacher of this section/).check();
    await card.getByTestId("confirm-assign").click();
    await expect(card.getByTestId("assign-error")).toHaveText("That section already has a class teacher. Remove them as class teacher first.");
    await card.getByLabel(/Class teacher of this section/).uncheck();
    await card.getByTestId("confirm-assign").click();
    await expect(card.getByTestId("assignment-Class 3-T-Science")).toBeVisible();
    await page.goto("/teachers");
    await page.getByLabel("Search teachers").fill(`Meera Iyer ${tag}`);
    await expect(page.locator('[data-testid^="teacher-row-"]').first().getByTestId("teacher-sections")).toHaveText("1");
  });
});

test.describe("teacher portal", () => {
  test("My classes shows only assigned sections; the class page lists only its students", async ({ page }) => {
    await signIn(page, "TEACHER_A", "/teaching");
    await expect(page.getByRole("heading", { level: 1, name: "My classes" })).toBeVisible();
    const card = page.getByTestId("my-class-Class 3-T");
    await expect(card).toContainText("Class teacher");
    await expect(card).toContainText("Maths");
    await expect(card.getByTestId("my-class-students")).toHaveText("2");
    await expect(page.getByTestId("my-class-Class 8-T")).toHaveCount(0);

    await card.getByRole("link", { name: "Class 3 – T" }).click();
    const list = page.getByTestId("section-students");
    await expect(list).toContainText(mine[0]);
    await expect(list).toContainText(mine[1]);
    await expect(list).not.toContainText(other);
    await page.getByRole("tab", { name: "Timetable", exact: true }).click();
    await expect(page.getByTestId("timetable-panel")).toBeVisible(); // real timetable (Phase 15)
    for (const t of ["Homework", "Assignments"]) {
      await page.getByRole("tab", { name: t, exact: true }).click();
      await expect(page.getByTestId("homework-list-card")).toBeVisible(); // real lists (Phase 16)
    }
    for (const t of ["Exams", "Marks"]) {
      await page.getByRole("tab", { name: t, exact: true }).click();
      await expect(page.getByTestId("class-exams-empty")).toBeVisible(); // real exams (Phase 17): none for this class
    }
    await page.getByRole("tab", { name: "Notices" }).click();
    await page.getByRole("tab", { name: "Attendance" }).click();
    await expect(page.getByTestId("section-today")).toHaveText("Today: 0 of 2 marked");
  });

  test("the teacher marks their class; the dashboard and Students page show only their students", async ({ page }) => {
    await signIn(page, "TEACHER_A", `/attendance?section=${mySection}&date=${today}`);
    await expect(page.getByTestId("roster").getByRole("listitem")).toHaveCount(2);
    await page.getByRole("button", { name: "Mark all present" }).click();
    await page.getByTestId("save-attendance").click();
    await expect(page.getByText("Attendance saved: 2 new, 0 changed.")).toBeVisible();

    await page.goto("/teaching");
    await expect(page.getByTestId("my-class-Class 3-T").getByTestId("my-class-today")).toHaveText("Today's attendance marked");
    await page.goto(`/students?q=${tag}`);
    await expect(page.getByTestId(`student-row-${tag}-T0`)).toBeVisible();
    await expect(page.getByTestId(`student-row-${tag}-T1`)).toBeVisible();
    await expect(page.getByTestId(`student-row-${tag}-T2`)).toHaveCount(0);
  });

  test("another class is unreachable, by page and by API", async ({ page }) => {
    await signIn(page, "TEACHER_A", `/teaching/${otherSection}`);
    await expect(page.getByText("This class isn't assigned to you.")).toBeVisible();
    await page.goto(`/students/${ids[other]}`);
    await expect(page.getByText(/doesn't exist in this school/)).toBeVisible();
    await page.goto("/teachers");
    await expect(page.getByTestId("access-denied")).toBeVisible();

    const t = await accessToken("TEACHER_A");
    for (const path of [`/teaching/sections/${otherSection}`, `/students/${ids[other]}`, `/attendance/roster?section_id=${otherSection}&date=${today}`,
                        `/attendance/students/${ids[other]}`]) {
      expect((await api(path, t, { school: SCHOOL_A() })).status, path).toBe(404);
    }
    const save = await api("/attendance/roster", t, { method: "PUT", school: SCHOOL_A(), body: { section_id: otherSection, date: today,
      entries: [{ enrollment_id: crypto.randomUUID(), status: "present" }] } });
    expect(save.status).toBe(404);
    const report = await (await api(`/reports/students?search=${tag}`, t, { school: SCHOOL_A() })).json();
    expect(report.total).toBe(2); // the Class 8 student is not in their reports either
    for (const path of ["/teachers", `/teachers/${newTeacherId}`]) expect((await api(path, t, { school: SCHOOL_A() })).status, path).toBe(403);
    const [acct, adminB] = await Promise.all([accessToken("ACCOUNTANT_A"), accessToken("ADMIN_B")]);
    expect((await api("/teachers", acct, { school: SCHOOL_A() })).status).toBe(403);
    expect((await api(`/teachers/${newTeacherId}`, adminB, { school: SCHOOL_B() })).status).toBe(404);
  });

  test("removing the assignment or deactivating the teacher removes access at once", async ({ page }) => {
    const admin = await accessToken("ADMIN_A");
    const teacher = await accessToken("TEACHER_A");
    const list = await (await api("/teachers?search=EMP-E2E-A", admin, { school: SCHOOL_A() })).json();
    const tid = list.items[0].id;
    const detail = await (await api(`/teachers/${tid}`, admin, { school: SCHOOL_A() })).json();
    const a = detail.assignments.find((x: { section_id: string }) => x.section_id === mySection);
    await api(`/teachers/${tid}/assignments/${a.id}`, admin, { method: "DELETE", school: SCHOOL_A() });
    expect((await api(`/students/${ids[mine[0]]}`, teacher, { school: SCHOOL_A() })).status).toBe(404);
    await assignTeacher(mySection);
    expect((await api(`/students/${ids[mine[0]]}`, teacher, { school: SCHOOL_A() })).status).toBe(200);

    try {
      await signIn(page, "ADMIN_A", `/teachers/${tid}`);
      await page.getByTestId("toggle-teacher-status").click();
      await page.getByRole("dialog").getByLabel(/^Reason/).fill("On long leave");
      await page.getByRole("dialog").getByTestId("confirm-teacher-status").click();
      await expect(page.getByText("Reason: On long leave")).toBeVisible();
      expect((await api(`/students/${ids[mine[0]]}`, teacher, { school: SCHOOL_A() })).status).toBe(403); // no school access at all
    } finally {
      await api(`/teachers/${tid}/status`, admin, { method: "POST", school: SCHOOL_A(), body: { status: "active" } });
    }
    expect((await api(`/students/${ids[mine[0]]}`, teacher, { school: SCHOOL_A() })).status).toBe(200);
  });
});
