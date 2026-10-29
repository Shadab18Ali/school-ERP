import { expect, test, type Page } from "@playwright/test";
import { accessToken, api, SCHOOL_A, SCHOOL_B, signIn } from "./helpers";

/** Puts School A back to its seeded state, whatever a test did. */
async function resetSchoolA(createdName?: string) {
  const token = await accessToken("ADMIN_A");
  const list: { id: string; name: string }[] = await (await api("/sessions", token, { school: SCHOOL_A() })).json();
  const byName = (n: string) => list.find((s) => s.name === n);
  await api(`/sessions/${byName("2026-27")!.id}/set-current`, token, { method: "POST", school: SCHOOL_A() });
  const created = createdName && byName(createdName);
  if (created) {
    await api(`/sessions/${created.id}/restore`, token, { method: "POST", school: SCHOOL_A() });
    await api(`/sessions/${created.id}`, token, { method: "DELETE", school: SCHOOL_A(), body: { confirm_name: created.name } });
  }
}

async function openMenu(page: Page, name: string) {
  await page.getByRole("button", { name: `Actions for ${name}` }).click();
}

test.describe("academic sessions (school admin)", () => {
  test("shows the current session in the header and the list", async ({ page }) => {
    await signIn(page, "ADMIN_A", "/sessions");
    await expect(page.getByTestId("header-session")).toHaveText("Session 2026-27");
    await expect(page.getByTestId("current-session-name")).toHaveText("2026-27");
    await expect(page.getByTestId("session-2025-26")).toContainText("1 sections");
  });

  test("full lifecycle: create, make current, archive, restore, delete", async ({ page }) => {
    const year = 2060 + Math.floor(Math.random() * 40);
    const name = `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
    test.info().annotations.push({ type: "session", description: name });
    await signIn(page, "ADMIN_A", "/sessions");
    try {
    // create (name is suggested from the start date)
    await page.getByRole("button", { name: "New session" }).first().click();
    await page.getByLabel(/^Starts on/).fill(`${year}-04-01`);
    await expect(page.getByLabel(/^Session name/)).toHaveValue(name);
    await expect(page.getByLabel(/^Ends on/)).toHaveValue(`${year + 1}-03-31`);
    await page.getByRole("button", { name: "Create session" }).click();
    await expect(page.getByText(`${name} created.`)).toBeVisible();
    const row = page.getByTestId(`session-${name}`);
    await expect(row).toContainText("no records yet");

    // make current -> header updates
    await openMenu(page, name);
    await page.getByRole("menuitem", { name: "Make current" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Make current" }).click();
    await expect(page.getByTestId("current-session-name")).toHaveText(name);
    await expect(page.getByTestId("header-session")).toHaveText(`Session ${name}`);

    // the current session can't be deleted
    await openMenu(page, name);
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await expect(page.getByTestId("delete-blocked")).toContainText("current session");
    await page.getByRole("dialog").getByRole("button", { name: "OK" }).click();

    // switch back to 2026-27
    await openMenu(page, "2026-27");
    await page.getByRole("menuitem", { name: "Make current" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Make current" }).click();
    await expect(page.getByTestId("header-session")).toHaveText("Session 2026-27");

    // archive hides it; "show archived" reveals it; restore brings it back
    await openMenu(page, name);
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Archive" }).click();
    await expect(row).toHaveCount(0);
    await page.getByLabel(/Show archived/).check();
    await expect(row).toContainText("Archived");
    await openMenu(page, name);
    await expect(page.getByRole("menuitem", { name: "Make current" })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Restore" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Restore" }).click();
    await expect(row).not.toContainText("Archived");

    // delete requires typing the name
    await openMenu(page, name);
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    const confirm = page.getByTestId("confirm-delete-session");
    await expect(confirm).toBeDisabled();
    await page.getByLabel(`Type ${name} to confirm`).fill("wrong");
    await expect(confirm).toBeDisabled();
    await page.getByLabel(`Type ${name} to confirm`).fill(name);
    await confirm.click();
    await expect(page.getByText(`${name} deleted.`)).toBeVisible();
    await expect(row).toHaveCount(0);
    } finally {
      await resetSchoolA(name);
    }
  });

  test("a session with records cannot be deleted, only archived", async ({ page }) => {
    await signIn(page, "ADMIN_A", "/sessions");
    await openMenu(page, "2025-26");
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await expect(page.getByTestId("delete-blocked")).toContainText("1 sections");
    await expect(page.getByTestId("confirm-delete-session")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Archive instead" })).toBeVisible();
  });

  test("overlapping dates are refused with a clear message", async ({ page }) => {
    await signIn(page, "ADMIN_A", "/sessions");
    await page.getByRole("button", { name: "New session" }).first().click();
    await page.getByLabel(/^Session name/).fill("Overlap test");
    await page.getByLabel(/^Starts on/).fill("2026-06-01");
    await page.getByLabel(/^Ends on/).fill("2027-05-31");
    await page.getByRole("button", { name: "Create session" }).click();
    await expect(page.getByTestId("session-form-error")).toHaveText("These dates overlap another session of this school.");
  });

  test("teachers can view sessions but not change them", async ({ page }) => {
    await signIn(page, "TEACHER_A", "/sessions");
    await expect(page.getByTestId("current-session-name")).toHaveText("2026-27");
    await expect(page.getByRole("button", { name: "New session" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
  });
});

test.describe("academic sessions (API protection)", () => {
  test("cross-school and role checks", async () => {
    const [adminA, adminB, teacherA] = await Promise.all([accessToken("ADMIN_A"), accessToken("ADMIN_B"), accessToken("TEACHER_A")]);
    const bSessions = await (await api("/sessions", adminB, { school: SCHOOL_B() })).json();
    const bCurrent = bSessions.find((s: { is_current: boolean }) => s.is_current);
    expect(bCurrent).toBeTruthy();

    // Admin A acting through School A can't reach School B's session...
    expect((await api(`/sessions/${bCurrent.id}/set-current`, adminA, { method: "POST", school: SCHOOL_A() })).status).toBe(404);
    // ...and can't switch into School B at all.
    expect((await api("/sessions", adminA, { school: SCHOOL_B() })).status).toBe(403);

    // Teachers can read but not write.
    expect((await api("/sessions", teacherA, { school: SCHOOL_A() })).status).toBe(200);
    const create = await api("/sessions", teacherA, {
      method: "POST", school: SCHOOL_A(), body: { name: "Nope", start_date: "2070-04-01", end_date: "2071-03-31" },
    });
    expect(create.status).toBe(403);

    // Deleting needs the exact name; an in-use session is refused even then.
    const aSessions = await (await api("/sessions", adminA, { school: SCHOOL_A() })).json();
    const past = aSessions.find((s: { name: string }) => s.name === "2025-26");
    const wrong = await api(`/sessions/${past.id}`, adminA, { method: "DELETE", school: SCHOOL_A(), body: { confirm_name: "nope" } });
    expect(wrong.status).toBe(422);
    const inUse = await api(`/sessions/${past.id}`, adminA, { method: "DELETE", school: SCHOOL_A(), body: { confirm_name: "2025-26" } });
    expect(inUse.status).toBe(409);
    expect((await inUse.json()).detail).toContain("Archive it instead");
  });
});
