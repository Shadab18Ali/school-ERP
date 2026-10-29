import { expect, test } from "@playwright/test";
import { accessToken, api, email, PASSWORD, runTag, SCHOOL_A, signIn } from "./helpers";

/** Runs last on purpose (Playwright orders files by name): it adds a class, a student and a fee to School A,
 * which earlier specs expect to find nearly empty.
 *
 * The audit log and the security fixes people can see: sign-ins and data changes in the school's log
 * (with what changed), a receipt reversed by the admin (not the accountant), who may read the log, the
 * platform's log, and the sign-in page refusing to send people to another site. */
const tag = runTag();
test.describe.configure({ mode: "serial" });

let studentId = "";
let receipt = "";

test.beforeAll(async () => {
  // a class, a student with a yearly fee, and a receipt recorded by the accountant — all through the API
  const t = await accessToken("ADMIN_A");
  const s = SCHOOL_A();
  const sess = (await (await api("/sessions", t, { school: s })).json()).find((x: { is_current: boolean }) => x.is_current);
  const cname = `Audit ${tag}`;
  await api("/classes/bulk", t, { school: s, method: "POST", body: { classes: [{ name: cname, display_order: 60 }] } });
  const cls = (await (await api("/classes", t, { school: s })).json()).items.find((c: { name: string }) => c.name === cname).id;
  await api("/sections/bulk", t, { school: s, method: "POST", body: { academic_session_id: sess.id, class_ids: [cls], names: ["A"] } });
  const sec = (await (await api(`/sections?session_id=${sess.id}&class_id=${cls}`, t, { school: s })).json()).items.find((x: { class_id: string }) => x.class_id === cls).id;
  const st = await (await api("/students", t, { school: s, method: "POST", body: {
    full_name: `Meera Audit ${tag}`, father_name: "Father", date_of_birth: "2016-03-03", gender: "female", mobile: `96${String(Date.now()).slice(-8)}`,
    enrollment: { academic_session_id: sess.id, class_id: cls, section_id: sec, admission_number: `AU-${tag}`, admission_date: sess.start_date } } })).json();
  studentId = st.id;
  const hname = `Audit Fee ${tag}`;
  await api("/fee-heads/bulk", t, { school: s, method: "POST", body: { names: [hname] } });
  const head = (await (await api("/fee-heads", t, { school: s })).json()).find((h: { name: string }) => h.name === hname).id;
  const fs = await (await api("/fee-structures", t, { school: s, method: "POST", body: { academic_session_id: sess.id, class_id: cls } })).json();
  await api(`/fee-structures/${fs.id}/items`, t, { school: s, method: "POST", body: { fee_head_id: head, amount: "2500", frequency: "yearly" } });
  const acct = await accessToken("ACCOUNTANT_A");
  const acc = await (await api(`/fee-collection/students/${studentId}`, acct, { school: s })).json();
  const due = acc.dues.find((d: { fee_head_name: string }) => d.fee_head_name === hname);
  const paid = await (await api(`/fee-collection/enrollments/${acc.enrollment_id}/payments`, acct, { school: s, method: "POST", body: {
    idempotency_key: crypto.randomUUID(), payment_date: new Date().toISOString().slice(0, 10), payment_mode: "cash",
    allocations: [{ due_id: due.due_id, amount: "2500" }] } })).json();
  receipt = paid.payment.receipt_number;
  // a change the log should show as from → to
  await api(`/students/${studentId}`, t, { school: s, method: "PATCH", body: { father_name: `Father ${tag}` } });
});

test("the school's admin reads the audit log: sign-ins and what changed", async ({ page }) => {
  await signIn(page, "ADMIN_A", "/audit-log");
  await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();
  await page.getByTestId("audit-category").selectOption("sign_in");
  await expect(page.getByTestId("audit-row").filter({ hasText: "Signed in" }).filter({ hasText: email("ADMIN_A") }).first()).toBeVisible();
  await page.getByTestId("audit-category").selectOption("");
  await page.getByTestId("audit-search").fill(`Meera Audit ${tag}`);
  await expect(page.getByTestId("audit-total")).toHaveText(/^[1-9] entr/);
  const updated = page.getByTestId("audit-row").filter({ hasText: "Student updated" }).filter({ hasText: `Meera Audit ${tag}` });
  await expect(updated).toHaveCount(1);
  await updated.click();
  const change = page.getByTestId("audit-change").filter({ hasText: "father name" });
  await expect(change).toContainText("Father");
  await expect(change).toContainText(`Father ${tag}`);
  await expect(page.getByTestId("audit-row").filter({ hasText: "Student created" })).toHaveCount(1);
  const download = page.waitForEvent("download");
  await page.getByTestId("audit-export").click();
  expect((await download).suggestedFilename()).toBe("audit-log.csv");
});

