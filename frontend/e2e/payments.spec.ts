import { expect, test, type Page } from "@playwright/test";
import { accessToken, api, runTag, SCHOOL_A, SCHOOL_B, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });

const tag = runTag();
const student = `Pay Student ${tag}`;
let studentId = "";
let enrollmentId = "";
let structureId = "";

test.beforeAll(async () => {
  const t = await accessToken("ADMIN_A");
  const post = (path: string, body: unknown) => api(path, t, { method: "POST", school: SCHOOL_A(), body });
  const sessions: { id: string; is_current: boolean }[] = await (await api("/sessions", t, { school: SCHOOL_A() })).json();
  const current = sessions.find((s) => s.is_current)!.id;
  await post("/classes/bulk", { classes: [{ name: "Class 9", display_order: 12 }] });
  const cls = (await (await api(`/classes?session_id=${current}`, t, { school: SCHOOL_A() })).json()).items.find((c: { name: string }) => c.name === "Class 9").id;
  await post("/sections/bulk", { academic_session_id: current, class_ids: [cls], names: ["A"] });
  const sec = (await (await api(`/sections?session_id=${current}&class_id=${cls}`, t, { school: SCHOOL_A() })).json()).items[0].id;
  await post("/fee-heads/bulk", { names: ["Tuition Fee", "Annual Fee", "Transport Fee"] });
  const heads: Record<string, string> = Object.fromEntries(
    (await (await api("/fee-heads", t, { school: SCHOOL_A() })).json()).map((h: { name: string; id: string }) => [h.name, h.id]));
  const fs = await (await post("/fee-structures", { academic_session_id: current, class_id: cls })).json();
  structureId = fs.id;
  for (const [h, amount, frequency, extra] of [
    ["Tuition Fee", "1500", "monthly", {}], ["Annual Fee", "5000", "yearly", {}],
    ["Transport Fee", "1000", "monthly", { is_optional: true, billing_months: [1, 2, 3, 4, 7, 8, 9, 10, 11, 12] }],
  ] as const) {
    await post(`/fee-structures/${structureId}/items`, { fee_head_id: heads[h], amount, frequency, ...extra });
  }
  const st = await (await post("/students", {
    full_name: student, father_name: "Payer Parent", date_of_birth: "2015-06-01", gender: "male", mobile: "9811200000",
    enrollment: { academic_session_id: current, class_id: cls, section_id: sec, admission_number: `${tag}-PAY`, admission_date: "2026-04-01" },
  })).json();
  studentId = st.id;
});

async function openStudent(page: Page) {
  await signIn(page, "ACCOUNTANT_A", "/fees/collect");
  await page.getByLabel("Search students").fill(tag);
  await page.getByRole("link", { name: student }).click();
  await expect(page.getByRole("heading", { level: 1, name: student })).toBeVisible();
}

