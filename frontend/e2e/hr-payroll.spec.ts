import { readFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { accessToken, api, runTag, SCHOOL_A, SCHOOL_B, signIn } from "./helpers";

test.describe.configure({ mode: "serial", timeout: 120_000 }); // several sign-ins per test
const tag = runTag();
const letters = (s: string) => s.replace(/\d/g, (d) => "ABCDEFGHIJ"[Number(d)]);
const CL = `C${letters(tag)}`.slice(0, 6);
const LWP = `W${letters(tag)}`.slice(0, 6);
const clName = `Casual leave ${tag}`;
const lwpName = `Leave without pay ${tag}`;
const teacher = "E2E Teacher A";      // seeded staff record linked to TEACHER_A
const empId = "EMP-E2E-A";

// ---- the month we pay: last month (it is over, so it can be finalized)
const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const now = new Date();
const M = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const monthKey = iso(M).slice(0, 7);
const monthDays: string[] = [];
for (let d = new Date(M); d.getMonth() === M.getMonth(); d.setDate(d.getDate() + 1)) monthDays.push(iso(d));
const weekdays = monthDays.filter((d) => new Date(`${d}T00:00:00`).getDay() !== 0);   // Sunday is the weekly off
const wd = (n: number) => weekdays[n - 1];                                               // wd(1) becomes a holiday
const workingDays = weekdays.length - 1;
const r2 = (n: number) => Math.round(n * 100) / 100;

let runId = "";

async function asUser(browser: Browser, who: Parameters<typeof signIn>[1]): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, who);
  return page;
}

test("the admin sets up leave types, a holiday and the working week", async ({ browser }) => {
  const page = await asUser(browser, "ADMIN_A");
  await page.goto("/staff-leave?tab=Leave%20types");
  for (const [name, code, daysPer, paid] of [[clName, CL, "12", true], [lwpName, LWP, "", false]] as const) {
    await page.getByTestId("add-leave-type").click();
    await page.getByTestId("lt-name").fill(name);
    await page.getByTestId("lt-code").fill(code);
    if (daysPer) await page.getByTestId("lt-days").fill(daysPer); else await page.getByTestId("lt-unlimited").click();
    if (!paid) await page.getByTestId("lt-paid").click();
    await page.getByTestId("save-leave-type").click();
    await expect(page.getByTestId(`leave-type-${code}`)).toContainText(paid ? "Paid" : "Unpaid");
  }
  await expect(page.getByTestId(`leave-type-${CL}`)).toContainText("12 days per session");
  await expect(page.getByTestId(`leave-type-${LWP}`)).toContainText("No limit");

  await page.goto("/staff-leave?tab=Holidays%20%26%20week");
  await expect(page.getByTestId("off-7")).toBeChecked();          // Sunday off by default
  await page.getByTestId("holiday-date").fill(wd(1));
  await page.getByTestId("holiday-name").fill(`Founders day ${tag}`);
  await page.getByTestId("add-holiday").click();
  await expect(page.getByTestId("holiday-list")).toContainText(`Founders day ${tag}`);
});

test("a teacher applies for leave; the balance and the day count follow the rules", async ({ browser }) => {
  const page = await asUser(browser, "TEACHER_A");
  await page.goto("/leave");
  await expect(page.getByTestId(`balance-${CL}`).getByTestId("balance-available")).toHaveText("12");

  const apply = async (type: string, from: string, to: string, reason: string) => {
    await page.getByTestId("apply-leave").click();
    await page.getByTestId("leave-type").selectOption({ label: type });
    await page.getByTestId("leave-from").fill(from);
    await page.getByTestId("leave-to").fill(to);
    await page.getByTestId("leave-reason").fill(reason);
  };
  // the holiday isn't a leave day
  await apply(`${clName} (${CL})`, wd(1), wd(1), "x");
  await expect(page.getByTestId("leave-count")).toContainText("weekly offs or holidays");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  // more than the balance
  await apply(`${clName} (${CL})`, weekdays[1], weekdays[14], `too much ${tag}`);
  await page.getByTestId("submit-leave").click();
  await expect(page.getByTestId("leave-error")).toContainText("left this session");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

  await apply(`${clName} (${CL})`, wd(5), wd(5), `cl ${tag}`);
  await expect(page.getByTestId("leave-count")).toContainText("1 working day");
  await page.getByTestId("submit-leave").click();
  await apply(`${lwpName} (${LWP}) · unpaid`, wd(6), wd(6), `lwp ${tag}`);
  await page.getByTestId("submit-leave").click();
  await apply(`${clName} (${CL})`, wd(9), wd(9), `rejected ${tag}`);
  await page.getByTestId("submit-leave").click();
  await expect(page.getByTestId("my-leave")).toHaveCount(3);
  await expect(page.getByTestId(`balance-${CL}`).getByTestId("balance-available")).toHaveText("10");   // 12 − 2 pending

  // overlapping leave is refused
  await apply(`${clName} (${CL})`, wd(5), wd(5), `again ${tag}`);
  await page.getByTestId("submit-leave").click();
  await expect(page.getByTestId("leave-error")).toContainText("already a leave");
});

