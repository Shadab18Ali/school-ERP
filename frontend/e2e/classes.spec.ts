import { expect, test, type Page } from "@playwright/test";
import { accessToken, api, runTag, SCHOOL_A, SCHOOL_B, signIn, assignTeacherForClass } from "./helpers";

const STANDARD = ["Nursery", "LKG", "UKG", ...Array.from({ length: 12 }, (_, i) => `Class ${i + 1}`)];

async function ensureStandardClasses() {
  const token = await accessToken("ADMIN_A");
  await api("/classes/bulk", token, {
    method: "POST", school: SCHOOL_A(),
    body: { classes: STANDARD.map((name, i) => ({ name, display_order: i + 1 })) },
  });
}

async function sessionId(name: string): Promise<string> {
  const token = await accessToken("ADMIN_A");
  const list: { id: string; name: string }[] = await (await api("/sessions", token, { school: SCHOOL_A() })).json();
  return list.find((s) => s.name === name)!.id;
}

const menu = (page: Page, label: string) => page.getByRole("button", { name: `Actions for ${label}`, exact: true });
const dialog = (page: Page) => page.getByRole("dialog");

test.describe.configure({ mode: "serial" });

test.describe("classes", () => {
  test("add the standard classes, in order", async ({ page }) => {
    await signIn(page, "ADMIN_A", "/classes");
    await expect(page.getByRole("heading", { level: 1, name: "Classes & sections" })).toBeVisible();
    await page.getByRole("button", { name: "Standard classes" }).click();
    // Class 1 already exists, so 14 are offered
    await expect(dialog(page).getByText("added")).toHaveCount(1);
    await dialog(page).getByRole("button", { name: "Add 14 classes" }).click();
    await expect(page.getByText("14 classes added.")).toBeVisible();
    // toHaveText retries until the refreshed list is shown (allTextContents would read it once, too early)
    await expect(page.locator('[data-testid^="class-row-"] td:first-child p.font-medium')).toHaveText(STANDARD);
    await expect(page.getByTestId("classes-summary")).toContainText("15 classes · 0 sections · 0 students in 2026-27");
  });

  test("add, edit, deactivate, activate, delete and restore a class", async ({ page }) => {
    const name = `E2E Music ${runTag()}`;
    await signIn(page, "ADMIN_A", "/classes");

    await page.getByRole("button", { name: "Add class" }).click();
    await dialog(page).getByLabel(/^Class name/).fill(name);
    await dialog(page).getByRole("button", { name: "Add class" }).click();
    await expect(page.getByText(`${name} added.`)).toBeVisible();
    const row = page.getByTestId(`class-row-${name}`);
    await expect(row).toBeVisible();

    // duplicate (case-insensitive) is refused
    await page.getByRole("button", { name: "Add class" }).click();
    await dialog(page).getByLabel(/^Class name/).fill("class 1");
    await dialog(page).getByRole("button", { name: "Add class" }).click();
    await expect(dialog(page).getByTestId("modal-error")).toHaveText("A class with this name already exists.");
    await dialog(page).getByRole("button", { name: "Cancel" }).click();

    // edit
    await menu(page, name).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await dialog(page).getByLabel(/^Class name/).fill(`${name} Band`);
    await dialog(page).getByLabel(/^Display order/).fill("99");
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    const edited = page.getByTestId(`class-row-${name} Band`);
    await expect(edited).toContainText("Order 99");

    // deactivate -> filters
    await menu(page, `${name} Band`).click();
    await page.getByRole("menuitem", { name: "Deactivate" }).click();
    await dialog(page).getByRole("button", { name: "Deactivate" }).click();
    await expect(edited).toContainText("Inactive");
    await page.getByLabel("Class status").selectOption("active");
    await expect(edited).toHaveCount(0);
    await page.getByLabel("Class status").selectOption("inactive");
    await expect(edited).toBeVisible();
    await menu(page, `${name} Band`).click();
    await page.getByRole("menuitem", { name: "Activate" }).click();
    await expect(edited).toHaveCount(0); // no longer inactive
    await page.getByLabel("Class status").selectOption("");
    await expect(edited).toContainText("Active");

    // soft delete -> deleted filter -> restore
    await menu(page, `${name} Band`).click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await dialog(page).getByRole("button", { name: "Delete class" }).click();
    await expect(edited).toHaveCount(0);
    await page.getByLabel("Class status").selectOption("deleted");
    await expect(edited).toContainText("Deleted");
    await menu(page, `${name} Band`).click();
    await page.getByRole("menuitem", { name: "Restore" }).click();
    await expect(page.getByText(`${name} Band restored.`)).toBeVisible();
    await page.getByLabel("Class status").selectOption("");
    await expect(edited).toContainText("Active");
  });

  test("search finds classes by name", async ({ page }) => {
    await ensureStandardClasses();
    await signIn(page, "ADMIN_A", "/classes");
    await page.getByLabel("Search classes").fill("nurs");
    await expect(page.locator('[data-testid^="class-row-"]')).toHaveCount(1);
    await expect(page.getByTestId("class-row-Nursery")).toBeVisible();
    await page.getByLabel("Search classes").fill("Class 1");
    await expect(page.locator('[data-testid^="class-row-"]')).toHaveCount(4); // 1, 10, 11, 12
    await page.getByLabel("Search classes").fill("zzz");
    await expect(page.getByText("No classes match")).toBeVisible();
  });
});

