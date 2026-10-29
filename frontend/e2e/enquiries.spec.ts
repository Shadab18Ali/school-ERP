import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { accessToken, api, API_URL, png, runTag, SCHOOL_A, SCHOOL_B, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });
const tag = runTag();
const cls = `Enq ${tag}`;
const kid = `Ishaan Enq ${tag}`;
const sibling = `Myra Enq ${tag}`;
const phone = `93${String(Date.now()).slice(-8)}`;
let enquiryId = "";
let enquiryNumber = "";
let sessionId = "";
let classId = "";
let code = "";

test.beforeAll(async () => {
  const t = await accessToken("ADMIN_A");
  const me = await (await api("/me", t)).json();
  code = me.memberships.find((m: { school_id: string }) => m.school_id === SCHOOL_A()).school_code.toLowerCase();
  const sessions: { id: string; is_current: boolean }[] = await (await api("/sessions", t, { school: SCHOOL_A() })).json();
  sessionId = sessions.find((s) => s.is_current)!.id;
  await api("/classes/bulk", t, { method: "POST", school: SCHOOL_A(), body: { classes: [{ name: cls, display_order: 51 }] } });
  classId = (await (await api(`/classes?session_id=${sessionId}`, t, { school: SCHOOL_A() })).json()).items.find((c: { name: string }) => c.name === cls).id;
});

test("the office adds an enquiry; a second one with the same mobile is flagged", async ({ page }) => {
  await signIn(page, "ACCOUNTANT_A");
  await page.goto("/enquiries");
  await expect(page.getByRole("heading", { level: 1, name: "Enquiries" })).toBeVisible();
  await page.getByTestId("new-enquiry").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("save-enquiry").click();
  await expect(dialog.getByTestId("enquiry-form-error")).toContainText("parent's name");
  await dialog.getByLabel("Parent's name").fill("Neha Kapoor");
  await dialog.getByLabel("Student's name").fill(kid);
  await dialog.getByLabel("Mobile number").fill(`+91 ${phone.slice(0, 5)} ${phone.slice(5)}`);
  await dialog.getByLabel("Interested class").selectOption({ label: cls });
  await dialog.getByLabel("Source", { exact: true }).selectOption("referral");
  await dialog.getByLabel("Source detail (optional)").fill("Mrs Iyer (parent of a Class 3 student)");
  await dialog.getByLabel("Notes").fill("Asked about the school bus from Sector 21.");
  await dialog.getByTestId("save-enquiry").click();

  await expect(page.getByRole("heading", { level: 1, name: kid })).toBeVisible();
  enquiryId = page.url().split("/").pop()!;
  enquiryNumber = (await page.locator("main p").filter({ hasText: /^ENQ-\d{5} · / }).first().textContent())!.split(" · ")[0];
  expect(enquiryNumber).toMatch(/^ENQ-\d{5}$/);
  await expect(page.getByTestId("enquiry-status")).toHaveText("New");
  await expect(page.getByTestId("enquiry-details")).toContainText("Referral · Mrs Iyer");
  await expect(page.getByTestId("enquiry-notes")).toContainText("school bus");
  await expect(page.getByTestId("enquiry-history")).toContainText("Enquiry added (New)");
  await expect(page.getByTestId("call-link")).toHaveAttribute("href", `tel:+91${phone}`);
  await expect(page.getByTestId("whatsapp-link")).toHaveAttribute("href", new RegExp(`^https://wa\\.me/91${phone}\\?text=`));
  await expect(page.getByTestId("send-apply-link")).toHaveAttribute("href", new RegExp(`apply%2F${code}`));

  // a sibling enquiry from the same parent: the earlier one is shown
  await page.goto("/enquiries");
  await page.getByTestId("new-enquiry").click();
  await dialog.getByLabel("Parent's name").fill("Neha Kapoor");
  await dialog.getByLabel("Student's name").fill(sibling);
  await dialog.getByLabel("Mobile number").fill(phone);
  await expect(dialog.getByTestId("duplicate-warning")).toContainText(enquiryNumber);
  await dialog.getByLabel("Status").selectOption("follow_up");
  await dialog.getByTestId("save-enquiry").click();
  await expect(dialog.getByTestId("enquiry-form-error")).toContainText("follow-up date");
  await dialog.getByLabel(/^Follow-up date/).fill(new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10));
  await dialog.getByTestId("save-enquiry").click();
  await expect(page.getByRole("heading", { level: 1, name: sibling })).toBeVisible();
  await expect(page.getByTestId("enquiry-duplicates")).toContainText(enquiryNumber);
});

