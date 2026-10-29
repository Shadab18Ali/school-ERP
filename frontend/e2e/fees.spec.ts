import { expect, test, type Page } from "@playwright/test";
import { accessToken, api, SCHOOL_A, SCHOOL_B, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });

let class1 = "";
let structureId = "";

test.beforeAll(async () => {
  const t = await accessToken("ADMIN_A");
  await api("/classes/bulk", t, { method: "POST", school: SCHOOL_A(), body: { classes: [{ name: "Class 1", display_order: 4 }, { name: "Class 2", display_order: 5 }] } });
  const classes = (await (await api("/classes", t, { school: SCHOOL_A() })).json()).items;
  class1 = classes.find((c: { name: string }) => c.name === "Class 1").id;
});

async function addItem(page: Page, o: { head: string; amount: string; frequency: string; due?: string; optional?: boolean; skip?: string[] }) {
  await page.getByRole("button", { name: "Add fee item" }).first().click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Fee head").selectOption({ label: o.head });
  await d.getByLabel(/^Amount/).fill(o.amount);
  await d.getByLabel("Frequency").selectOption({ label: o.frequency });
  if (o.due) await d.getByLabel(/due in/i).selectOption({ label: o.due });
  for (const m of o.skip ?? []) await d.getByRole("button", { name: m, exact: true }).click();
  if (o.optional) await d.getByLabel(/Optional fee/).check();
  await d.getByTestId("save-fee-item").click();
  await expect(d).toHaveCount(0);
  await expect(page.getByTestId(`fee-item-${o.head}`)).toBeVisible();
}