test.describe("sections", () => {
  test("assign A–D to classes, then edit, deactivate, delete and restore", async ({ page }) => {
    await ensureStandardClasses();
    await signIn(page, "ADMIN_A", "/classes");

    await page.getByRole("button", { name: "Assign sections" }).click();
    const d = dialog(page);
    await d.getByLabel("Class 1", { exact: true }).check();
    await d.getByLabel("Class 2", { exact: true }).check();
    for (const l of ["B", "C", "D"]) await d.getByRole("button", { name: l, exact: true }).click();
    await d.getByLabel(/^Capacity per section/).fill("40");
    await d.getByRole("button", { name: /Assign up to 8 sections/ }).click();
    await expect(page.getByText(/8 sections added|sections added/)).toBeVisible();
    await expect(page.getByTestId("class-row-Class 1")).toContainText("ABCD");
    await expect(page.getByTestId("class-row-Class 1")).toContainText("160"); // 4 x 40 capacity

    // the chips open the Sections tab filtered to that class
    await page.getByRole("button", { name: "View sections of Class 1" }).click();
    await expect(page).toHaveURL(/tab=sections/);
    await expect(page.locator('[data-testid^="section-row-"]')).toHaveCount(4);

    // edit capacity + room
    await menu(page, "Class 1 B").click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await dialog(page).getByLabel(/^Capacity/).fill("35");
    await dialog(page).getByLabel(/^Room/).fill("R-7");
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    const b = page.getByTestId("section-row-Class 1-B");
    await expect(b).toContainText("R-7");
    await expect(b.getByTestId("section-students")).toHaveText("0 / 35");

    // search by room
    await page.getByLabel("Search sections").fill("R-7");
    await expect(page.locator('[data-testid^="section-row-"]')).toHaveCount(1);
    await page.getByLabel("Search sections").fill("");

    // moving B into Class 2 (which already has B) is refused
    await menu(page, "Class 1 B").click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await dialog(page).getByLabel("Class").selectOption({ label: "Class 2" });
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(dialog(page).getByTestId("modal-error")).toHaveText("This class already has a section with that name in this session.");
    await dialog(page).getByRole("button", { name: "Cancel" }).click();

    // deactivate C, delete D, restore D
    await menu(page, "Class 1 C").click();
    await page.getByRole("menuitem", { name: "Deactivate" }).click();
    await dialog(page).getByRole("button", { name: "Deactivate" }).click();
    await expect(page.getByTestId("section-row-Class 1-C")).toContainText("Inactive");

    await menu(page, "Class 1 D").click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await dialog(page).getByRole("button", { name: "Delete section" }).click();
    await expect(page.getByTestId("section-row-Class 1-D")).toHaveCount(0);
    await page.getByLabel("Section status").selectOption("deleted");
    await expect(page.getByTestId("section-row-Class 1-D")).toContainText("Deleted");
    await menu(page, "Class 1 D").click();
    await page.getByRole("menuitem", { name: "Restore" }).click();
    await expect(page.getByText("Class 1 D restored.")).toBeVisible();

    // a class that still has sections can't be deleted
    await page.getByRole("tab", { name: "classes" }).click();
    await menu(page, "Class 1").click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await dialog(page).getByRole("button", { name: "Delete class" }).click();
    // 4 in 2026-27 + 1 in 2025-26
    await expect(page.getByText("Class 1 still has 5 section(s) across all sessions. Delete those sections first.")).toBeVisible();
  });

  test("session filter shows each year's sections; copy last year's structure", async ({ page }) => {
    await signIn(page, "ADMIN_A", "/classes");
    await page.getByLabel("Academic session").selectOption({ label: "2025-26" });
    await expect(page).toHaveURL(/session=/);
    await expect(page.getByTestId("class-row-Class 1")).toContainText("A");
    await expect(page.getByTestId("classes-summary")).toContainText("1 section · 0 students in 2025-26");

    await page.getByLabel("Academic session").selectOption({ label: "2026-27 (current)" });
    await expect(page.getByTestId("classes-summary")).toContainText("in 2026-27");  // switched before acting on it
    await page.getByRole("tab", { name: "sections" }).click();
    await page.getByRole("button", { name: "Copy from session" }).click();
    await expect(dialog(page)).toContainText("Copy sections into 2026-27");
    await expect(dialog(page).getByLabel("Copy from")).toHaveValue(await sessionId("2025-26"));
    await dialog(page).getByRole("button", { name: "Copy sections" }).click();
    await expect(page.getByText(/copied/)).toBeVisible();
    await expect(page.getByTestId("section-row-Class 1-A")).toBeVisible();
  });

  test("an archived session's sections are read-only", async ({ page }) => {
    const token = await accessToken("ADMIN_A");
    const past = await sessionId("2025-26");
    await api(`/sessions/${past}/archive`, token, { method: "POST", school: SCHOOL_A() });
    try {
      await signIn(page, "ADMIN_A", `/classes?tab=sections&session=${past}`);
      await expect(page.getByTestId("archived-notice")).toBeVisible();
      await expect(page.getByTestId("section-row-Class 1-A")).toBeVisible();
      await expect(page.getByRole("button", { name: "Add section" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Actions for Class 1 A/ })).toHaveCount(0);
      // and the API refuses too
      const sections = await (await api(`/sections?session_id=${past}`, token, { school: SCHOOL_A() })).json();
      const res = await api(`/sections/${sections.items[0].id}`, token, { method: "PATCH", school: SCHOOL_A(), body: { room: "X" } });
      expect(res.status).toBe(409);
    } finally {
      await api(`/sessions/${past}/restore`, token, { method: "POST", school: SCHOOL_A() });
    }
  });
});