test("the admin approves and rejects; the teacher sees the decision", async ({ browser }) => {
  const page = await asUser(browser, "ADMIN_A");
  await page.goto("/staff-leave");
  const row = (reason: string) => page.getByTestId("request-row").filter({ hasText: reason });
  await expect(row(`cl ${tag}`)).toContainText(teacher);
  await row(`cl ${tag}`).getByTestId("approve").click();
  await page.getByTestId("confirm-decision").click();
  await expect(row(`cl ${tag}`)).toHaveCount(0);
  await row(`lwp ${tag}`).getByTestId("approve").click();
  await page.getByTestId("confirm-decision").click();
  await expect(row(`lwp ${tag}`)).toHaveCount(0);
  await row(`rejected ${tag}`).getByTestId("reject").click();
  await page.getByTestId("confirm-decision").click();
  await expect(page.getByTestId("decide-error")).toContainText("reason");
  await page.getByTestId("decision-note-input").fill("Exam week");
  await page.getByTestId("confirm-decision").click();
  await expect(row(`rejected ${tag}`)).toHaveCount(0);

  await page.goto("/staff-leave?tab=Balances");
  await expect(page.getByTestId(`balance-row-${empId}`).getByTestId(`cell-${CL}`)).toContainText("11 / 12");

  const t = await asUser(browser, "TEACHER_A");
  await t.goto("/leave");
  const rejected = t.getByTestId("my-leave").filter({ hasText: `rejected ${tag}` });
  await expect(rejected.getByTestId("leave-status")).toHaveText("Rejected");
  await expect(rejected.getByTestId("decision-note")).toContainText("Exam week");
  await expect(t.getByTestId(`balance-${CL}`).getByTestId("balance-available")).toHaveText("11");
  // staff can't decide leave
  const tk = await accessToken("TEACHER_A");
  expect((await api("/hr/leave?status=pending", tk, { school: SCHOOL_A() })).status).toBe(403);
});

test("the admin marks staff attendance", async ({ browser }) => {
  const page = await asUser(browser, "ADMIN_A");
  await page.goto("/staff-attendance");
  for (const [day, status] of [[wd(3), "absent"], [wd(4), "half_day"]] as const) {
    const loaded = page.waitForResponse((res) => res.url().includes("/hr/attendance?") && res.url().includes(`date=${day}`) && res.request().method() === "GET");
    await page.getByTestId("att-date").fill(day);
    await loaded;                                         // mark the chosen day's register, not the previous one
    const r = page.getByTestId(`att-${empId}`);
    await r.getByTestId(`att-${status}`).click();
    await page.getByTestId("save-attendance").click();
    await expect(r.getByTestId(`att-${status}`)).toHaveAttribute("aria-checked", "true");
  }
  await page.getByTestId("att-date").fill(wd(5));
  await expect(page.getByTestId(`att-${empId}`).getByTestId("on-leave")).toContainText(clName);
  await page.getByTestId("att-date").fill(wd(1));
  await expect(page.getByTestId("att-notice")).toContainText(`Founders day ${tag}`);
});