test.describe("fee structures (accountant)", () => {
  test("set up fee heads and build the Class 5 example on Class 1", async ({ page }) => {
    await signIn(page, "ACCOUNTANT_A", "/fees");
    await expect(page.getByRole("heading", { level: 1, name: "Fee structures" })).toBeVisible();
    await page.getByRole("button", { name: "Fee heads" }).click();
    await page.getByRole("button", { name: /Add common heads \(10\)/ }).click();
    await expect(page.getByTestId("heads-list").getByRole("listitem")).toHaveCount(10);
    await page.getByRole("button", { name: "Done" }).click();

    await page.getByTestId("no-structure-Class 1").getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/\/fees\/structures\/[0-9a-f-]{36}$/);
    structureId = page.url().split("/").pop()!;
    await expect(page.getByRole("heading", { level: 1, name: "Class 1 fees" })).toBeVisible();

    await addItem(page, { head: "Admission Fee", amount: "2000", frequency: "One-time" });
    await addItem(page, { head: "Annual Fee", amount: "5000", frequency: "Yearly" });
    await addItem(page, { head: "Exam Fee", amount: "1000", frequency: "Yearly", due: "Sep" });
    await addItem(page, { head: "Tuition Fee", amount: "1500", frequency: "Monthly" });
    await addItem(page, { head: "Transport Fee", amount: "1000", frequency: "Monthly", optional: true, skip: ["May", "Jun"] });

    // every figure below comes from the database
    await expect(page.getByTestId("total-compulsory")).toHaveText("₹26,000");
    await expect(page.getByTestId("total-monthly")).toHaveText("₹1,500");
    await expect(page.getByTestId("total-one-time")).toHaveText("₹2,000");
    await expect(page.getByTestId("total-optional")).toHaveText("₹10,000");
    await expect(page.getByTestId("fee-item-Tuition Fee").getByTestId("annual-amount")).toHaveText("₹18,000");
    await expect(page.getByTestId("fee-item-Transport Fee").getByTestId("annual-amount")).toHaveText("₹10,000");
    await expect(page.getByTestId("fee-item-Transport Fee")).toContainText("Except May, Jun");
    await expect(page.getByTestId("schedule-Apr 2026")).toContainText("₹8,500");
    await expect(page.getByTestId("schedule-May 2026")).toContainText("₹1,500");
    await expect(page.getByTestId("schedule-May 2026")).not.toContainText("Transport");
    await expect(page.getByTestId("schedule-Sep 2026")).toContainText("Exam Fee");
    await expect(page.getByTestId("schedule-Sep 2026")).toContainText("₹2,500");
  });

  test("edit and remove items; totals follow", async ({ page }) => {
    await signIn(page, "ACCOUNTANT_A", `/fees/structures/${structureId}`);
    await page.getByRole("button", { name: "Actions for Tuition Fee" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await page.getByRole("dialog").getByLabel(/^Amount/).fill("1600");
    await page.getByRole("dialog").getByTestId("save-fee-item").click();
    await expect(page.getByTestId("total-compulsory")).toHaveText("₹27,200");

    await page.getByRole("button", { name: "Actions for Transport Fee" }).click();
    await page.getByRole("menuitem", { name: "Remove" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByTestId("total-optional")).toHaveText("₹0");
    await expect(page.getByTestId("fee-item-Transport Fee")).toHaveCount(0);
  });

  test("validation, used heads hidden, and a new head on the fly", async ({ page }) => {
    await signIn(page, "ACCOUNTANT_A", `/fees/structures/${structureId}`);
    await page.getByRole("button", { name: "Add fee item" }).first().click();
    const d = page.getByRole("dialog");
    await expect(d.getByLabel("Fee head").locator("option", { hasText: "Tuition Fee" })).toHaveCount(0); // already used
    for (const bad of ["12.345", "0", "abc"]) {
      await d.getByLabel(/^Amount/).fill(bad);
      await d.getByTestId("save-fee-item").click();
      await expect(d.getByTestId("item-error")).toHaveText("Enter an amount in rupees, e.g. 1500 or 1500.50.");
    }
    await d.getByLabel(/^Amount/).fill("300");
    for (const m of ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"]) {
      await d.getByRole("button", { name: m, exact: true }).click();
    }
    await d.getByTestId("save-fee-item").click();
    await expect(d.getByTestId("item-error")).toHaveText("Choose at least one month.");

    await d.getByLabel("Fee head").selectOption({ label: "+ New fee head…" });
    await d.getByLabel("New fee head name").fill("Smart Class Fee");
    await d.getByLabel("Frequency").selectOption({ label: "Quarterly" });
    await d.getByLabel(/due in/i).selectOption({ label: "Jul" });
    await d.getByTestId("save-fee-item").click();
    await expect(page.getByTestId("fee-item-Smart Class Fee")).toContainText("Quarterly ×3");
    await expect(page.getByTestId("fee-item-Smart Class Fee").getByTestId("annual-amount")).toHaveText("₹900");
    await expect(page.getByTestId("total-compulsory")).toHaveText("₹28,100");
  });

  test("deactivate and activate a structure", async ({ page }) => {
    await signIn(page, "ACCOUNTANT_A", `/fees/structures/${structureId}`);
    await page.getByTestId("toggle-structure").click();
    await page.getByRole("dialog").getByRole("button", { name: "Deactivate" }).click();
    await expect(page.getByText("This structure is inactive")).toBeVisible();
    await page.goto("/fees");
    await expect(page.getByTestId("structure-card-Class 1")).toContainText("Inactive");
    await page.goto(`/fees/structures/${structureId}`);
    await page.getByTestId("toggle-structure").click();
    await page.getByRole("dialog").getByRole("button", { name: "Activate" }).click();
    await expect(page.getByText("This structure is inactive")).toHaveCount(0);
  });

  test("copy to another class with a 10% increase, rounded to ₹10", async ({ page }) => {
    await signIn(page, "ACCOUNTANT_A", `/fees/structures/${structureId}`);
    await page.getByRole("button", { name: "Copy" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("Into session").selectOption({ label: "2026-27 (current)" });
    await expect(d.getByLabel("Class 1 (already has a fee structure)", { exact: true })).toBeDisabled();
    await d.getByLabel("Class 2", { exact: true }).check();
    await d.getByLabel(/^Change amounts by/).fill("10");
    await d.getByLabel("Round to").selectOption({ label: "Nearest ₹10" });
    await d.getByTestId("confirm-copy").click();
    await expect(page.getByText("Copied to 1 class.")).toBeVisible();

    await page.goto("/fees");
    // 2200 + 5500 + 1100 + 1760 x 12 + quarterly 330 x 3 = 30910
    await expect(page.getByTestId("structure-card-Class 2").getByTestId("annual-total")).toHaveText("₹30,910");
    await expect(page.getByTestId("structure-card-Class 1").getByTestId("annual-total")).toHaveText("₹28,100");
  });

  test("an archived session's fee structures are read-only", async ({ page }) => {
    const t = await accessToken("ADMIN_A");
    const sessions: { id: string; name: string }[] = await (await api("/sessions", t, { school: SCHOOL_A() })).json();
    const past = sessions.find((s) => s.name === "2025-26")!.id;
    await api(`/sessions/${past}/archive`, t, { method: "POST", school: SCHOOL_A() });
    try {
      await signIn(page, "ACCOUNTANT_A", `/fees?session=${past}`);
      await expect(page.getByText("2025-26 is archived, so its fee structures are read-only.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Create" })).toHaveCount(0);
      const res = await api("/fee-structures", t, { method: "POST", school: SCHOOL_A(), body: { academic_session_id: past, class_id: class1 } });
      expect(res.status).toBe(409);
    } finally {
      await api(`/sessions/${past}/restore`, t, { method: "POST", school: SCHOOL_A() });
    }
  });
});

test.describe("fee structures: access", () => {
  test("parents can't open the school's fee structures (they use the parent portal)", async ({ page }) => {
    await signIn(page, "PARENT_A", "/fees");
    await expect(page.getByTestId("access-denied")).toBeVisible();
    await expect(page.getByRole("button", { name: "Fee heads" })).toHaveCount(0);
  });

  test("API: roles and school isolation", async () => {
    const [teacher, parent, adminB, admin] = await Promise.all([accessToken("TEACHER_A"), accessToken("PARENT_A"), accessToken("ADMIN_B"), accessToken("ADMIN_A")]);
    expect((await api("/fee-structures", teacher, { school: SCHOOL_A() })).status).toBe(403);
    expect((await api("/fee-structures", parent, { school: SCHOOL_A() })).status).toBe(403);
    expect((await api(`/fee-structures/${structureId}`, adminB, { school: SCHOOL_B() })).status).toBe(404);
    expect((await api(`/fee-structures/${structureId}`, adminB, { school: SCHOOL_A() })).status).toBe(403);
    // school admins can manage fees too
    const detail = await (await api(`/fee-structures/${structureId}`, admin, { school: SCHOOL_A() })).json();
    expect(detail.totals.annual_compulsory).toBe("28100.00"); // exact decimal string, not a float
  });
});
