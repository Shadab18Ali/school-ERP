import { expect, test } from "@playwright/test";
import { accessToken, api, runTag, SCHOOL_A, SCHOOL_B, signIn } from "./helpers";

/** The platform: plans, a school's subscription, usage, administrators, system analytics — and what
 * schools see of it (their own plan only). Billing itself (invoices, payment, expiry) is in billing.spec. */
const tag = runTag();

test.describe.configure({ mode: "serial" });

test("super admin: a plan, a school's subscription, its usage, and the platform's figures", async ({ page }) => {
  await signIn(page, "SUPER", "/admin/plans");
  await expect(page.getByRole("heading", { level: 1, name: "Plans" })).toBeVisible();
  // the Enterprise template switches every feature on; everything with a number is entered here
  await page.getByTestId("template-enterprise").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("plan-feature-reports")).toBeChecked();
  await expect(dialog.getByTestId("plan-monthly")).toHaveValue("");
  await dialog.getByTestId("plan-code").fill(`E2E-${tag}`);
  await dialog.getByTestId("plan-name").fill(`School Plus ${tag}`);
  await dialog.getByTestId("plan-monthly").fill("-5");
  await dialog.getByTestId("plan-yearly").fill("30000");
  await dialog.getByTestId("save-plan").click();
  await expect(dialog.getByTestId("plan-error")).toContainText("prices");
  await dialog.getByTestId("plan-monthly").fill("3000");
  await dialog.getByTestId("save-plan").click();
  await expect(dialog.getByTestId("plan-error")).toContainText("trial");
  await dialog.getByTestId("plan-trial").fill("30");
  await dialog.getByTestId("plan-grace").fill("7");
  await dialog.getByTestId("plan-limit-students").fill("800");
  await dialog.getByTestId("plan-features").fill("Fees and receipts\nAttendance and exams");
  await dialog.getByTestId("save-plan").click();
  const card = page.getByTestId("plan-card").filter({ hasText: `School Plus ${tag}` });
  await expect(card).toContainText("₹3,000");
  await expect(card).toContainText("₹30,000 a year");
  await expect(card.getByTestId("plan-terms")).toHaveText("30-day trial · 7-day grace");
  await expect(card.getByTestId("plan-limits")).toContainText("Students: 800 students");
  await expect(card.getByTestId("plan-limits")).toContainText("Teachers: No limit");
  await expect(card.getByTestId("plan-limits")).toContainText("AI assistant (coming later)");
  await expect(card.getByTestId("plan-schools")).toHaveText("0 schools");

  // start School A on it, monthly, at an agreed price, with the plan's 30-day trial (so it keeps working through the tests)
  await page.goto(`/admin/schools/${SCHOOL_A()}?tab=subscription`);
  await page.getByTestId("change-subscription").click();
  const sub = page.getByRole("dialog");
  await sub.getByTestId("sub-plan").selectOption({ label: `School Plus ${tag}` });
  await sub.getByTestId("sub-cycle").selectOption("monthly");
  await expect(sub.getByTestId("sub-price")).toHaveAttribute("placeholder", "3000.00");
  await sub.getByTestId("sub-price").fill("2500");
  await expect(sub.getByTestId("sub-trial-choice")).toContainText("The plan's trial (30 days)");
  await sub.getByTestId("save-subscription").click();
  await expect(page.getByTestId("plan-name")).toHaveText(`School Plus ${tag}`);
  await expect(page.getByTestId("plan-price")).toHaveText("₹2,500");
  await expect(page.getByTestId("plan-state")).toContainText("Trial");
  await expect(page.getByTestId("invoice-table")).toHaveCount(0);   // nothing is billed during a trial
  await expect(page.getByTestId("ent-reports")).not.toContainText("not included");
  await expect(page.getByTestId("subscription-history").getByRole("row").nth(1)).toContainText("Started");
  await expect(page.getByTestId("subscription-history").getByRole("row").nth(1)).toContainText("E2E Super Admin");

  // usage, measured from the school's records, against the plan's limits
  const t = await accessToken("SUPER");
  const usage = await (await api(`/admin/schools/${SCHOOL_A()}/usage`, t)).json();
  await page.getByTestId("school-tab-usage").click();
  await expect(page.getByTestId("usage-students")).toContainText(`${usage.students.active.toLocaleString("en-IN")} of 800`);
  await expect(page.getByTestId("usage-teachers")).toContainText(`${usage.teachers.toLocaleString("en-IN")} · no limit`);

  // the schools list and the platform's figures
  await page.goto("/admin/schools");
  await expect(page.getByRole("row", { name: /E2E Test School A/ }).getByTestId("school-plan")).toContainText(`School Plus ${tag}`);
  await expect(page.getByRole("row", { name: /E2E Test School A/ }).getByTestId("school-plan")).toContainText("Trial");
  await page.goto("/admin/analytics");
  const figures = await (await api("/admin/analytics", t)).json();
  await expect(page.getByTestId("pa-schools")).toContainText(String(figures.schools.total));
  await expect(page.getByTestId("pa-trials")).toContainText(String(figures.subscriptions.by_state.trialing));
  // a trial earns nothing yet
  expect(figures.subscriptions.by_plan.find((p: { plan: string }) => p.plan === `School Plus ${tag}`).mrr).toBe(0);
});

