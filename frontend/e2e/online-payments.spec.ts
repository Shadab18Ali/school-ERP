import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { accessToken, api, API_URL, email, runTag, SCHOOL_A, signIn } from "./helpers";

// Runs against the harness's Razorpay stand-in (same API, Checkout and webhook formats):
// key ids "rzp_test_<X>" have the secret "mock_secret_<X>".
const RZP = process.env.E2E_RAZORPAY_MOCK ?? "http://localhost:9998";
test.describe.configure({ mode: "serial" });
const tag = runTag();
const keyId = `rzp_test_E2E${tag}`;
const keySecret = `mock_secret_E2E${tag}`;
const hookSecret = `whsec-e2e-${tag}`;
const kid = `Payer Kid ${tag}`;
const cls = `Pay ${tag}`;
let studentId = "";
let webhookUrl = "";

test.beforeAll(async () => {
  const t = await accessToken("ADMIN_A");
  const post = (path: string, body?: unknown) => api(path, t, { method: "POST", school: SCHOOL_A(), body });
  const sessions: { id: string; is_current: boolean }[] = await (await api("/sessions", t, { school: SCHOOL_A() })).json();
  const cur = sessions.find((s) => s.is_current)!.id;
  await post("/classes/bulk", { classes: [{ name: cls, display_order: 61 }] });
  const classId = (await (await api(`/classes?session_id=${cur}`, t, { school: SCHOOL_A() })).json()).items.find((c: { name: string }) => c.name === cls).id;
  await post("/sections/bulk", { academic_session_id: cur, class_ids: [classId], names: ["A"] });
  const sec = (await (await api(`/sections?session_id=${cur}&class_id=${classId}`, t, { school: SCHOOL_A() })).json()).items[0].id;
  studentId = (await (await post("/students", { full_name: kid, father_name: "Father", mother_name: "Mother", date_of_birth: "2016-06-06", gender: "male",
    mobile: "9666600011", enrollment: { academic_session_id: cur, class_id: classId, section_id: sec, admission_number: `${tag}-PAY`, admission_date: "2026-04-01" } })).json()).id;
  expect((await post(`/students/${studentId}/guardians`, { email: email("PARENT_A"), full_name: "E2E Parent A", relationship: "father" })).status).toBe(201);
  await post("/fee-heads/bulk", { names: ["Tuition Fee"] });
  const head = (await (await api("/fee-heads", t, { school: SCHOOL_A() })).json()).find((h: { name: string }) => h.name === "Tuition Fee").id;
  const fs = await (await post("/fee-structures", { academic_session_id: cur, class_id: classId })).json();
  await post(`/fee-structures/${fs.id}/items`, { fee_head_id: head, amount: "1200", frequency: "monthly" });
});

test.afterAll(async () => {
  const t = await accessToken("ADMIN_A");
  for (const l of await (await api(`/students/${studentId}/guardians`, t, { school: SCHOOL_A() })).json())
    await api(`/students/${studentId}/guardians/${l.id}`, t, { method: "DELETE", school: SCHOOL_A() });
});

async function openFees(page: Page) {
  await page.goto(`/portal/${studentId}`);
  await page.getByRole("tab", { name: "Fees" }).click();
  await expect(page.getByTestId("pay-online")).toBeVisible();
}
/** Leave exactly the first n fees chosen. */
async function choose(page: Page, n: number) {
  const boxes = page.getByTestId("pay-online").getByRole("checkbox");
  const count = await boxes.count();
  for (let i = 0; i < count; i++) await boxes.nth(i).setChecked(i < n);
}

test("an admin connects the school's Razorpay account; the secrets never come back", async ({ page }) => {
  await signIn(page, "ADMIN_A");
  await page.goto("/settings");
  const card = page.getByTestId("gateway-settings");
  await card.getByLabel("Key id").fill(keyId);
  await card.getByLabel("Key secret").fill("not-the-right-secret");
  await card.getByLabel("Webhook secret").fill(hookSecret);
  await card.getByTestId("gateway-enabled").check();
  await card.getByTestId("save-gateway").click();
  await expect(card.getByTestId("gateway-error")).toContainText("rejected the key");
  await card.getByLabel("Key secret").fill(keySecret);
  await card.getByTestId("save-gateway").click();
  await expect(card.getByTestId("gateway-mode")).toHaveText("Test mode · On");
  await page.reload();
  await expect(page.getByTestId("gateway-settings").getByLabel("Key secret")).toHaveValue("");
  await expect(page.getByTestId("gateway-settings").getByLabel("Key secret")).toHaveAttribute("placeholder", /Saved/);
  expect(await page.content()).not.toContain(keySecret);
  webhookUrl = (await page.getByTestId("webhook-url").textContent())!.trim();
  expect(webhookUrl).toContain(`/api/v1/payments/webhooks/razorpay/${SCHOOL_A()}`);
  // what an admin does in the Razorpay dashboard: point the webhook at that URL
  expect((await fetch(`${RZP}/mock/webhook`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key_id: keyId, url: webhookUrl, secret: hookSecret }) })).status).toBe(200);
  const s = await (await api("/payments/settings", await accessToken("ADMIN_A"), { school: SCHOOL_A() })).text();
  expect(s).not.toContain(keySecret);
  expect(s).not.toContain(hookSecret);
  expect((await api("/payments/settings", await accessToken("ACCOUNTANT_A"), { school: SCHOOL_A() })).status).toBe(403);
});