test("working an enquiry: notes, status and follow-up dates go into the history", async ({ page }) => {
  await signIn(page, "ACCOUNTANT_A");
  await page.goto(`/enquiries/${enquiryId}`);
  const panel = page.getByTestId("update-panel");
  await panel.getByTestId("save-update").click();
  await expect(panel.getByTestId("update-error")).toContainText("write a note");

  await panel.getByTestId("update-note").fill("Called. Parents will visit on Saturday.");
  await panel.getByTestId("update-status").selectOption("contacted");
  await panel.getByTestId("save-update").click();
  await expect(page.getByTestId("enquiry-status")).toHaveText("Contacted");
  await expect(page.getByTestId("history-item").first()).toContainText("New → Contacted");
  await expect(page.getByTestId("history-item").first()).toContainText("Parents will visit on Saturday");

  await panel.getByTestId("update-status").selectOption("follow_up");
  await panel.getByTestId("update-follow-up").fill("");
  await panel.getByTestId("save-update").click();
  await expect(panel.getByTestId("update-error")).toContainText("follow-up date");
  await panel.getByRole("button", { name: "Tomorrow" }).click();
  await panel.getByTestId("update-note").fill("Visited; wants to see the fee structure.");
  await panel.getByTestId("save-update").click();
  await expect(page.getByTestId("enquiry-status")).toHaveText("Follow-up");
  await expect(page.getByTestId("history-item").first()).toContainText("Contacted → Follow-up, follow-up");

  await panel.getByTestId("update-status").selectOption("interested");
  await panel.getByTestId("save-update").click();
  await expect(page.getByTestId("enquiry-status")).toHaveText("Interested");
  await expect(page.getByTestId("history-item")).toHaveCount(4);

  // a past follow-up date is refused by the database even when the screen is bypassed
  const t = await accessToken("ACCOUNTANT_A");
  const past = await api(`/enquiries/${enquiryId}`, t, { method: "PATCH", school: SCHOOL_A(), body: { follow_up_date: "2020-01-01" } });
  expect(past.status).toBe(409);
  expect((await past.json()).detail).toContain("past");
});

test("the list filters, searches and exports", async ({ page }) => {
  await signIn(page, "ACCOUNTANT_A");
  await page.goto("/enquiries?tab=list");
  await page.getByLabel("Search").fill(tag);
  await expect(page.getByTestId("enquiry-list").locator("tbody tr")).toHaveCount(2);
  await page.getByTestId("enquiry-tab-interested").click();
  await expect(page.getByTestId("enquiry-list").locator("tbody tr")).toHaveCount(1);
  await expect(page.getByTestId(`enquiry-row-${enquiryNumber}`)).toContainText(kid);
  await page.getByTestId("enquiry-tab-all").click();
  await page.getByTestId("filter-follow-up").selectOption("week");
  await expect(page.getByTestId("enquiry-list").locator("tbody tr")).toHaveCount(2);
  await page.getByLabel("Search").fill(phone.slice(-6));  // by mobile
  await expect(page.getByTestId("enquiry-list").locator("tbody tr")).toHaveCount(2);

  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-enquiries").click()]);
  const csv = readFileSync((await dl.path())!, "utf8");
  expect(csv).toContain(enquiryNumber);
  expect(csv).toContain("Interested");
  expect(csv.split("\n")[0]).toContain("Follow-up date");
});

test("the pipeline dashboard shows the school's real numbers", async ({ page }) => {
  const t = await accessToken("ADMIN_A");
  const p = await (await api("/enquiries/pipeline", t, { school: SCHOOL_A() })).json();
  expect(p.total).toBeGreaterThanOrEqual(2);
  expect(p.funnel[0].count).toBe(p.total);
  expect(p.funnel[2].count).toBeGreaterThanOrEqual(1);  // reached "interested"

  await signIn(page, "ADMIN_A");
  await page.goto("/enquiries");
  await expect(page.getByTestId("kpi-enquiries")).toHaveText(String(p.total));
  await expect(page.getByTestId("kpi-open")).toHaveText(String(p.open));
  await expect(page.getByTestId("funnel-interested").getByTestId("funnel-count")).toHaveText(String(p.funnel[2].count));
  await expect(page.getByTestId("by-source")).toContainText("Referral");
  await expect(page.getByTestId("by-class")).toContainText(cls);
  await page.getByTestId("board-interested").click();
  await expect(page.getByTestId("enquiry-tab-interested")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId(`enquiry-row-${enquiryNumber}`)).toBeVisible();

  // the home dashboard reminds the office of follow-ups
  await page.goto("/dashboard");
  await expect(page.getByTestId("kpi-follow-ups")).toBeVisible();
});

