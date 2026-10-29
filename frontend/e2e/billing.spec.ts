import { expect, test } from "@playwright/test";
import { accessToken, api, runTag, SCHOOL_A, SCHOOL_C, signIn } from "./helpers";

/** Subscription billing, on School C only (its subscription ends and comes back here; Schools A and B
 * are left alone): the platform's billing details, a plan from a template, a subscription without a
 * trial, the school paying its invoice through Razorpay (the harness's mock), the webhook notices,
 * a payment recorded by hand and a refund, cancellation, and the read-only state. */
const tag = runTag();
const plan = `Basic ${tag}`;

test.describe.configure({ mode: "serial" });

test("super admin: billing details, a plan from the Basic template, and School C started without a trial", async ({ page }) => {
  await signIn(page, "SUPER", "/admin/billing");
  await expect(page.getByRole("heading", { level: 1, name: "Billing setup" })).toBeVisible();
  await page.getByTestId("bs-legal-name").fill(`E2E Platform ${tag}`);
  await page.getByTestId("bs-gstin").fill("07AAACE1234F1Z5");
  await page.getByTestId("bs-address").fill("1 Test Road, New Delhi");
  await page.getByTestId("bs-state").fill("Delhi");
  await page.getByTestId("bs-prefix").fill("inv/");
  await page.getByTestId("bs-tax-label").fill("GST");
  await page.getByTestId("bs-tax-rate").fill("18");
  await page.getByTestId("bs-lead").fill("7");
  await page.getByTestId("bs-due").fill("10");
  await page.getByTestId("save-billing-settings").click();
  await expect(page.getByTestId("billing-error")).toContainText("prefix");
  await page.getByTestId("bs-prefix").fill("E2E");
  await page.getByTestId("save-billing-settings").click();
  await expect(page.getByTestId("billing-error")).toHaveCount(0);
  await expect(page.getByText("Billing details saved")).toBeVisible();
  await expect(page.getByTestId("online-payments-status")).toContainText("Schools can pay invoices online");
  await expect(page.getByTestId("online-payments-status")).toContainText("Webhook secret set");
  await expect(page.getByTestId("online-payments-status")).not.toContainText("mock_secret");

  await page.goto("/admin/plans");
  await page.getByTestId("template-basic").click();
  const d = page.getByRole("dialog");
  await expect(d.getByTestId("plan-feature-reports")).not.toBeChecked();
  await d.getByTestId("plan-code").fill(`E2E-BAS-${tag}`);
  await d.getByTestId("plan-name").fill(plan);
  await d.getByTestId("plan-monthly").fill("1000");
  await d.getByTestId("plan-yearly").fill("10000");
  await d.getByTestId("plan-trial").fill("0");
  await d.getByTestId("plan-grace").fill("5");
  await d.getByTestId("plan-limit-students").fill("50");
  await d.getByTestId("save-plan").click();
  const card = page.getByTestId("plan-card").filter({ hasText: plan });
  await expect(card.getByTestId("plan-terms")).toHaveText("No trial · 5-day grace");
  await expect(card.getByTestId("plan-limits")).toContainText("Reports and exports — not included");

  await page.goto(`/admin/schools/${SCHOOL_C()}?tab=subscription`);
  await page.getByTestId("change-subscription").click();
  const s = page.getByRole("dialog");
  await s.getByTestId("sub-plan").selectOption({ label: plan });
  await s.getByTestId("sub-cycle").selectOption("monthly");
  await s.getByTestId("sub-trial-choice").selectOption("none");
  await s.getByTestId("save-subscription").click();
  // the first invoice is issued at once; until it is due the school keeps working
  await expect(page.getByTestId("plan-state")).toContainText("Payment due");
  const row = page.getByTestId("invoice-row").first();
  await expect(row).toContainText("E2E/");
  await expect(row).toContainText("₹1,180");   // 1,000 + 18% (IGST: School C isn't in Delhi)
  await expect(row.getByTestId("invoice-state")).toHaveText("Due");
});

