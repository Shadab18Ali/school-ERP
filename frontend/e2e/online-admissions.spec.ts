import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { accessToken, api, API_URL, minimalPdf, png, runTag, SCHOOL_A, SCHOOL_B, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });
const tag = runTag();
const cls = `Adm ${tag}`;
const kid = `Aarav Adm ${tag}`;
const other = `Diya Adm ${tag}`;
const phone = `98${String(Date.now()).slice(-8)}`;
let code = "";
let sessionId = "";
let classId = "";
let number = "";
let appId = "";

async function submitByApi(student: string, mobile: string) {
  const form = await (await fetch(`${API_URL()}/api/v1/public/admissions/${code}`)).json();
  const w = form.windows.find((x: { class_name: string }) => x.class_name === cls);
  const fd = new FormData();
  fd.append("data", JSON.stringify({
    window_id: w.window_id, student_name: student, date_of_birth: "2019-04-10", gender: "female", mother_name: "Meera Sharma",
    contact_phone: mobile, address_line: "45 Park Street, Sector 9", city: "Jaipur", state: "Rajasthan", postal_code: "302001", declaration: true,
  }));
  fd.append("photo", new Blob([new Uint8Array(png(120, 160))], { type: "image/png" }), "photo.png");
  return fetch(`${API_URL()}/api/v1/public/admissions/${code}`, { method: "POST", body: fd });
}

test.beforeAll(async () => {
  const t = await accessToken("ADMIN_A");
  const me = await (await api("/me", t)).json();
  code = me.memberships.find((m: { school_id: string }) => m.school_id === SCHOOL_A()).school_code.toLowerCase();
  const sessions: { id: string; is_current: boolean }[] = await (await api("/sessions", t, { school: SCHOOL_A() })).json();
  sessionId = sessions.find((s) => s.is_current)!.id;
  await api("/classes/bulk", t, { method: "POST", school: SCHOOL_A(), body: { classes: [{ name: cls, display_order: 41 }] } });
  classId = (await (await api(`/classes?session_id=${sessionId}`, t, { school: SCHOOL_A() })).json()).items.find((c: { name: string }) => c.name === cls).id;
  await api("/sections/bulk", t, { method: "POST", school: SCHOOL_A(), body: { academic_session_id: sessionId, class_ids: [classId], names: ["A"] } });
});

test("admin opens admissions for a class and gets the public link", async ({ page }) => {
  await signIn(page, "ADMIN_A");
  await page.goto("/admissions");
  await expect(page.getByRole("heading", { level: 1, name: "Admissions" })).toBeVisible();
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByTestId("apply-link")).toContainText(`/apply/${code}`);
  const row = page.getByTestId(`window-row-${cls}`);
  await row.getByLabel(`Open admissions for ${cls}`).check();
  await row.getByLabel("Admission fee (₹)").fill("2500");
  await row.getByLabel("Seats").fill("1");
  await row.getByLabel("Instructions for parents").fill("Bring the original birth certificate when you visit.");
  await row.getByTestId("save-window").click();
  await expect(page.getByText(`${cls}: admission settings saved.`)).toBeVisible();
});

test("a parent applies online without an account and tracks the application", async ({ page }) => {
  await page.goto(`/apply/${code}`);
  await expect(page).toHaveURL(new RegExp(`/apply/${code}$`));  // public: no redirect to login
  await page.getByTestId("submit-application").click();
  await expect(page.getByTestId("apply-error")).toContainText("correct the highlighted fields");

  await page.getByTestId(`window-${cls}`).click();
  await expect(page.getByTestId("instructions")).toContainText("original birth certificate");
  await expect(page.getByTestId(`window-${cls}`)).toContainText("1 seat left");
  await page.getByLabel("Full name").fill(kid);
  await page.getByLabel("Date of birth").fill("2019-06-15");
  await page.getByLabel("Gender").selectOption("male");
  await page.getByLabel("Father's name").fill("Rohan Verma");
  await page.getByLabel("Father's occupation").fill("Engineer");
  await page.getByLabel("Mother's name").fill("Kavya Verma");
  await page.getByLabel("Contact mobile").fill(phone);
  await page.getByLabel("House, street, area").fill("21 Lake View Road, Banjara Hills");
  await page.getByLabel("City").fill("Hyderabad");
  await page.getByLabel("State").fill("Telangana");
  await page.getByLabel("PIN code").fill("500 034");
  await page.getByLabel("School name").fill("Sunrise Montessori");
  await page.getByLabel("Class studied").fill("UKG");
  await page.locator("#photo").setInputFiles({ name: "child.png", mimeType: "image/png", buffer: png(120, 160) });
  await page.getByLabel("Document 1 file").setInputFiles({ name: "birth-certificate.pdf", mimeType: "application/pdf", buffer: minimalPdf() });
  await page.getByText("I confirm that the information").click();
  await page.getByTestId("submit-application").click();

  await expect(page.getByTestId("application-done")).toBeVisible();
  number = (await page.getByTestId("application-number").textContent())!.trim();
  expect(number).toMatch(/^ADM\d{4}-\d{5}$/);

  await page.getByRole("link", { name: "Check status" }).click();
  await expect(page).toHaveURL(/\/track\?number=/);
  await expect(page.getByLabel("Application number")).toHaveValue(number);
  await page.getByLabel("Mobile number").fill("9000000000");
  await page.getByTestId("check-status").click();
  await expect(page.getByTestId("track-error")).toContainText("No application matches");
  await page.getByLabel("Mobile number").fill(`+91 ${phone}`);
  await page.getByTestId("check-status").click();
  await expect(page.getByTestId("track-status")).toHaveText("Application received");
  await expect(page.getByTestId("admission-stepper").locator("li").first()).toHaveAttribute("data-state", "done");

});

