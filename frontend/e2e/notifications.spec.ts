import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { accessToken, api, email, runTag, SCHOOL_A, SCHOOL_B, signIn } from "./helpers";

// Runs against the harness's messaging stand-in (backend/tests/e2e_support/mock_messaging.py):
// an SMTP sink, and Twilio / WhatsApp Cloud API look-alikes that send signed delivery reports.
const MOCK = process.env.E2E_MESSAGING_MOCK ?? "http://localhost:9997";
test.describe.configure({ mode: "serial" });
const tag = runTag();
const kid = `Notify Kid ${tag}`;
const cls = `Notify ${tag}`;
const mobile = `97${String(Date.now()).slice(-8)}`; // the family mobile (Parent A has no phone)
const e164 = `+91${mobile}`;
const twilioToken = `mock_twilio_token_${tag}_secret`;
const waToken = `EAAmock_${tag}_access_token_x`;
const waSecret = `wa_app_secret_${tag}_xyz`;
let studentId = "";
let classId = "";
let receipt = "";

interface Outboxed { channel: string; to: string; subject?: string; body?: string; template?: string; params?: string[] }
async function outbox(channel: string, to?: string): Promise<Outboxed[]> {
  return (await fetch(`${MOCK}/mock/outbox?channel=${channel}${to ? `&to=${encodeURIComponent(to)}` : ""}`)).json();
}

test.beforeAll(async () => {
  const t = await accessToken("ADMIN_A");
  const post = (path: string, body?: unknown) => api(path, t, { method: "POST", school: SCHOOL_A(), body });
  const sessions: { id: string; is_current: boolean }[] = await (await api("/sessions", t, { school: SCHOOL_A() })).json();
  const cur = sessions.find((s) => s.is_current)!.id;
  await post("/classes/bulk", { classes: [{ name: cls, display_order: 62 }] });
  classId = (await (await api(`/classes?session_id=${cur}`, t, { school: SCHOOL_A() })).json()).items.find((c: { name: string }) => c.name === cls).id;
  await post("/sections/bulk", { academic_session_id: cur, class_ids: [classId], names: ["A"] });
  const sec = (await (await api(`/sections?session_id=${cur}&class_id=${classId}`, t, { school: SCHOOL_A() })).json()).items[0].id;
  studentId = (await (await post("/students", { full_name: kid, father_name: "Father", mother_name: "Mother", date_of_birth: "2016-06-06", gender: "female",
    mobile, enrollment: { academic_session_id: cur, class_id: classId, section_id: sec, admission_number: `${tag}-NT`, admission_date: "2026-04-01" } })).json()).id;
  expect((await post(`/students/${studentId}/guardians`, { email: email("PARENT_A"), full_name: "E2E Parent A", relationship: "mother" })).status).toBe(201);
  await post("/fee-heads/bulk", { names: ["Tuition Fee"] });
  const head = (await (await api("/fee-heads", t, { school: SCHOOL_A() })).json()).find((h: { name: string }) => h.name === "Tuition Fee").id;
  const fs = await (await post("/fee-structures", { academic_session_id: cur, class_id: classId })).json();
  await post(`/fee-structures/${fs.id}/items`, { fee_head_id: head, amount: "1200", frequency: "monthly" });
  // start from the standard wording
  for (const ch of ["email", "sms", "whatsapp"])
    await api(`/notifications/admin/templates/payment_received/${ch}`, t, { method: "DELETE", school: SCHOOL_A() });
});

test.afterAll(async () => {
  const t = await accessToken("ADMIN_A");
  for (const l of await (await api(`/students/${studentId}/guardians`, t, { school: SCHOOL_A() })).json())
    await api(`/students/${studentId}/guardians/${l.id}`, t, { method: "DELETE", school: SCHOOL_A() });
});

async function openTemplates(page: Page, eventKey: string) {
  await page.goto("/communication?tab=Templates");
  await expect(page.getByRole("tab", { name: "Templates" })).toHaveAttribute("aria-selected", "true");
  await page.getByTestId(`template-event-${eventKey}`).click();
}

