import { readFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { accessToken, api, runTag, SCHOOL_A, SCHOOL_B, signIn } from "./helpers";

test.describe.configure({ mode: "serial", timeout: 90_000 }); // several sign-ins per test
const tag = runTag();
const paper = `A4 paper ${tag}`;
const pc = `Desktop ${tag}`;
const oops = `Oops ${tag}`;
const teacher = "E2E Teacher A";       // the staff record linked to TEACHER_A's login (seeded)
let paperId = "";
let pcId = "";

const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

/** A fresh browser context per person (switching users on one page can race the sign-out). */
async function asUser(browser: Browser, who: Parameters<typeof signIn>[1]): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, who);
  return page;
}

test("the admin adds stationery with its purchase; quantities follow the unit", async ({ browser }) => {
  const page = await asUser(browser, "ADMIN_A");
  await page.goto("/inventory?tab=Items");
  await page.getByTestId("add-item").click();
  await page.getByTestId("item-name").fill(paper);
  await page.getByTestId("item-category").selectOption("stationery");
  await page.getByTestId("item-unit").selectOption("ream");
  await page.getByTestId("item-location").fill("Store room");
  await page.getByTestId("item-min").fill("10");
  await page.getByTestId("opening-qty").fill("2.5");
  await page.getByTestId("save-item").click();
  await expect(page.getByTestId("item-error")).toContainText("whole number");
  await page.getByTestId("opening-qty").fill("30");
  await page.getByTestId("opening-reason").selectOption("purchase");
  await page.getByTestId("opening-cost").fill("250");
  await page.getByTestId("opening-vendor").fill("Gupta Stationers");
  await page.getByTestId("save-item").click();
  const row = page.getByTestId(`item-${paper}`);
  await expect(row.getByTestId("item-qty")).toHaveText("30 reams");
  await expect(row).toContainText("₹250 each");
  await expect(row).toContainText(/INV-\d{5}/);
  await row.getByRole("link", { name: paper }).click();
  await expect(page).toHaveURL(/\/inventory\/items\/[0-9a-f-]{36}$/);
  paperId = page.url().split("/").pop()!;
  await expect(page.getByTestId("item-quantity")).toHaveText("30 reams");
  await expect(page.getByTestId("item-history")).toContainText("Gupta Stationers");
});

test("stock out to a staff member and back in; no taking out more than is there", async ({ browser }) => {
  const page = await asUser(browser, "ADMIN_A");
  await page.goto(`/inventory/items/${paperId}`);

  await page.getByTestId("stock-out").click();
  await page.getByTestId("stock-reason").selectOption("issued");
  await page.getByTestId("stock-qty").fill("25");
  await page.getByTestId("confirm-stock").click();
  await expect(page.getByTestId("stock-error")).toContainText("staff member");
  await page.getByTestId("stock-teacher").selectOption({ label: `${teacher} (EMP-E2E-A)` });
  await page.getByTestId("stock-reference").fill(`SLIP-${tag}`);
  await page.getByTestId("confirm-stock").click();
  await expect(page.getByTestId("item-quantity")).toHaveText("5 reams");
  await expect(page.getByTestId("low-stock")).toBeVisible();          // 5 is at or below the reorder level of 10

  await page.getByTestId("stock-out").click();
  await page.getByTestId("stock-reason").selectOption("consumed");
  await page.getByTestId("stock-qty").fill("6");
  await page.getByTestId("confirm-stock").click();
  await expect(page.getByTestId("stock-error")).toContainText("Only 5 reams in stock");
  await page.getByRole("button", { name: "Cancel" }).click();
  // the database refuses it too, whatever the page says
  const t = await accessToken("ADMIN_A");
  const r = await api(`/inventory/items/${paperId}/stock`, t, { method: "POST", school: SCHOOL_A(), body: { kind: "out", reason: "consumed", quantity: "6", moved_on: today(), recipient: "x" } });
  expect(r.status).toBe(409);
  expect((await r.json()).detail).toContain("Only 5 reams");

  await page.getByTestId("stock-in").click();
  await page.getByTestId("stock-reason").selectOption("purchase");
  await page.getByTestId("stock-qty").fill("20");
  await page.getByTestId("stock-cost").fill("260");
  await page.getByTestId("stock-vendor").fill("Gupta Stationers");
  await page.getByTestId("confirm-stock").click();
  await expect(page.getByTestId("item-quantity")).toHaveText("25 reams");
  await expect(page.getByTestId("low-stock")).toHaveCount(0);
  await expect(page.getByTestId("item-quantity").locator("..")).toContainText("₹260 each");  // the latest purchase cost

  const history = page.getByTestId("item-history");
  await expect(history.getByTestId("movement-out")).toHaveCount(1);
  await expect(history.getByTestId("movement-in")).toHaveCount(2);
  await expect(history.getByTestId("movement-out")).toContainText(`to ${teacher}`);
  await expect(history.getByTestId("movement-out").getByTestId("movement-qty")).toHaveText("−25 reams");
});