test("admin reviews, verifies and approves", async ({ page }) => {
  await signIn(page, "ADMIN_A");
  await page.goto("/admissions");
  await page.getByTestId("status-tab-submitted").click();
  const row = page.getByTestId(`application-row-${number}`);
  await expect(row).toContainText(kid);
  await row.getByRole("link", { name: number }).click();
  await expect(page.getByRole("heading", { level: 1, name: kid })).toBeVisible();
  appId = page.url().split("/").pop()!;
  await expect(page.getByTestId("applicant-photo")).toBeVisible();
  await expect(page.getByTestId("application-documents")).toContainText("Birth certificate");
  await expect(page.getByTestId("action-fee")).toHaveCount(0);

  await page.getByTestId("action-review").click();
  await page.getByTestId("confirm-status").click();
  await expect(page.getByTestId("admission-status").first()).toHaveText("Under review");
  await page.getByTestId("action-verify").click();
  await page.getByTestId("status-note").fill("Birth certificate checked against the original.");
  await page.getByTestId("confirm-status").click();
  await expect(page.getByTestId("admission-status").first()).toHaveText("Documents verified");
  await page.getByTestId("action-approve").click();
  await expect(page.getByTestId("approve-summary")).toContainText("2,500");
  await expect(page.getByTestId("approve-summary")).toContainText("0 of 1");
  await page.getByTestId("confirm-status").click();
  await expect(page.getByTestId("admission-status").first()).toHaveText("Approved");
  await expect(page.getByTestId("action-enroll")).toHaveCount(0);
  await expect(page.getByTestId("action-fee")).toBeVisible();  // admins may also record the fee
  await expect(page.getByTestId("admission-timeline")).toContainText("Birth certificate checked");
});

test("accountant records the admission fee and downloads the receipt", async ({ page }) => {
  await signIn(page, "ACCOUNTANT_A");
  await page.goto(`/admissions/${appId}`);
  await expect(page.getByRole("heading", { level: 1, name: kid })).toBeVisible();
  await expect(page.getByTestId("action-reject")).toHaveCount(0);
  await expect(page.getByTestId("action-edit")).toHaveCount(0);
  await page.getByTestId("action-fee").click();
  await expect(page.getByTestId("fee-due")).toContainText("2,500");
  await page.getByLabel("Paid by").selectOption("upi");
  await page.getByLabel("Reference (optional)").fill(`UPI${tag}`);
  await page.getByTestId("save-fee").click();
  await expect(page.getByTestId("admission-status").first()).toHaveText("Admission fee paid");
  await expect(page.getByTestId("fee-card")).toContainText("ADR-");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download-admission-receipt").click()]);
  expect(readFileSync((await dl.path())!).subarray(0, 4).toString()).toBe("%PDF");
  await expect(page.getByTestId("action-enroll")).toHaveCount(0);  // only admins create the student
});

test("admin creates the student; the parent sees the admission complete", async ({ page, browser }) => {
  await signIn(page, "ADMIN_A");
  await page.goto(`/admissions/${appId}`);
  await page.getByTestId("action-enroll").click();
  await expect(page.getByTestId("enroll-section")).toHaveValue(/.+/);
  await page.getByTestId("confirm-enroll").click();
  await expect(page.getByTestId("admission-status").first()).toHaveText("Student created");
  await expect(page.getByTestId("action-edit")).toHaveCount(0);
  await page.getByTestId("created-student").getByRole("link", { name: "Open student record" }).click();
  await expect(page.getByRole("heading", { level: 1, name: kid })).toBeVisible();
  await expect(page.getByText(number).first()).toBeVisible();  // admission number defaults to the application number

  const visitor = await (await browser.newContext({ baseURL: test.info().project.use.baseURL })).newPage();  // the parent, not signed in
  await visitor.goto(`/apply/${code}/track?number=${number}`);
  await visitor.getByLabel("Mobile number").fill(phone);
  await visitor.getByTestId("check-status").click();
  await expect(visitor.getByTestId("track-status")).toHaveText("Admission complete");
  await expect(visitor.getByTestId("track-result")).toContainText("ADR-");
  await visitor.context().close();
});