test("an admin edits the wording; unknown placeholders are refused; the preview uses sample data", async ({ page }) => {
  await signIn(page, "ADMIN_A");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Communication" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Communication" })).toBeVisible();
  await openTemplates(page, "payment_received");

  const mail = page.getByTestId("template-email");
  await mail.getByTestId("template-subject").fill(`Receipt {{receipt_number}} for {{student_name}} [${tag}]`);
  await mail.getByTestId("template-body").fill("Dear {{recipient_name}}, your password is {{password}}");
  await mail.getByTestId("template-save").click();
  await expect(mail.getByTestId("template-error")).toContainText("Unknown placeholder {{password}}");
  await mail.getByTestId("template-body").fill("Dear {{recipient_name}},\n\nWe received {{amount}} for {{student_name}} by {{payment_mode}}. Still to pay: {{balance}}.\n\n{{school_name}}");
  await mail.getByTestId("template-preview-btn").click();
  await expect(mail.getByTestId("template-preview")).toContainText("We received ₹4,500 for Aarav Verma by UPI");
  await mail.getByTestId("template-save").click();
  await expect(mail.getByText("Changed")).toBeVisible();

  const sms = page.getByTestId("template-sms");
  await sms.getByTestId("template-enabled-sms").check();
  await expect(sms.getByTestId("sms-count")).toContainText("1 SMS part");
  await sms.getByTestId("template-save").click();
  await expect(sms.getByText("Changed")).toBeVisible();

  const wa = page.getByTestId("template-whatsapp");
  await wa.getByTestId("template-enabled-whatsapp").check();
  await wa.getByTestId("template-save").click();
  await expect(wa.getByTestId("template-error")).toContainText("WhatsApp template");
  await wa.getByTestId("wa-template").fill("payment_received");
  await wa.getByTestId("wa-language").fill("en");
  await wa.getByTestId("template-save").click();
  await expect(wa.getByText("Changed")).toBeVisible();

  // the school's changes stay in the school
  const other = await (await api("/notifications/admin/events", await accessToken("ADMIN_B"), { school: SCHOOL_B() })).json();
  expect(other.find((e: { key: string }) => e.key === "payment_received").channels.email.customised).toBe(false);
});

test("an admin connects SMS and WhatsApp; tokens never come back; test messages go out and report back", async ({ page }) => {
  await signIn(page, "ADMIN_A");
  await page.goto("/communication?tab=Channels");

  // no quiet hours, so this test passes at any time of day
  await page.getByTestId("quiet-start").selectOption("0");
  await page.getByTestId("quiet-end").selectOption("0");
  await page.getByTestId("reminder-days").fill("31");
  await page.getByTestId("save-notify-settings").click();
  await expect(page.getByTestId("settings-error")).toContainText("1 to 28");
  await page.getByTestId("reminder-days").fill("");
  await page.getByTestId("save-notify-settings").click();
  await expect(page.getByText("Settings saved.")).toBeVisible();

  const sms = page.getByTestId("sms-card");
  await sms.getByTestId("sms-sid").fill(`AC${"e2e0".repeat(8)}`);
  await sms.getByTestId("sms-token").fill(twilioToken);
  await sms.getByTestId("sms-from").fill("+15005550006");
  await sms.getByTestId("sms-enabled").check();
  await sms.getByTestId("save-sms").click();
  await expect(sms.getByTestId("channel-status")).toHaveText("On");

  const wa = page.getByTestId("whatsapp-card");
  await wa.getByTestId("wa-phone-id").fill("1098765432");
  await wa.getByTestId("wa-token").fill(waToken);
  await wa.getByTestId("wa-secret").fill(waSecret);
  await wa.getByTestId("wa-enabled").check();
  await wa.getByTestId("save-whatsapp").click();
  await expect(wa.getByTestId("channel-status")).toHaveText("On");

  await page.reload();
  await expect(page.getByTestId("sms-token")).toHaveValue("");
  await expect(page.getByTestId("sms-token")).toHaveAttribute("placeholder", /Saved/);
  for (const secret of [twilioToken, waToken, waSecret]) expect(await page.content()).not.toContain(secret);
  const raw = await (await api("/notifications/admin/channels", await accessToken("ADMIN_A"), { school: SCHOOL_A() })).text();
  for (const secret of [twilioToken, waToken, waSecret]) expect(raw).not.toContain(secret);
  const hook = (await page.getByTestId("wa-webhook-url").textContent())!.trim();
  expect(hook).toContain(`/api/v1/notifications/webhooks/whatsapp/${SCHOOL_A()}`);
  // what an admin does in Meta's dashboard: add the webhook (Meta checks it with the verify token first)
  const token = (await page.getByTestId("wa-verify-token").textContent())!.trim();
  const verify = await fetch(`${hook}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=ch-${tag}`);
  expect(await verify.text()).toBe(`ch-${tag}`);
  expect((await fetch(`${hook}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`)).status).toBe(403);
  expect((await fetch(`${MOCK}/mock/whatsapp/webhook`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone_number_id: "1098765432", url: hook, app_secret: waSecret }) })).status).toBe(200);

  const test_ = page.getByTestId("test-card");
  await test_.getByTestId("test-channel").selectOption("sms");
  await test_.getByTestId("test-address").fill(`+91 98${String(Date.now()).slice(-8)}`);
  await test_.getByTestId("send-test").click();
  await expect(test_.getByTestId("test-result")).toContainText("Delivered", { timeout: 20_000 }); // Twilio's signed status report

  await test_.getByTestId("test-address").fill("+15005550001"); // Twilio's "invalid number"
  await test_.getByTestId("send-test").click();
  await expect(test_.getByTestId("test-result")).toContainText("Failed", { timeout: 20_000 });
  await expect(test_.getByTestId("test-result-error")).toContainText("21211");

  const to = `notify-${tag.toLowerCase()}@example.com`;
  await test_.getByTestId("test-channel").selectOption("email");
  await test_.getByTestId("test-address").fill(to);
  await test_.getByTestId("send-test").click();
  await expect(test_.getByTestId("test-result")).toContainText("Sent", { timeout: 20_000 });
  expect((await outbox("email", to))[0].subject).toContain("Test message from");

  await test_.getByTestId("test-channel").selectOption("whatsapp");
  await test_.getByTestId("test-address").fill(`+91 96${String(Date.now()).slice(-8)}`);
  await test_.getByTestId("send-test").click();
  await expect(test_.getByTestId("test-result")).toContainText(/Delivered|Read/, { timeout: 20_000 });
});