test("School C's admin sees what the plan leaves out, and pays the invoice online", async ({ page }) => {
  await signIn(page, "ADMIN_C", "/settings");
  const planCard = page.getByTestId("plan-card");
  await expect(planCard.getByTestId("plan-name")).toHaveText(plan);
  await expect(planCard.getByTestId("plan-state")).toContainText("Payment due");
  await expect(planCard.getByTestId("ent-reports")).toContainText("not included");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Reports", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Analytics", exact: true })).toHaveCount(0);
  await page.goto("/reports");
  await expect(page.getByTestId("feature-not-in-plan")).toBeVisible();
  expect((await api("/reports/students", await accessToken("ADMIN_C"), { school: SCHOOL_C() })).status).toBe(403);

  await page.goto("/settings");
  await planCard.getByTestId("pay-invoice").click();
  const rzp = page.getByRole("dialog", { name: "Razorpay Checkout (test)" });
  await expect(rzp.getByTestId("mock-rzp-amount")).toContainText("1180.00");
  await rzp.getByTestId("mock-pay-upi").click();
  await expect(planCard.getByTestId("plan-state")).toContainText("Active");
  await expect(planCard.getByTestId("invoice-row").first().getByTestId("invoice-state")).toHaveText("Paid");
  await expect(planCard.getByTestId("payment-row").first()).toContainText("Online (Razorpay)");

  const download = page.waitForEvent("download");
  await planCard.getByTestId("invoice-pdf").first().click();
  expect((await download).suggestedFilename()).toMatch(/^E2E-\d{4}-\d{2}-\d{5}\.pdf$/);

  // on a phone the billing tables scroll inside their card; the page itself never scrolls sideways
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(planCard.getByTestId("plan-state")).toContainText("Active");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  // nobody else sees School C's billing
  expect((await api("/school/billing", await accessToken("ADMIN_A"), { school: SCHOOL_C() })).status).toBe(403);
  const a = await (await api("/school/billing", await accessToken("ADMIN_A"), { school: SCHOOL_A() })).json();
  expect(JSON.stringify(a)).not.toContain(SCHOOL_C());
});

test("super admin: Razorpay's notices, the invoice list, and a payment recorded by hand with a refund", async ({ page }) => {
  await signIn(page, "SUPER", "/admin/billing");
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("webhook-events")).toContainText("payment.captured", { timeout: 1000 });
  }).toPass({ timeout: 15_000 });

  await page.goto("/admin/invoices?state=paid");
  await expect(page.getByTestId("platform-invoice-row").filter({ hasText: "E2E Billing School C" }).first()).toBeVisible();

  await page.goto(`/admin/schools/${SCHOOL_C()}?tab=subscription`);
  await expect(page.getByTestId("payment-row").first()).toContainText("Refund in Razorpay");
  await page.getByTestId("issue-invoice").click();
  const due = page.getByTestId("invoice-row").filter({ has: page.getByTestId("invoice-state").getByText("Due", { exact: true }) });
  await expect(due).toHaveCount(1);
  await due.getByTestId("record-payment").click();
  const pay = page.getByRole("dialog");
  await expect(pay.getByTestId("payment-amount")).toHaveValue("1180.00");
  await pay.getByTestId("payment-method").selectOption("bank_transfer");
  await pay.getByTestId("save-payment").click();
  await expect(pay.getByTestId("payment-error")).toContainText("reference");
  await pay.getByTestId("payment-reference").fill(`UTR${tag}`);
  await pay.getByTestId("save-payment").click();
  await expect(page.getByTestId("invoice-state").getByText("Due", { exact: true })).toHaveCount(0);
  const manual = page.getByTestId("payment-row").filter({ hasText: `UTR${tag}` });
  await manual.getByTestId("refund-payment").click();
  await page.getByRole("dialog").getByTestId("refund-amount").fill("180");
  await page.getByRole("dialog").getByTestId("save-refund").click();
  await expect(manual.getByTestId("payment-refunded")).toContainText("₹180");
  await expect(page.getByTestId("invoice-state").getByText("Part paid", { exact: true })).toHaveCount(1);
  await expect(page.getByTestId("plan-state")).toContainText("Active");   // the current period was paid online
});

test("cancelling: at period end by the school, at once by the platform (read-only), and back", async ({ page, browser }) => {
  await signIn(page, "ADMIN_C", "/settings");
  const planCard = page.getByTestId("plan-card");
  await planCard.getByTestId("school-cancel").click();
  await page.getByTestId("school-cancel-reason").fill("Trying another product");
  await page.getByTestId("confirm-action").click();
  await expect(planCard.getByTestId("plan-state")).toContainText("Ends at period end");
  await planCard.getByTestId("school-resume").click();
  await page.getByTestId("confirm-action").click();
  await expect(planCard.getByTestId("plan-state")).toContainText("Active");

  const ctx = await browser.newContext();
  const sup = await ctx.newPage();
  await signIn(sup, "SUPER", `/admin/schools/${SCHOOL_C()}?tab=subscription`);
  await sup.getByTestId("sub-cancel-now").click();
  await sup.getByTestId("confirm-action").click();
  await expect(sup.getByTestId("plan-state")).toContainText("Cancelled");

  // the school is read-only: told on every page, and the API refuses changes
  await page.goto("/dashboard");
  await expect(page.getByTestId("read-only-banner")).toBeVisible();
  const tk = await accessToken("ADMIN_C");
  const r = await api("/notices", tk, { school: SCHOOL_C(), method: "POST", body: { title: "Hello", body: "Body text", audience: "everyone" } });
  expect(r.status).toBe(402);
  expect((await api("/notices", tk, { school: SCHOOL_C() })).status).toBe(200);
  // the platform is never read-only, and brings it back
  await sup.getByTestId("sub-reactivate").click();
  await sup.getByTestId("confirm-action").click();
  await expect(sup.getByTestId("plan-state")).toContainText("Active");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("read-only-banner")).toHaveCount(0);
  await ctx.close();
});