test("payroll: allowances and deductions, a salary, the month's payslip worked out from attendance and leave", async ({ browser }) => {
  const page = await asUser(browser, "ADMIN_A");
  await page.goto("/payroll?tab=Allowances%20%26%20deductions");
  for (const [name, kind, calc, value] of [[`HRA ${tag}`, "earning", "percent_basic", "40"], [`PF ${tag}`, "deduction", "percent_basic", "12"], [`Prof tax ${tag}`, "deduction", "fixed", "200"]] as const) {
    await page.getByTestId("add-component").click();
    await page.getByTestId("comp-name").fill(name);
    await page.getByTestId("comp-kind").selectOption(kind);
    await page.getByTestId("comp-calc").selectOption(calc);
    await page.getByTestId("comp-value").fill(value);
    await page.getByTestId("save-component").click();
    await expect(page.getByTestId(`component-${name}`)).toBeVisible();
  }

  await page.goto("/payroll?tab=Salaries");
  await expect(page.getByTestId(`salary-${empId}`).getByTestId("no-salary")).toBeVisible();
  await page.getByTestId(`salary-${empId}`).getByRole("link").click();
  await page.getByTestId("add-structure").click();
  await page.getByTestId("structure-from").fill(monthKey);
  await page.getByTestId("structure-basic").fill("30000");
  // 30000 + 40% = 42000 gross; − 12% (3600) − 200 = 38200 net for a full month
  await expect(page.getByTestId("preview-net")).toHaveText("₹38,200");
  await page.getByTestId("save-structure").click();
  await expect(page.getByTestId(`structure-${monthKey}`).getByTestId("structure-net")).toHaveText("₹38,200");

  // run the month
  await page.goto("/payroll");
  await page.getByTestId("run-month").fill(monthKey);
  await page.getByTestId("run-payroll-button").click();
  await expect(page.getByTestId("run-heading")).toContainText(String(M.getFullYear()));
  runId = page.url().split("/").pop()!;
  const slipRow = page.getByTestId(`slip-${empId}`);
  // loss of pay: 1 absent + ½ half day + 1 unpaid leave (paid CL and the holiday cost nothing)
  await expect(slipRow.getByTestId("slip-row-lop")).toHaveText("2½");

  const tk = await accessToken("ADMIN_A");
  const run = await (await api(`/payroll/runs/${runId}`, tk, { school: SCHOOL_A() })).json();
  const slip = run.payslips.find((p: { employee_id: string }) => p.employee_id === empId);
  const f = (workingDays - 2.5) / workingDays;
  const basic = r2(30000 * f), hra = r2(12000 * f), pf = r2(basic * 0.12);
  expect(slip.working_days).toBe(workingDays);
  expect(Number(slip.gross_earned)).toBeCloseTo(basic + hra, 2);
  expect(Number(slip.lop_amount)).toBeCloseTo(42000 - (basic + hra), 2);
  expect(Number(slip.total_deductions)).toBeCloseTo(pf + 200, 2);
  expect(Number(slip.net_pay)).toBeCloseTo(basic + hra - pf - 200, 2);
  expect([slip.absent_days, slip.half_days, slip.paid_leave_days, slip.unpaid_leave_days]).toEqual(["1", "1", "1", "1"]);

  // an exam-duty payment on the slip; the PDF
  await slipRow.getByTestId("open-slip").click();
  await page.getByTestId("adj-label").fill("Exam duty");
  await page.getByTestId("adj-amount").fill("500");
  await page.getByTestId("add-adjustment").click();
  await expect(page.getByTestId("adjustments")).toContainText("Exam duty");
  const net = r2(basic + hra - pf - 200 + 500);
  const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2, minimumFractionDigits: 0 });
  await expect(page.getByTestId("slip-net")).toHaveText(inr.format(net));
  const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByTestId("slip-pdf").click()]);
  expect(pdf.suggestedFilename()).toMatch(new RegExp(`^salary-slip-${monthKey}-e2e-teacher-a\\.pdf$`));
  expect(readFileSync(await pdf.path()).subarray(0, 5).toString()).toBe("%PDF-");
  await page.getByRole("button", { name: "Close" }).last().click();
  await expect(page.getByTestId("run-net")).toContainText("₹");
});