test("an online application links to the enquiry and moves it along", async ({ page }) => {
  const t = await accessToken("ADMIN_A");
  await api("/admissions/windows", t, { method: "PUT", school: SCHOOL_A(), body: { academic_session_id: sessionId, class_id: classId, is_open: true, admission_fee: "0" } });
  // two open enquiries share the mobile (siblings): not linked automatically
  const form = await (await fetch(`${API_URL()}/api/v1/public/admissions/${code}`)).json();
  const w = form.windows.find((x: { class_name: string }) => x.class_name === cls);
  const fd = new FormData();
  fd.append("data", JSON.stringify({ window_id: w.window_id, student_name: kid, date_of_birth: "2019-07-01", gender: "male", mother_name: "Neha Kapoor",
    contact_phone: phone, address_line: "21 Sector 21, Dwarka", city: "New Delhi", state: "Delhi", postal_code: "110075", declaration: true }));
  fd.append("photo", new Blob([new Uint8Array(png(120, 160))], { type: "image/png" }), "photo.png");
  const r = await fetch(`${API_URL()}/api/v1/public/admissions/${code}`, { method: "POST", body: fd });
  expect(r.status).toBe(201);
  const number = (await r.json()).application_number as string;

  await signIn(page, "ACCOUNTANT_A");
  await page.goto(`/enquiries/${enquiryId}`);
  await expect(page.getByTestId("enquiry-application")).toContainText("Not linked");
  await page.getByTestId("link-application").click();
  const row = page.getByTestId("link-candidates").locator("li").filter({ hasText: number });
  await expect(row).toContainText("same mobile");
  await row.getByRole("button", { name: "Link" }).click();
  await expect(page.getByTestId("enquiry-application")).toContainText(number);
  await expect(page.getByTestId("enquiry-status")).toHaveText("Application");
  await expect(page.getByTestId("update-status")).toBeDisabled();
  await expect(page.getByTestId("history-item").first()).toContainText("Linked to online application");

  // the school approves the application: the enquiry follows
  const list = await (await api(`/admissions?search=${encodeURIComponent(number)}`, t, { school: SCHOOL_A() })).json();
  for (const st of ["under_review", "verified", "approved"])
    expect((await api(`/admissions/${list.items[0].id}/status`, t, { method: "POST", school: SCHOOL_A(), body: { status: st } })).status).toBe(200);
  await page.reload();
  await expect(page.getByTestId("enquiry-status")).toHaveText("Approved");
  await expect(page.getByTestId("history-item").first()).toContainText("approved");
  // and its status can't be set by hand while linked
  const acc = await accessToken("ACCOUNTANT_A");
  const manual = await api(`/enquiries/${enquiryId}`, acc, { method: "PATCH", school: SCHOOL_A(), body: { status: "admitted" } });
  expect(manual.status).toBe(409);
});

test("only the school office sees enquiries; only admins delete", async ({ page }) => {
  for (const who of ["TEACHER_A", "PARENT_A", "STUDENT_A"] as const) {
    const t = await accessToken(who);
    expect((await api("/enquiries", t, { school: SCHOOL_A() })).status, who).toBe(403);
    expect((await api(`/enquiries/${enquiryId}`, t, { school: SCHOOL_A() })).status, who).toBe(403);
    expect((await api("/enquiries/pipeline", t, { school: SCHOOL_A() })).status, who).toBe(403);
  }
  const b = await accessToken("ADMIN_B");
  expect((await api(`/enquiries/${enquiryId}`, b, { school: SCHOOL_B() })).status).toBe(404);
  expect((await api(`/enquiries/${enquiryId}`, b, { school: SCHOOL_A() })).status).toBe(403);
  const acc = await accessToken("ACCOUNTANT_A");
  expect((await api(`/enquiries/${enquiryId}`, acc, { method: "DELETE", school: SCHOOL_A() })).status).toBe(403);
  const anon = await fetch(`${API_URL()}/api/v1/enquiries`, { headers: { "X-School-Id": SCHOOL_A() } });
  expect(anon.status).toBe(401);

  // the admin deletes the sibling enquiry from its page
  const t = await accessToken("ADMIN_A");
  const sib = (await (await api(`/enquiries?search=${encodeURIComponent(sibling)}`, t, { school: SCHOOL_A() })).json()).items[0];
  await signIn(page, "ADMIN_A");
  await page.goto(`/enquiries/${sib.id}`);
  await page.getByTestId("delete-enquiry").click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/enquiries\?tab=list/);
  expect((await api(`/enquiries/${sib.id}`, t, { school: SCHOOL_A() })).status).toBe(404);
});