test.describe("classes: access", () => {
  test("teachers and accountants can view but not change", async ({ page }) => {
    await assignTeacherForClass("Class 1"); // teachers see only their assigned classes
    await signIn(page, "TEACHER_A", "/classes");
    await expect(page.getByTestId("class-row-Class 1")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add class" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
    await page.getByRole("tab", { name: "sections" }).click();
    await expect(page.getByRole("button", { name: "Add section" })).toHaveCount(0);
  });

  test("API enforces roles and school isolation", async () => {
    const [adminA, adminB, teacherA, accountantA] = await Promise.all(
      [accessToken("ADMIN_A"), accessToken("ADMIN_B"), accessToken("TEACHER_A"), accessToken("ACCOUNTANT_A")]);
    const list = await (await api("/classes", adminA, { school: SCHOOL_A() })).json();
    const class1 = list.items.find((c: { name: string }) => c.name === "Class 1");

    expect((await api("/classes", teacherA, { school: SCHOOL_A() })).status).toBe(200);
    expect((await api("/classes", teacherA, { method: "POST", school: SCHOOL_A(), body: { name: "T" } })).status).toBe(403);
    expect((await api(`/classes/${class1.id}`, accountantA, { method: "PATCH", school: SCHOOL_A(), body: { is_active: false } })).status).toBe(403);
    // School B's admin can't see or touch School A's class, even with its id
    expect((await api(`/classes/${class1.id}`, adminB, { method: "PATCH", school: SCHOOL_B(), body: { name: "Hacked" } })).status).toBe(404);
    expect((await api("/classes", adminA, { school: SCHOOL_B() })).status).toBe(403);
    const bList = await (await api("/classes", adminB, { school: SCHOOL_B() })).json();
    expect(bList.items.map((c: { id: string }) => c.id)).not.toContain(class1.id);
  });
});