test("a parent pays two months by UPI and gets the receipt straight away", async ({ page }) => {
  await signIn(page, "PARENT_A");
  await openFees(page);
  await choose(page, 2);
  await expect(page.getByTestId("pay-total")).toHaveText("₹2,400");
  await page.getByTestId("pay-now").click();
  const rzp = page.getByRole("dialog", { name: "Razorpay Checkout (test)" });
  await expect(rzp.getByTestId("mock-rzp-amount")).toContainText("₹2400.00");
  await expect(rzp.getByTestId("mock-rzp-methods")).toHaveText("Methods: upi, card, netbanking");
  await rzp.getByTestId("mock-pay-upi").click();
  const result = page.getByTestId("payment-result");
  await expect(result).toHaveAttribute("data-result", "paid");
  await expect(result).toContainText("₹2,400 received");
  const receipt = (await page.getByTestId("paid-receipt").textContent())!;
  await expect(page.getByTestId("portal-fee-paid")).toHaveText("₹2,400");
  await expect(page.getByTestId("portal-payments")).toContainText(receipt);
  await expect(page.getByTestId("portal-payments")).toContainText("Online payment");
  await expect(page.getByTestId("online-history").locator("li").first()).toContainText("UPI · te***@okhdfcbank");
  await expect(page.getByTestId("online-history").getByTestId("online-status").first()).toHaveText("Paid");
});

test("a failed attempt can be retried in the same window", async ({ page }) => {
  await signIn(page, "PARENT_A");
  await openFees(page);
  await choose(page, 1);
  await page.getByTestId("pay-now").click();
  const rzp = page.getByRole("dialog", { name: "Razorpay Checkout (test)" });
  await rzp.getByTestId("mock-pay-fail").click();
  await expect(rzp.getByTestId("mock-rzp-error")).toContainText("declined");
  await rzp.getByTestId("mock-pay-card").click();
  await expect(page.getByTestId("payment-result")).toHaveAttribute("data-result", "paid");
  await expect(page.getByTestId("portal-fee-paid")).toHaveText("₹3,600");
  await expect(page.getByTestId("online-history").locator("li").first()).toContainText("Visa Debit •••• 1111");
});

test("a parent who pays and closes the window is still credited (confirmed server-side)", async ({ page }) => {
  await signIn(page, "PARENT_A");
  await openFees(page);
  await choose(page, 1);
  await page.getByTestId("pay-now").click();
  await page.getByRole("dialog", { name: "Razorpay Checkout (test)" }).getByTestId("mock-pay-silent").click();
  await expect(page.getByTestId("payment-result")).toHaveAttribute("data-result", "paid");
  await expect(page.getByTestId("portal-fee-paid")).toHaveText("₹4,800");
  // closing without paying charges nothing and says so honestly
  await choose(page, 1);
  await page.getByTestId("pay-now").click();
  await page.getByRole("dialog", { name: "Razorpay Checkout (test)" }).getByTestId("mock-close").click();
  await expect(page.getByTestId("payment-result")).toHaveAttribute("data-result", "dismissed");
  await expect(page.getByTestId("portal-fee-paid")).toHaveText("₹4,800");
});

test("the browser's word is never enough: forged results and amounts are refused", async () => {
  const t = await accessToken("PARENT_A");
  const fees = await (await api(`/portal/children/${studentId}/fees`, t, { school: SCHOOL_A() })).json();
  const due = fees.dues.find((d: { balance: string }) => Number(d.balance) > 0).due_id;
  expect((await api("/payments/orders", t, { method: "POST", school: SCHOOL_A(), body: { student_id: studentId, due_ids: [due], amount: "1.00" } })).status).toBe(422);
  const order = await (await api("/payments/orders", t, { method: "POST", school: SCHOOL_A(), body: { student_id: studentId, due_ids: [due] } })).json();
  expect(order.amount).toBe("1200.00");
  expect(JSON.stringify(order)).not.toContain(keySecret);
  // a "success" made up in the browser
  const fakeId = "pay_FAKE123456";
  const forged = createHmac("sha256", "guessed-secret").update(`${order.order_id}|${fakeId}`).digest("hex");
  const r1 = await api(`/payments/${order.online_payment_id}/verify`, t, { method: "POST", school: SCHOOL_A(),
    body: { razorpay_order_id: order.order_id, razorpay_payment_id: fakeId, razorpay_signature: forged } });
  expect(r1.status).toBe(400);
  // a real signature for a payment that does not exist at Razorpay is still refused
  const signed = createHmac("sha256", keySecret).update(`${order.order_id}|${fakeId}`).digest("hex");
  const r2 = await api(`/payments/${order.online_payment_id}/verify`, t, { method: "POST", school: SCHOOL_A(),
    body: { razorpay_order_id: order.order_id, razorpay_payment_id: fakeId, razorpay_signature: signed } });
  expect(r2.status).toBe(502);
  const after = await (await api(`/portal/children/${studentId}/fees`, t, { school: SCHOOL_A() })).json();
  expect(after.totals.paid).toBe(fees.totals.paid);
  // webhooks need the school's webhook signature
  const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: fakeId, order_id: order.order_id, amount: 120000, currency: "INR", status: "captured" } } } });
  const bad = await fetch(webhookUrl, { method: "POST", body, headers: { "Content-Type": "application/json", "X-Razorpay-Signature": "0".repeat(64) } });
  expect(bad.status).toBe(400);
  expect((await api(`/payments/${order.online_payment_id}`, t, { school: SCHOOL_A() }).then((r) => r.json())).status).toBe("created");
  // other roles can't start payments
  expect((await api("/payments/orders", await accessToken("TEACHER_A"), { method: "POST", school: SCHOOL_A(), body: { student_id: studentId, due_ids: [due] } })).status).toBe(403);
});