test("a receipt is reversed by the admin, not the accountant, and the log shows both", async ({ page, browser }) => {
  const ctx = await browser.newContext();
  const acct = await ctx.newPage();
  await signIn(acct, "ACCOUNTANT_A", `/fees/collect/${studentId}`);
  await expect(acct.getByTestId("payment-history")).toContainText(receipt);
  await expect(acct.getByTestId("cancel-receipt")).toHaveCount(0);   // the person who takes the money can't make it disappear
  await expect(acct.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Audit log", exact: true })).toHaveCount(0);
  await acct.goto("/audit-log");
  await expect(acct.getByTestId("access-denied")).toBeVisible();
  await ctx.close();

  await signIn(page, "ADMIN_A", `/fees/collect/${studentId}`);
  const history = page.getByTestId("payment-history");
  await history.getByTestId("cancel-receipt").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("cancel-receipt-reason").fill("no");
  await dialog.getByTestId("confirm-cancel-receipt").click();
  await expect(dialog.getByTestId("cancel-receipt-error")).toContainText("reason");
  await dialog.getByTestId("cancel-receipt-reason").fill("Entered against the wrong student");
  await dialog.getByTestId("confirm-cancel-receipt").click();
  await expect(history.getByTestId("receipt-cancelled")).toHaveText("Cancelled");
  await expect(history.getByTestId("receipt-cancel-reason")).toContainText("Entered against the wrong student");
  await expect(history.getByTestId("cancel-receipt")).toHaveCount(0);

  await page.goto("/audit-log");
  await page.getByTestId("audit-category").selectOption("fees");
  await page.getByTestId("audit-search").fill(receipt);
  await expect(page.getByTestId("audit-row").filter({ hasText: "Receipt recorded" }).filter({ hasText: receipt })).toContainText(email("ACCOUNTANT_A"));
  const cancelled = page.getByTestId("audit-row").filter({ hasText: "Receipt cancelled" }).filter({ hasText: receipt });
  await expect(cancelled).toContainText(email("ADMIN_A"));
  await cancelled.click();
  await expect(page.getByTestId("audit-change").filter({ hasText: "cancel reason" })).toContainText("Entered against the wrong student");
});

test("the platform's log shows every school, but not payroll", async ({ page }) => {
  await signIn(page, "SUPER", "/admin/audit");
  await expect(page.getByRole("heading", { level: 1, name: "Platform audit log" })).toBeVisible();
  await expect(page.getByTestId("audit-category").locator("option", { hasText: "Payroll" })).toHaveCount(0);
  await page.getByTestId("audit-school").selectOption({ label: "E2E Test School A" });
  await page.getByTestId("audit-search").fill(`Meera Audit ${tag}`);
  await expect(page.getByTestId("audit-row").filter({ hasText: "Student created" }).filter({ hasText: `Meera Audit ${tag}` }))
    .toContainText("E2E Test School A");
  // school admins can't read the platform's log
  expect((await api("/admin/audit", await accessToken("ADMIN_A"))).status).toBe(403);
});

test("signing in never sends anyone to another site", async ({ browser }) => {
  const attempt = async (next: string, landing: RegExp) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`/login?next=${encodeURIComponent(next)}`);
    await page.getByLabel("Email").fill(email("TEACHER_A"));
    await page.getByLabel("Password").fill(PASSWORD());
    await page.getByTestId("sign-in").click();
    await expect(page).toHaveURL(landing);
    await ctx.close();
  };
  for (const next of ["/\\evil.example", "//evil.example", "https://evil.example/x", "/\t/evil.example"]) {
    await attempt(next, /localhost:3000\/dashboard/);
  }
  await attempt("/notices?x=1", /localhost:3000\/notices\?x=1/);   // a path on this site is kept
});