test("assigning an item and moving it are recorded; the staff member sees what they hold", async ({ browser }) => {
  const t = await accessToken("ADMIN_A");
  const r = await api("/inventory/items", t, { method: "POST", school: SCHOOL_A(), body: {
    name: pc, category: "computer", location: "Computer Lab", condition: "new", brand_model: "Dell OptiPlex", serial_number: `SN-${tag}`,
    opening: { quantity: "1", reason: "purchase", moved_on: today(), unit_cost: "42000" } } });
  expect(r.status).toBe(201);
  pcId = (await r.json()).id;

  const page = await asUser(browser, "ADMIN_A");
  await page.goto(`/inventory/items/${pcId}`);
  await page.getByTestId("edit-item").click();
  await page.getByTestId("item-location").fill("Staff room");
  await page.getByTestId("item-condition").selectOption("needs_repair");
  await page.getByTestId("item-assignee").selectOption({ label: `${teacher} (EMP-E2E-A)` });
  await page.getByTestId("save-item").click();
  await expect(page.getByTestId("item-location-value")).toHaveText("Staff room");
  await expect(page.getByTestId("item-assignee-value")).toContainText(teacher);
  const change = page.getByTestId("item-history").getByTestId("movement-change");
  await expect(change).toContainText("Computer Lab → Staff room");
  await expect(change).toContainText("Needs repair");
  await expect(change).toContainText(`nobody → ${teacher}`);

  const staff = await asUser(browser, "TEACHER_A");
  await staff.goto("/profile");
  await expect(staff.getByTestId("my-items")).toContainText(pc);
  await expect(staff.getByTestId("my-items")).toContainText(`SN-${tag}`);
  await expect(staff.getByTestId("my-items")).not.toContainText(paper);   // only what is assigned to them
  await staff.goto("/teaching");
  await expect(staff.getByTestId("my-items")).toContainText(pc);
});

test("dashboard, filters, history and CSV", async ({ browser }) => {
  const page = await asUser(browser, "ADMIN_A");
  await page.goto("/inventory");
  await expect(page.getByTestId("attention-list")).toContainText(pc);
  await expect(page.getByTestId("kpi-value-value")).toContainText("₹");
  await page.getByTestId("by-category").getByRole("link", { name: "Computer" }).click();
  await expect(page.getByTestId(`item-${pc}`)).toBeVisible();
  await expect(page.getByTestId(`item-${paper}`)).toHaveCount(0);

  await page.goto("/inventory?tab=Stock%20history");
  await page.getByTestId("history-kind").selectOption("out");
  await page.getByTestId("history-search").fill(tag);
  await expect(page.getByTestId("history-list").getByTestId("movement-out")).toHaveCount(1);
  await expect(page.getByTestId("history-list").getByTestId("movement-in")).toHaveCount(0);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).click()]);
  expect(download.suggestedFilename()).toBe("inventory-stock-history.csv");
  const text = readFileSync(await download.path()).toString("utf8");
  expect(text).toContain("Date,Code,Item,In / out,Reason");
  expect(text).toContain(`SLIP-${tag}`);
});