test("seats run out, a rejection needs a reason, and the parent sees it", async ({ page: staff, browser }) => {
  const mobile = `97${String(Date.now()).slice(-8)}`;
  const r = await submitByApi(other, mobile);
  expect(r.status).toBe(201);
  const num = (await r.json()).application_number as string;
  expect((await submitByApi(other, mobile)).status).toBe(409);  // same child again

  const t = await accessToken("ADMIN_A");
  const list = await (await api(`/admissions?session_id=${sessionId}&search=${encodeURIComponent(num)}`, t, { school: SCHOOL_A() })).json();
  const id = list.items[0].id;
  for (const st of ["under_review", "verified"])
    expect((await api(`/admissions/${id}/status`, t, { method: "POST", school: SCHOOL_A(), body: { status: st } })).status).toBe(200);
  const full = await api(`/admissions/${id}/status`, t, { method: "POST", school: SCHOOL_A(), body: { status: "approved" } });
  expect(full.status).toBe(409);
  expect((await full.json()).detail).toContain("seats");

  await signIn(staff, "ADMIN_A");
  await staff.goto(`/admissions/${id}`);
  await staff.getByTestId("action-reject").click();
  await staff.getByTestId("confirm-status").click();
  await expect(staff.getByTestId("status-error")).toContainText("reason");
  await staff.getByTestId("status-note").fill("All seats in this class are filled for this session.");
  await staff.getByTestId("confirm-status").click();
  await expect(staff.getByTestId("rejection-reason")).toContainText("All seats");
  await expect(staff.getByTestId("action-reopen")).toBeVisible();

  const page = await (await browser.newContext({ baseURL: test.info().project.use.baseURL })).newPage();  // the parent, not signed in
  await page.goto(`/apply/${code}/track?number=${num}`);
  await page.getByLabel("Mobile number").fill(mobile);
  await page.getByTestId("check-status").click();
  await expect(page.getByTestId("track-status")).toHaveText("Not approved");
  await expect(page.getByTestId("track-reason")).toContainText("All seats");
  await expect(page.getByTestId("admission-stepper").locator('li[data-state="failed"]')).toHaveCount(1);
  await expect(page.getByTestId("admission-stepper").locator('li[data-state="done"]')).toHaveCount(3);  // reached verification

  // rejected straight away: review and verification are not shown as done
  const m3 = `96${String(Date.now()).slice(-8)}`;
  const r3 = await submitByApi(`Kabir Adm ${tag}`, m3);
  const n3 = (await r3.json()).application_number as string;
  const id3 = (await (await api(`/admissions?search=${encodeURIComponent(n3)}`, t, { school: SCHOOL_A() })).json()).items[0].id;
  expect((await api(`/admissions/${id3}/status`, t, { method: "POST", school: SCHOOL_A(), body: { status: "rejected", rejection_reason: "Incomplete form." } })).status).toBe(200);
  await page.goto(`/apply/${code}/track?number=${n3}`);
  await page.getByLabel("Mobile number").fill(m3);
  await page.getByTestId("check-status").click();
  await expect(page.getByTestId("track-status")).toHaveText("Not approved");
  await expect(page.getByTestId("admission-stepper").locator('li[data-state="done"]')).toHaveCount(1);
  await page.context().close();
});

test("applications are visible only to the school's admins and accountants", async () => {
  const anon = await fetch(`${API_URL()}/api/v1/admissions`, { headers: { "X-School-Id": SCHOOL_A() } });
  expect(anon.status).toBe(401);
  for (const who of ["TEACHER_A", "PARENT_A", "STUDENT_A"] as const) {
    const t = await accessToken(who);
    expect((await api("/admissions", t, { school: SCHOOL_A() })).status, who).toBe(403);
    expect((await api(`/admissions/${appId}`, t, { school: SCHOOL_A() })).status, who).toBe(403);
  }
  const acct = await accessToken("ACCOUNTANT_A");
  expect((await api(`/admissions/${appId}/status`, acct, { method: "POST", school: SCHOOL_A(), body: { status: "under_review" } })).status).toBe(403);
  expect((await api("/admissions/windows", acct, { method: "PUT", school: SCHOOL_A(), body: { academic_session_id: sessionId, class_id: classId, is_open: false, admission_fee: "0" } })).status).toBe(403);
  const b = await accessToken("ADMIN_B");
  expect((await api(`/admissions/${appId}`, b, { school: SCHOOL_B() })).status).toBe(404);
  expect((await api(`/admissions/${appId}`, b, { school: SCHOOL_A() })).status).toBe(403);
  // a completed admission can't be changed, even by the admin
  const a = await accessToken("ADMIN_A");
  expect((await api(`/admissions/${appId}/status`, a, { method: "POST", school: SCHOOL_A(), body: { status: "rejected", rejection_reason: "Changed mind" } })).status).toBe(409);
});
