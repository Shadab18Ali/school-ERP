import { expect, test, type Page } from "@playwright/test";
import { accessToken, api, png, runTag, SCHOOL_A, SCHOOL_B, signIn, assignTeacherForStudent } from "./helpers";

test.describe.configure({ mode: "serial" });

type Ids = { current: string; past: string; class1: string; class2: string; c1a: string; c1b: string; c2a: string; c2b: string; pastC1a: string };
let ids: Ids;
const tag = runTag();

async function setup(): Promise<Ids> {
  const t = await accessToken("ADMIN_A");
  const sessions: { id: string; name: string }[] = await (await api("/sessions", t, { school: SCHOOL_A() })).json();
  const current = sessions.find((s) => s.name === "2026-27")!.id;
  const past = sessions.find((s) => s.name === "2025-26")!.id;
  await api("/classes/bulk", t, { method: "POST", school: SCHOOL_A(), body: { classes: [{ name: "Class 1", display_order: 4 }, { name: "Class 2", display_order: 5 }] } });
  const classes = (await (await api(`/classes?session_id=${current}`, t, { school: SCHOOL_A() })).json()).items;
  const class1 = classes.find((c: { name: string }) => c.name === "Class 1").id;
  const class2 = classes.find((c: { name: string }) => c.name === "Class 2").id;
  await api("/sections/bulk", t, { method: "POST", school: SCHOOL_A(), body: { academic_session_id: current, class_ids: [class1, class2], names: ["A", "B"], capacity: 40 } });
  const secs = (await (await api(`/sections?session_id=${current}&page_size=100`, t, { school: SCHOOL_A() })).json()).items;
  const find = (c: string, n: string) => secs.find((s: { class_id: string; name: string; is_deleted: boolean }) => s.class_id === c && s.name === n).id;
  const pastSecs = (await (await api(`/sections?session_id=${past}`, t, { school: SCHOOL_A() })).json()).items;
  return { current, past, class1, class2, c1a: find(class1, "A"), c1b: find(class1, "B"), c2a: find(class2, "A"), c2b: find(class2, "B"), pastC1a: pastSecs[0].id };
}