test("archived items take no stock; only a mistaken item can be deleted", async ({ browser }) => {
  const page = await asUser(browser, "ADMIN_A");
  await page.goto(`/inventory/items/${paperId}`);
  await page.getByRole("button", { name: "More item actions" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("button", { name: "Delete item" }).click();
  await expect(page.getByText("This item has stock history, so it is kept for the records. Archive it instead.")).toBeVisible();

  await page.getByRole("button", { name: "More item actions" }).click();
  await page.getByRole("menuitem", { name: "Archive…" }).click();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByText("Archived", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("stock-in")).toHaveCount(0);
  const t = await accessToken("ADMIN_A");
  expect((await api(`/inventory/items/${paperId}/stock`, t, { method: "POST", school: SCHOOL_A(), body: { kind: "in", reason: "found", quantity: "1", moved_on: today() } })).status).toBe(409);
  await page.getByRole("button", { name: "More item actions" }).click();
  await page.getByRole("menuitem", { name: "Restore" }).click();
  await expect(page.getByTestId("stock-in")).toBeVisible();

  // an item entered by mistake (only its first stock) can go
  const r = await api("/inventory/items", t, { method: "POST", school: SCHOOL_A(), body: { name: oops, category: "other", location: "Office", opening: { quantity: "2", moved_on: today() } } });
  const oopsId = (await r.json()).id;
  await page.goto(`/inventory/items/${oopsId}`);
  await page.getByRole("button", { name: "More item actions" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("button", { name: "Delete item" }).click();
  await expect(page).toHaveURL(/\/inventory\?tab=Items/);
  expect((await api(`/inventory/items/${oopsId}`, t, { school: SCHOOL_A() })).status).toBe(404);
});

test("accountants can look but not change; others and other schools see nothing", async ({ browser }) => {
  const page = await asUser(browser, "ACCOUNTANT_A");
  await page.goto("/inventory");
  await expect(page.getByTestId("inventory-dashboard")).toBeVisible();
  await page.goto("/inventory?tab=Items");
  await expect(page.getByTestId(`item-${paper}`)).toBeVisible();
  await expect(page.getByTestId("add-item")).toHaveCount(0);
  await page.goto(`/inventory/items/${paperId}`);
  await expect(page.getByTestId("item-heading")).toHaveText(paper);
  await expect(page.getByTestId("stock-in")).toHaveCount(0);
  await expect(page.getByTestId("edit-item")).toHaveCount(0);

  const acct = await accessToken("ACCOUNTANT_A");
  expect((await api(`/inventory/items/${paperId}/stock`, acct, { method: "POST", school: SCHOOL_A(), body: { kind: "out", reason: "lost", quantity: "1", moved_on: today() } })).status).toBe(403);
  expect((await api("/inventory/items", acct, { method: "POST", school: SCHOOL_A(), body: { name: "Chair", category: "furniture", location: "Hall" } })).status).toBe(403);

  for (const who of ["TEACHER_A", "LIBRARIAN_A", "PARENT_A", "STUDENT_A"] as const) {
    const tk = await accessToken(who);
    expect((await api("/inventory/items", tk, { school: SCHOOL_A() })).status, who).toBe(403);
    expect((await api(`/inventory/items/${pcId}/history`, tk, { school: SCHOOL_A() })).status, who).toBe(403);
  }
  const parentMine = await (await api("/inventory/mine", await accessToken("PARENT_A"), { school: SCHOOL_A() })).json();
  expect(parentMine).toEqual([]);

  const b = await accessToken("ADMIN_B");
  expect((await api(`/inventory/items/${paperId}`, b, { school: SCHOOL_B() })).status).toBe(404);
  expect((await api(`/inventory/items/${paperId}/stock`, b, { method: "POST", school: SCHOOL_B(), body: { kind: "out", reason: "lost", quantity: "1", moved_on: today() } })).status).toBe(404);
  expect((await api(`/inventory/items/${paperId}`, b, { school: SCHOOL_A() })).status).toBe(403);
  const bItems: { name: string }[] = (await (await api("/inventory/items", b, { school: SCHOOL_B()})).json()).items;
  expect(bItems.some((i) => i.name === paper)).toBe(false);
});

test("@mobile inventory works on a phone without sideways scrolling", async ({ page }) => {
  await signIn(page, "ADMIN_A");
  for (const tab of ["", "?tab=Items", "?tab=Stock%20history"]) {
    await page.goto(`/inventory${tab}`);
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `no sideways scroll on /inventory${tab}`).toBeLessThanOrEqual(1);
  }
  const link = page.getByTestId("item-list").getByRole("link").first();
  await page.goto("/inventory?tab=Items");
  await page.waitForLoadState("networkidle");
  if (await link.count()) {
    await link.click();
    await expect(page.getByTestId("item-heading")).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  }
});