test.describe("fee collection", () => {
  test("dues come from the class structure; optional fees can be added", async ({ page }) => {
    await openStudent(page);
    await expect(page.getByTestId("fee-total-total")).toHaveText("₹23,000");
    await expect(page.getByTestId("fee-total-outstanding")).toHaveText("₹23,000");
    await page.getByLabel(/Transport Fee/).check();
    await page.getByRole("button", { name: "Save optional fees" }).click();
    await expect(page.getByTestId("fee-total-total")).toHaveText("₹33,000");
    enrollmentId = page.url() && (await (await api(`/fee-collection/students/${studentId}`, await accessToken("ACCOUNTANT_A"), { school: SCHOOL_A() })).json()).enrollment_id;
  });

  test("full + partial payment in one receipt; PDF receipt", async ({ page }) => {
    await openStudent(page);
    await page.getByLabel("Pay Tuition Fee Apr 2026").check();
    await page.getByLabel("Pay Annual Fee Apr 2026").check();
    await page.getByLabel("Amount for Annual Fee Apr 2026").fill("2000");
    await expect(page.getByTestId("record-payment")).toHaveText("Record payment · ₹3,500");
    await page.getByTestId("record-payment").click();

    const dialog = page.getByTestId("receipt-dialog");
    await expect(dialog.getByTestId("receipt-number")).toHaveText(/^E2E-A\/2026-27\/\d{6}$/);
    await expect(dialog.getByTestId("receipt-total")).toHaveText("₹3,500");
    await expect(dialog).toContainText("Balance due now: ₹29,500");
    const receiptNo = await dialog.getByTestId("receipt-number").textContent();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      dialog.getByRole("button", { name: /Download receipt/ }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`receipt-${receiptNo!.replaceAll("/", "-")}.pdf`);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync((await download.path())!).subarray(0, 5).toString()).toBe("%PDF-");
    await page.getByRole("button", { name: "Done" }).click();

    await expect(page.getByTestId("due-Tuition Fee-2026-04")).toContainText("Paid");
    await expect(page.getByTestId("due-Annual Fee-2026-04")).toContainText("Part paid");
    await expect(page.getByTestId("due-Annual Fee-2026-04").getByTestId("due-balance")).toHaveText("₹3,000");
    await expect(page.getByTestId("fee-total-outstanding")).toHaveText("₹29,500");
    await expect(page.getByTestId("payment-history").getByRole("listitem")).toHaveCount(1);
  });

  test("more than the outstanding balance is refused", async ({ page }) => {
    await openStudent(page);
    await page.getByLabel("Pay Annual Fee Apr 2026").check();
    await page.getByLabel("Amount for Annual Fee Apr 2026").fill("3001");
    await expect(page.getByText("Max ₹3,000")).toBeVisible();
    await page.getByTestId("record-payment").click();
    await expect(page.getByTestId("payment-error")).toHaveText("Check the highlighted amounts.");

    // the server refuses it too, whatever the browser sends
    const t = await accessToken("ACCOUNTANT_A");
    const acc = await (await api(`/fee-collection/students/${studentId}`, t, { school: SCHOOL_A() })).json();
    const annual = acc.dues.find((d: { fee_head_name: string }) => d.fee_head_name === "Annual Fee");
    const res = await api(`/fee-collection/enrollments/${acc.enrollment_id}/payments`, t, {
      method: "POST", school: SCHOOL_A(),
      body: { idempotency_key: crypto.randomUUID(), payment_date: "2026-10-01", payment_mode: "cash", allocations: [{ due_id: annual.due_id, amount: "3001" }] },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).detail).toContain("₹3000.00 outstanding");
  });

  test("a second payment by UPI settles the fee; reference is required", async ({ page }) => {
    await openStudent(page);
    await page.getByLabel("Pay Annual Fee Apr 2026").check();
    await page.getByLabel("Payment mode").selectOption("upi");
    await page.getByTestId("record-payment").click();
    await expect(page.getByTestId("payment-error")).toHaveText("Enter the UPI transaction ID.");
    await page.getByLabel(/^UPI transaction ID/).fill("UTR998877");
    await page.getByTestId("record-payment").click();
    await expect(page.getByTestId("receipt-dialog")).toContainText("Balance due now: ₹26,500");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("due-Annual Fee-2026-04")).toContainText("Paid");
    await expect(page.getByTestId("payment-history").getByRole("listitem")).toHaveCount(2);
    await expect(page.getByTestId("payment-history")).toContainText("UPI (UTR998877)");
  });

  test("a double-clicked or repeated submission creates only one receipt", async ({ page }) => {
    await openStudent(page);
    await page.getByLabel("Pay Tuition Fee May 2026").check();
    await page.getByTestId("record-payment").dblclick();
    await expect(page.getByTestId("receipt-dialog")).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("payment-history").getByRole("listitem")).toHaveCount(3);

    // same key sent twice through the API -> the original receipt comes back
    const t = await accessToken("ACCOUNTANT_A");
    const acc = await (await api(`/fee-collection/students/${studentId}`, t, { school: SCHOOL_A() })).json();
    const june = acc.dues.find((d: { fee_head_name: string; due_month: string }) => d.fee_head_name === "Tuition Fee" && d.due_month === "2026-06-01");
    const body = { idempotency_key: crypto.randomUUID(), payment_date: "2026-10-01", payment_mode: "cash", allocations: [{ due_id: june.due_id, amount: "1500" }] };
    const path = `/fee-collection/enrollments/${acc.enrollment_id}/payments`;
    const [a, b] = await Promise.all([api(path, t, { method: "POST", school: SCHOOL_A(), body }), api(path, t, { method: "POST", school: SCHOOL_A(), body })]);
    const ra = await a.json();
    const rb = await b.json();
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(ra.payment.receipt_number).toBe(rb.payment.receipt_number);
    expect([ra.duplicate, rb.duplicate].sort()).toEqual([false, true]);
    const after = await (await api(`/fee-collection/students/${studentId}`, t, { school: SCHOOL_A() })).json();
    expect(after.payments).toHaveLength(4);
    expect(after.totals.outstanding).toBe("23500.00"); // 33000 - 3500 - 3000 - 1500 - 1500
  });

  test("payments register lists receipts with the period total", async ({ page }) => {
    await signIn(page, "ACCOUNTANT_A", "/fees/payments");
    await page.getByLabel("Search payments").fill(student);
    await expect(page.getByTestId("register-total")).toHaveText("4 receipts · ₹9,500 collected");
  });

  test("access and integrity", async ({ page }) => {
    await signIn(page, "TEACHER_A", "/fees/collect");
    await expect(page.getByTestId("access-denied")).toBeVisible();
    const [teacher, adminB, admin] = await Promise.all([accessToken("TEACHER_A"), accessToken("ADMIN_B"), accessToken("ADMIN_A")]);
    expect((await api(`/fee-collection/students/${studentId}`, teacher, { school: SCHOOL_A() })).status).toBe(403);
    const acc = await (await api(`/fee-collection/students/${studentId}`, admin, { school: SCHOOL_A() })).json();
    const paymentId = acc.payments[0].id;
    expect((await api(`/fee-payments/${paymentId}`, adminB, { school: SCHOOL_B() })).status).toBe(404);
    expect((await api(`/fee-payments/${paymentId}/receipt.pdf`, adminB, { school: SCHOOL_A() })).status).toBe(403);
    // a fee that has payments can't be removed from the structure
    const detail = await (await api(`/fee-structures/${structureId}`, admin, { school: SCHOOL_A() })).json();
    const tuition = detail.items.find((i: { fee_head_name: string }) => i.fee_head_name === "Tuition Fee");
    expect((await api(`/fee-structures/${structureId}/items/${tuition.id}`, admin, { method: "DELETE", school: SCHOOL_A() })).status).toBe(409);
    void enrollmentId;
  });
});