test("a fee payment reaches the parent: in the app, by email, SMS and WhatsApp", async ({ page }) => {
  const t = await accessToken("ACCOUNTANT_A");
  const acc = await (await api(`/fee-collection/students/${studentId}`, t, { school: SCHOOL_A() })).json();
  const due = acc.dues.find((d: { balance: string }) => Number(d.balance) > 0);
  const res = await api(`/fee-collection/enrollments/${acc.enrollment_id}/payments`, t, { method: "POST", school: SCHOOL_A(), body: {
    idempotency_key: randomUUID(), payment_date: new Date().toISOString().slice(0, 10), payment_mode: "upi", reference_number: `UPI${tag}`,
    allocations: [{ due_id: due.due_id, amount: "1200" }] } });
  expect(res.status).toBe(201);
  receipt = (await res.json()).payment.receipt_number;

  // email to the parent's account, with the school's wording
  await expect.poll(async () => (await outbox("email", email("PARENT_A"))).find((m) => m.subject?.includes(receipt))?.subject, { timeout: 20_000 })
    .toBe(`Receipt ${receipt} for ${kid} [${tag}]`);
  // SMS to the family mobile (the parent has no phone number), in the cheaper plain alphabet
  await expect.poll(async () => (await outbox("sms", e164)).map((m) => m.body).join(" | "), { timeout: 20_000 }).toContain(`Received Rs 1,200 for ${kid}`);
  // WhatsApp: the approved template, with its values in order
  await expect.poll(async () => (await outbox("whatsapp", e164))[0]?.params, { timeout: 20_000 }).toEqual(["₹1,200", kid, receipt, "E2E Test School A"]);

  await signIn(page, "PARENT_A");
  await expect(page.getByTestId("notification-count")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("notification-bell").click();
  const item = page.getByTestId("notification-menu").getByTestId("notification-item").filter({ hasText: "Payment received: ₹1,200" }).first();
  await expect(item).toContainText(`Receipt ${receipt} for ${kid}`);
  await item.click();
  await expect(page).toHaveURL(new RegExp(`/portal/${studentId}\\?tab=Fees`));
  await expect(page.getByRole("tab", { name: "Fees" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("portal-payments")).toContainText(receipt);
});

test("the history shows every message and its delivery; a failed one can be sent again", async ({ page }) => {
  await signIn(page, "ADMIN_A");
  await page.goto("/communication");
  await page.getByTestId("history-filter").selectOption("payment_received");
  const row = page.getByTestId("history-row").first();
  await expect(row.getByTestId("history-label")).toHaveText("Payment confirmation");
  await expect(row.getByTestId("history-counts")).toContainText("SMS · Delivered", { timeout: 20_000 });
  await expect(row.getByTestId("history-counts")).toContainText("WhatsApp · Read");
  await row.click();
  const detail = page.getByTestId("history-detail");
  await expect(detail.getByTestId("delivery-row").filter({ hasText: e164 }).first()).toBeVisible();
  await expect(detail.getByTestId("detail-in-app")).toContainText("1 sent");
  await page.keyboard.press("Escape");

  await page.getByTestId("history-filter").selectOption("test");
  await page.getByTestId("history-row").filter({ hasText: "Test message" }).filter({ has: page.getByText("SMS · Failed") }).first().click();
  await expect(page.getByTestId("delivery-error")).toContainText("21211");
  await page.getByTestId("delivery-retry").click();
  await expect(page.getByText("It will be sent again")).toBeVisible();

  // admins only; and only their own school
  expect((await api("/notifications/admin/history", await accessToken("ACCOUNTANT_A"), { school: SCHOOL_A() })).status).toBe(403);
  expect((await api("/notifications/admin/history", await accessToken("TEACHER_A"), { school: SCHOOL_A() })).status).toBe(403);
  const b = await (await api("/notifications/admin/history?event_key=payment_received", await accessToken("ADMIN_B"), { school: SCHOOL_B() })).json();
  expect(JSON.stringify(b)).not.toContain(receipt);
  // delivery reports must be signed
  const hook = `/notifications/webhooks/twilio/${SCHOOL_A()}`;
  expect((await fetch(`${process.env.E2E_API_URL ?? "http://localhost:8000"}/api/v1${hook}`, { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "MessageSid=SM1&MessageStatus=delivered" })).status).toBe(403);
});

test("staff send fee reminders, at most once a day per student", async ({ page }) => {
  await signIn(page, "ACCOUNTANT_A");
  await page.goto("/fees/collect");
  await page.getByTestId("send-fee-reminders").click();
  await page.getByTestId("reminder-class").selectOption({ label: cls });
  await page.getByTestId("confirm-fee-reminders").click();
  await expect(page.getByText("Reminders queued for 1 student.")).toBeVisible();
  await page.getByTestId("send-fee-reminders").click();
  await page.getByTestId("reminder-class").selectOption({ label: cls });
  await page.getByTestId("confirm-fee-reminders").click();
  await expect(page.getByText("No reminders to send")).toBeVisible();
  await expect.poll(async () => (await outbox("email", email("PARENT_A"))).some((m) => m.subject === `Fee reminder for ${kid}`), { timeout: 20_000 }).toBe(true);
  expect((await api("/notifications/fee-reminders", await accessToken("TEACHER_A"), { method: "POST", school: SCHOOL_A(), body: {} })).status).toBe(403);
});

test("a notice lands in everyone's inbox; marking read and contact choices", async ({ page }) => {
  const title = `Sports day ${tag}`;
  expect((await api("/notices", await accessToken("ADMIN_A"), { method: "POST", school: SCHOOL_A(),
    body: { title, body: "All students in sports uniform, please.", audience: "everyone" } })).status).toBe(201);

  await signIn(page, "PARENT_A");
  await page.goto("/notifications");
  await expect(page.getByTestId("inbox-item").filter({ hasText: title })).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("inbox-read-all").click();
  await expect(page.getByTestId("inbox-mark-read")).toHaveCount(0);
  await expect(page.getByTestId("notification-count")).toHaveCount(0);

  // nobody can read or mark someone else's notifications
  const mine: { items: { id: string }[] } = await (await api("/notifications", await accessToken("PARENT_A"), { school: SCHOOL_A() })).json();
  expect((await api(`/notifications/${mine.items[0].id}/read`, await accessToken("TEACHER_A"), { method: "POST", school: SCHOOL_A() })).status).toBe(404);
  const teacher: { items: { id: string }[] } = await (await api("/notifications", await accessToken("TEACHER_A"), { school: SCHOOL_A() })).json();
  expect(teacher.items.some((i) => mine.items.some((m) => m.id === i.id))).toBe(false);

  await page.goto("/profile");
  const prefs = page.getByTestId("notification-prefs");
  await prefs.getByTestId("pref-sms").uncheck();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("pref-sms")).not.toBeChecked();
  await expect(page.getByTestId("pref-email")).toBeChecked();
  await page.getByTestId("pref-sms").check();
  await expect(page.getByTestId("pref-sms")).toBeChecked();
});