test("a school admin sees their own plan only; other roles and schools see none of the platform", async ({ page }) => {
  await signIn(page, "ADMIN_A", "/settings");
  const planCard = page.getByTestId("plan-card");
  await expect(planCard.getByTestId("plan-name")).toHaveText(`School Plus ${tag}`);
  await expect(planCard.getByTestId("plan-state")).toContainText("Trial");
  await expect(planCard.getByTestId("ent-students")).toContainText("800 students");
  await expect(planCard).not.toContainText("E2E Test School B");
  await expect(planCard).not.toContainText("Platform notes");
  for (const who of ["ADMIN_A", "ACCOUNTANT_A", "TEACHER_A", "PARENT_A", "STUDENT_A", "ADMIN_B"] as const) {
    const tk = await accessToken(who);
    for (const path of ["/admin/plans", "/admin/analytics", "/admin/invoices", "/admin/billing/settings", `/admin/schools/${SCHOOL_A()}/subscription`,
      `/admin/schools/${SCHOOL_A()}/usage`]) {
      expect((await api(path, tk, { school: SCHOOL_A() })).status, `${who} ${path}`).toBe(403);
    }
  }
  for (const who of ["ACCOUNTANT_A", "TEACHER_A", "PARENT_A"] as const) {
    expect((await api("/school/billing", await accessToken(who), { school: SCHOOL_A() })).status, who).toBe(403);
  }
  const b = await (await api("/school/billing", await accessToken("ADMIN_B"), { school: SCHOOL_B() })).json();
  expect(JSON.stringify(b)).not.toContain(SCHOOL_A());
  expect((await api("/school/billing", await accessToken("ADMIN_B"), { school: SCHOOL_A() })).status).toBe(403);
  await page.goto("/admin/schools");
  await expect(page.getByTestId("access-denied")).toBeVisible();
});

test("a school admin adds an accountant and turns the sign-in off", async ({ page }) => {
  await signIn(page, "ADMIN_A", "/settings");
  const staff = page.getByTestId("staff-accounts");
  await expect(staff.getByTestId("staff-row").filter({ hasText: "Administrator" }).first()).toContainText("Managed by the platform");
  await staff.getByTestId("add-accountant").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("accountant-name").fill(`Ledger Keeper ${tag}`);
  await dialog.getByTestId("accountant-email").fill(`ledger-${tag.toLowerCase()}@example.com`);
  await dialog.getByTestId("send-accountant").click();
  const row = staff.getByTestId("staff-row").filter({ hasText: `Ledger Keeper ${tag}` });
  await expect(row).toContainText("Accountant");
  await row.getByTestId("toggle-accountant").click();
  await page.getByRole("dialog").getByRole("button", { name: "Turn off" }).click();
  await expect(row).toContainText("turned off");
  // a school admin can't make administrators: there is no way to, and the database refuses it too
  await expect(staff.getByText("Add administrator")).toHaveCount(0);
});

test("super admin turns a school administrator off and on again", async ({ page, browser }) => {
  const t = await accessToken("SUPER");
  const admins = await (await api(`/admin/schools/${SCHOOL_B()}/admins`, t)).json();
  const adminB = admins.find((a: { email: string }) => a.email === process.env.E2E_ADMIN_B_EMAIL);
  try {
    await signIn(page, "SUPER", `/admin/schools/${SCHOOL_B()}?tab=admins`);
    const row = page.getByTestId("admin-row").filter({ hasText: process.env.E2E_ADMIN_B_EMAIL! });
    await row.getByTestId("toggle-admin").click();
    await expect(page.getByRole("dialog")).toContainText("only active administrator");
    await page.getByRole("dialog").getByRole("button", { name: "Turn off" }).click();
    await expect(row).toContainText("turned off");
    // School B's admin is locked out at once
    expect((await api("/school", await accessToken("ADMIN_B"), { school: SCHOOL_B() })).status).toBe(403);
    await row.getByTestId("toggle-admin").click();
    await page.getByRole("dialog").getByRole("button", { name: "Turn on" }).click();
    await expect(row).not.toContainText("turned off");
    const ctx = await browser.newContext();
    const other = await ctx.newPage();
    await signIn(other, "ADMIN_B", "/dashboard");
    await expect(other.getByTestId("access-denied")).toHaveCount(0);
    await ctx.close();
  } finally {
    await api(`/admin/schools/${SCHOOL_B()}/admins/${adminB.user_id}`, t, { method: "PATCH", body: { status: "active" } });
  }
});