test("staff see online payments; only admins refund, and the receipt is cancelled", async ({ page: accountant, browser }) => {
  await signIn(accountant, "ACCOUNTANT_A");
  await accountant.goto("/fees/online");
  await expect(accountant.getByRole("heading", { level: 1, name: "Online payments" })).toBeVisible();
  await accountant.getByLabel("Search").fill(kid);
  await expect(accountant.getByTestId("online-tab-paid")).toContainText("(3)");
  await expect(accountant.getByTestId("online-received")).toHaveText("₹4,800");
  const row = accountant.getByTestId("online-list").locator("li").filter({ hasText: "₹2,400" });
  await row.getByRole("button").first().click();
  await expect(row.getByTestId("online-detail")).toContainText("Confirmed by: the payment window");
  await expect(row.getByTestId("refund")).toHaveCount(0);  // accountants can't refund
  const t = await accessToken("ACCOUNTANT_A");
  const list = await (await api(`/payments/online/list?search=${encodeURIComponent(kid)}&status=paid`, t, { school: SCHOOL_A() })).json();
  const upi = list.items.find((x: { amount: string }) => x.amount === "2400.00");
  expect((await api(`/payments/online/${upi.id}/refund`, t, { method: "POST", school: SCHOOL_A(), body: { reason: "Paid twice" } })).status).toBe(403);

  const admin = await (await browser.newContext({ baseURL: test.info().project.use.baseURL })).newPage();  // a separate browser for each person
  await signIn(admin, "ADMIN_A");
  await admin.goto("/fees/online");
  await admin.getByLabel("Search").fill(kid);
  const arow = admin.getByTestId(`online-row-${upi.id}`);
  await arow.getByRole("button").first().click();
  await arow.getByTestId("refund").click();
  const dialog = admin.getByRole("dialog");
  await expect(dialog).toContainText(`Receipt ${upi.receipt_number} will be cancelled`);
  await dialog.getByTestId("confirm-refund").click();
  await expect(dialog.getByTestId("refund-error")).toContainText("reason");
  await dialog.getByTestId("refund-reason").fill("Paid twice by mistake");
  await dialog.getByTestId("confirm-refund").click();
  await expect(arow.getByTestId("online-status")).toHaveText("Refunded");
  await expect(admin.getByTestId("online-refunded")).toHaveText("₹2,400");
  const a = await accessToken("ADMIN_A");
  expect((await api(`/payments/online/${upi.id}/refund`, a, { method: "POST", school: SCHOOL_A(), body: { reason: "Again" } })).status).toBe(409);

  // the register lists the receipt as cancelled and doesn't count it
  await admin.goto("/fees/payments");
  await admin.getByLabel("Search payments").fill(upi.receipt_number);
  await expect(admin.getByTestId(`register-${upi.receipt_number}`)).toContainText("Cancelled (not counted)");
  // the parent sees the refund, and the two months are due again
  const parent = await (await browser.newContext({ baseURL: test.info().project.use.baseURL })).newPage();
  await signIn(parent, "PARENT_A");
  await openFees(parent);
  await expect(parent.getByTestId("portal-fee-paid")).toHaveText("₹2,400");
  await expect(parent.getByTestId("portal-payments")).toContainText("Cancelled · refunded");
  await expect(parent.getByTestId("online-history")).toContainText("Refunded to your account");
});

test("only the right people reach payment pages and data", async () => {
  for (const who of ["TEACHER_A", "PARENT_A", "STUDENT_A"] as const) {
    expect((await api("/payments/online/list", await accessToken(who), { school: SCHOOL_A() })).status, who).toBe(403);
  }
  const anon = await fetch(`${API_URL()}/api/v1/payments/online/list`, { headers: { "X-School-Id": SCHOOL_A() } });
  expect(anon.status).toBe(401);
});