async function createViaApi(body: Record<string, unknown>, enrollment: Record<string, unknown>) {
  const t = await accessToken("ADMIN_A");
  const res = await api("/students", t, { method: "POST", school: SCHOOL_A(), body: { father_name: "Test Parent", date_of_birth: "2019-06-01", gender: "male", mobile: "9800000000", ...body, enrollment } });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fillStudentForm(page: Page, f: { name: string; father?: string; mother?: string; dob: string; gender: string; mobile: string; adm: string; section?: string }) {
  await page.getByLabel(/^Full name/).fill(f.name);
  await page.getByLabel(/^Date of birth/).fill(f.dob);
  await page.getByLabel("Gender").selectOption(f.gender);
  if (f.father !== undefined) await page.getByLabel(/^Father's name/).fill(f.father);
  if (f.mother !== undefined) await page.getByLabel(/^Mother's name/).fill(f.mother);
  await page.getByLabel(/^Mobile/).fill(f.mobile);
  await page.getByLabel("Class").selectOption({ label: "Class 1" });
  const section = page.getByLabel("Section");
  const opt = await section.locator("option").filter({ hasText: new RegExp(`^${f.section ?? "A"}\\b`) }).getAttribute("value");
  await section.selectOption(opt!);
  await page.getByLabel(/^Admission number/).fill(f.adm);
}

test.beforeAll(async () => { ids = await setup(); });

test.describe("students: add, view, edit", () => {
  test("add a student with a photo and open the profile", async ({ page }) => {
    await signIn(page, "ADMIN_A", "/students");
    await page.getByRole("link", { name: "Add student" }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Add student" })).toBeVisible();
    await page.getByTestId("photo-input").setInputFiles({ name: "kid.png", mimeType: "image/png", buffer: png(120, 160) });
    await expect(page.getByAltText("Selected photo")).toBeVisible();
    await fillStudentForm(page, { name: `Aarav Sharma ${tag}`, father: "Rakesh Sharma", dob: "2019-05-10", gender: "male", mobile: "+91 98765 43210", adm: `${tag}-001` });
    await page.getByLabel(/^Address/).fill("12 Ring Road, New Delhi");
    await page.getByTestId("save-student").click();

    await expect(page).toHaveURL(/\/students\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1, name: `Aarav Sharma ${tag}` })).toBeVisible();
    await expect(page.getByTestId("student-summary")).toContainText(/STU\d{5}/);
    await expect(page.getByTestId("student-summary")).toContainText(`Class 1 – A · Adm. no. ${tag}-001`);
    await expect(page.getByText("98765 43210")).toBeVisible();
    await expect(page.getByText(/10 May 2019 \(\d+ years\)/)).toBeVisible();
    const photo = page.getByTestId("student-photo");
    await expect(photo).toHaveAttribute("src", /\/storage\/v1\/object\/sign\/student-photos\/.+\.jpg\?token=/);
    await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(120);

    await page.getByRole("link", { name: "All students" }).click();
    await expect(page.getByTestId(`student-row-${tag}-001`)).toContainText(`Aarav Sharma ${tag}`);
  });

  test("the next admission number is suggested", async ({ page }) => {
    await signIn(page, "ADMIN_A", "/students/new");
    await expect(page.getByLabel(/^Admission number/)).toHaveValue(`${tag}-002`);
  });

  test("form validation explains what's missing", async ({ page }) => {
    await signIn(page, "ADMIN_A", "/students/new");
    const number = page.getByLabel(/^Admission number/);
    await expect(number).toHaveValue(/.+/); // the suggestion arrives first...
    await number.fill(""); // ...and the user clears it
    await page.getByTestId("save-student").click();
    for (const msg of ["Enter the student's full name.", "Enter the father's or the mother's name.", "Enter the date of birth.",
      "Choose the gender.", "Enter a valid mobile number (10–15 digits).", "Choose a class.", "Enter the admission number."]) {
      await expect(page.getByText(msg)).toBeVisible();
    }
  });

  test("a duplicate admission number in the same session is refused", async ({ page }) => {
    await signIn(page, "ADMIN_A", "/students/new");
    await fillStudentForm(page, { name: "Duplicate Kid", mother: "Some Mother", dob: "2019-01-01", gender: "female", mobile: "9811111111", adm: `${tag.toLowerCase()}-001` });
    await page.getByTestId("save-student").click();
    await expect(page.getByTestId("student-form-error")).toHaveText("This admission number is already used in this session.");
    await expect(page).toHaveURL(/\/students\/new$/);
  });

  test("edit details and move to another section", async ({ page }) => {
    await signIn(page, "ADMIN_A", `/students?q=${tag}-001`);
    await page.getByRole("link", { name: new RegExp(`Aarav Sharma ${tag}`) }).click();
    await page.getByRole("link", { name: "Edit" }).click();
    await page.getByLabel(/^Mother's name/).fill("Sunita Sharma");
    await page.getByLabel(/^Alternate mobile/).fill("98765 43210");
    await page.getByTestId("save-student").click();
    await expect(page.getByText("Same as the mobile number.")).toBeVisible();
    await page.getByLabel(/^Alternate mobile/).fill("98111 22233");
    const section = page.getByLabel("Section");
    await section.selectOption((await section.locator("option").filter({ hasText: /^B\b/ }).getAttribute("value"))!);
    await page.getByTestId("save-student").click();
    await expect(page).toHaveURL(/\/students\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("student-summary")).toContainText("Class 1 – B");
    await expect(page.getByText("Sunita Sharma")).toBeVisible();
    await expect(page.getByText("98111 22233")).toBeVisible();
  });

  test("deactivate with a reason, filter by status, then activate", async ({ page }) => {
    await signIn(page, "ADMIN_A", `/students?q=${tag}-001`);
    await page.getByRole("link", { name: new RegExp(`Aarav Sharma ${tag}`) }).click();
    await page.getByTestId("toggle-student-status").click();
    await page.getByLabel(/^Reason/).fill("Transferred to Pune");
    await page.getByRole("dialog").getByRole("button", { name: "Deactivate" }).click();
    await expect(page.getByText("Reason: Transferred to Pune")).toBeVisible();
    await expect(page.getByTestId("toggle-student-status")).toHaveText("Activate");

    await page.goto(`/students?status=inactive&q=${tag}`);
    await expect(page.getByTestId(`student-row-${tag}-001`)).toContainText("Inactive");
    await page.goto(`/students?status=active&q=${tag}-001`);
    await expect(page.getByText("No students match")).toBeVisible();

    await page.goto(`/students?q=${tag}-001`);
    await page.getByRole("link", { name: new RegExp(`Aarav Sharma ${tag}`) }).click();
    await page.getByTestId("toggle-student-status").click();
    await page.getByRole("dialog").getByRole("button", { name: "Activate" }).click();
    await expect(page.getByTestId("toggle-student-status")).toHaveText("Deactivate");
  });

  test("enrol an existing student into the current session", async ({ page }) => {
    const s = await createViaApi({ full_name: `Old Timer ${tag}` }, {
      academic_session_id: ids.past, class_id: ids.class1, section_id: ids.pastC1a, admission_number: `${tag}-OLD`, admission_date: "2025-04-01",
    });
    await signIn(page, "ADMIN_A", `/students/${s.id}`);
    await expect(page.getByTestId("not-enrolled-notice")).toBeVisible();
    await page.getByRole("button", { name: "Enrol in 2026-27" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("Class").selectOption({ label: "Class 2" });
    await d.getByLabel("Section").selectOption((await d.getByLabel("Section").locator("option").filter({ hasText: /^A\b/ }).getAttribute("value"))!);
    await expect(d.getByLabel(/^Admission number/)).toHaveValue(`${tag}-OLD`); // carried over
    await d.getByRole("button", { name: "Enrol" }).click();
    await expect(page.getByTestId("student-summary")).toContainText("Class 2 – A");
    await expect(page.getByTestId("enrollment-history").locator("tbody tr")).toHaveCount(2);
  });
});

test.describe("students: list", () => {
  test("search, filters, sorting and pagination", async ({ page }) => {
    const prefix = `Zed${tag}`;
    const genders = ["female", "male"];
    for (let i = 1; i <= 27; i++) {
      await createViaApi(
        { full_name: `${prefix} ${String(i).padStart(2, "0")}`, gender: genders[i % 2], mobile: `9${700000000 + i}` },
        { academic_session_id: ids.current, class_id: ids.class2, section_id: i <= 14 ? ids.c2a : ids.c2b, admission_number: `${tag}-L${i}`, admission_date: "2026-04-05" },
      );
    }
    await signIn(page, "ADMIN_A", `/students?q=${prefix}`);
    await expect(page.getByTestId("students-total")).toHaveText("27 students");
    await expect(page.locator('[data-testid^="student-row-"]')).toHaveCount(25);
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator('[data-testid^="student-row-"]')).toHaveCount(2);

    // filters are in the link and combine
    await page.getByLabel("Gender").selectOption("female");
    await expect(page.getByTestId("students-total")).toHaveText("13 students");
    await page.getByLabel("Class").selectOption({ label: "Class 2" });
    await page.getByLabel("Section").selectOption({ label: "A" });
    await expect(page.getByTestId("students-total")).toHaveText("7 students");

    // sort by name
    await page.goto(`/students?q=${prefix}&sort=name`);
    await expect(page.locator('[data-testid^="student-row-"]').first()).toContainText(`${prefix} 01`);

    // search by admission number and by mobile with spaces
    await page.getByLabel("Search students").fill(`${tag}-L17`);
    await expect(page.locator('[data-testid^="student-row-"]')).toHaveCount(1);
    await expect(page.getByTestId(`student-row-${tag}-L17`)).toBeVisible();
  });

  test("teachers can view students but not change them; parents can't see the list", async ({ page, browser }) => {
    const admin = await accessToken("ADMIN_A");
    const found = await (await api(`/students?search=${tag}-001`, admin, { school: SCHOOL_A() })).json();
    await assignTeacherForStudent(found.items[0].id); // teachers see only their assigned classes' students
    await signIn(page, "TEACHER_A", `/students?q=${tag}-001`);
    await expect(page.getByTestId(`student-row-${tag}-001`)).toBeVisible();
    await expect(page.getByRole("link", { name: "Add student" })).toHaveCount(0);
    await page.getByRole("link", { name: new RegExp(`Aarav Sharma ${tag}`) }).click();
    await expect(page.getByRole("heading", { level: 1, name: `Aarav Sharma ${tag}` })).toBeVisible();
    await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);
    await expect(page.getByTestId("toggle-student-status")).toHaveCount(0);
    await page.goto("/students/new");
    await expect(page.getByTestId("access-denied")).toBeVisible();

    const parent = await browser.newPage();
    await signIn(parent, "PARENT_A", "/students");
    await expect(parent.getByTestId("access-denied")).toBeVisible();
    await parent.close();
  });
});

test.describe("students: protection", () => {
  test("photos are private; other schools and roles are refused", async () => {
    const [adminA, adminB, teacherA, parentA] = await Promise.all([accessToken("ADMIN_A"), accessToken("ADMIN_B"), accessToken("TEACHER_A"), accessToken("PARENT_A")]);
    const list = await (await api(`/students?search=${tag}-001`, adminA, { school: SCHOOL_A() })).json();
    const id = list.items[0].id;
    const detail = await (await api(`/students/${id}`, adminA, { school: SCHOOL_A() })).json();
    expect(detail.photo_url).toMatch(/\/object\/sign\/student-photos\//);
    expect((await fetch(detail.photo_url)).status).toBe(200);
    const unsigned = detail.photo_url.replace("/object/sign/", "/object/public/").split("?")[0];
    expect((await fetch(unsigned)).status).toBeGreaterThanOrEqual(400);

    expect((await api(`/students/${id}`, adminB, { school: SCHOOL_B() })).status).toBe(404);
    expect((await api("/students", adminB, { school: SCHOOL_A() })).status).toBe(403);
    expect((await api("/students", parentA, { school: SCHOOL_A() })).status).toBe(403);
    expect((await api(`/students/${id}`, teacherA, { method: "PATCH", school: SCHOOL_A(), body: { full_name: "Hacked" } })).status).toBe(403);
    expect((await api(`/students/${id}`, adminA, { method: "PATCH", school: SCHOOL_A(), body: { student_code: "STU99999" } })).status).toBe(422);
  });

  test("a section with students can't be deleted", async ({ page }) => {
    await signIn(page, "ADMIN_A", `/classes?tab=sections&class=${ids.class1}`);
    await page.getByRole("button", { name: "Actions for Class 1 B", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete section" }).click();
    await expect(page.getByText(/Section B has \d+ student\(s\)\. Move them to another section first\./)).toBeVisible();
    await expect(page.getByTestId("section-row-Class 1-B").getByTestId("section-students")).toContainText(/^[1-9]/);
  });
});