test("finalizing locks the month; then it is marked paid", async ({ browser }) => {
  const page = await asUser(browser, "ADMIN_A");
  await page.goto(`/payroll/runs/${runId}`);
  const [csv] = await Promise.all([page.waitForEvent("download"), page.getByTestId("register-csv").click()]);
  expect(readFileSync(await csv.path()).toString("utf8")).toContain(empId);
  await page.getByTestId("finalize").click();
  await page.getByRole("dialog").getByRole("button", { name: "Finalize", exact: true }).click();
  await expect(page.getByTestId("run-status")).toHaveText("Finalized");
  await expect(page.getByTestId("recalculate")).toHaveCount(0);

  // the month's attendance is locked now — in the page and in the database
  await page.goto("/staff-attendance");
  await page.getByTestId("att-date").fill(wd(3));
  await expect(page.getByTestId("att-notice")).toContainText("finalized");
  const tk = await accessToken("ADMIN_A");
  const r = await api("/hr/attendance", tk, { method: "PUT", school: SCHOOL_A(), body: { date: wd(3), entries: [{ teacher_id: (await (await api("/hr/staff", tk, { school: SCHOOL_A() })).json()).find((s: { employee_id: string }) => s.employee_id === empId).id, status: "present" }] } });
  expect(r.status).toBe(409);

  await page.goto(`/payroll/runs/${runId}`);
  await page.getByTestId("mark-paid").click();
  await page.getByTestId("confirm-paid").click();
  await expect(page.getByTestId("run-status")).toHaveText("Paid");
  expect((await api(`/payroll/runs/${runId}/reopen`, tk, { method: "POST", school: SCHOOL_A(), body: { note: "again" } })).status).toBe(409);
});

test("payroll is for this school's administrators only", async ({ browser }) => {
  for (const who of ["ACCOUNTANT_A", "TEACHER_A"] as const) {
    const page = await asUser(browser, who);
    await page.goto("/payroll");
    await expect(page.getByTestId("access-denied")).toBeVisible();
    await page.goto(`/payroll/runs/${runId}`);
    await expect(page.getByTestId("access-denied")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Payroll" })).toHaveCount(0);
  }
  for (const who of ["ACCOUNTANT_A", "TEACHER_A", "LIBRARIAN_A", "PARENT_A", "STUDENT_A", "SUPER"] as const) {
    const tk = await accessToken(who);
    expect((await api("/payroll/runs", tk, { school: SCHOOL_A() })).status, who).toBe(403);
    expect((await api(`/payroll/runs/${runId}`, tk, { school: SCHOOL_A() })).status, who).toBe(403);
  }
  const b = await accessToken("ADMIN_B");
  expect((await api(`/payroll/runs/${runId}`, b, { school: SCHOOL_B() })).status).toBe(404);
  expect((await (await api("/payroll/runs", b, { school: SCHOOL_B() })).json()).items).toEqual([]);
  // leave management is for admins too; staff only see their own
  const acct = await accessToken("ACCOUNTANT_A");
  expect((await api("/hr/leave", acct, { school: SCHOOL_A() })).status).toBe(403);
  const parent = await accessToken("PARENT_A");
  expect((await api("/hr/my", parent, { school: SCHOOL_A() })).status).toBe(403);
});

test("@mobile leave and payroll pages work on a phone without sideways scrolling", async ({ browser }) => {
  const check = async (page: Page, url: string) => {
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `no sideways scroll on ${url}`).toBeLessThanOrEqual(1);
  };
  const phone = () => browser.newContext({ ...test.info().project.use });   // the mobile project's device
  const t = await (await phone()).newPage();
  await signIn(t, "TEACHER_A");
  await check(t, "/leave");
  const a = await (await phone()).newPage();
  await signIn(a, "ADMIN_A");
  for (const url of ["/staff-leave", "/staff-leave?tab=Balances", "/staff-attendance", "/payroll", "/payroll?tab=Salaries"]) await check(a, url);
  const runs = await (await api("/payroll/runs", await accessToken("ADMIN_A"), { school: SCHOOL_A() })).json();
  if (runs.items.length) await check(a, `/payroll/runs/${runs.items[0].id}`);
});
