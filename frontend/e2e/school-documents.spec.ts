import { expect, test, type Browser, type Page } from "@playwright/test";
import { accessToken, api, png, runTag, SCHOOL_A, SCHOOL_B, signIn } from "./helpers";

// Phase 27: certificates (bonafide, transfer, custom), ID cards, signature, PDFs and the public QR check.
test.describe.configure({ mode: "serial", timeout: 120_000 });
const tag = runTag();
const cls = `Cert ${tag}`;
const boy = `Aarav ${tag}`;
const girl = `Diya ${tag}`;
const staffName = `Suresh ${tag}`;
const SP = `S${tag.replace(/\d/g, (d) => "ABCDEFGHIJ"[Number(d)])}`.slice(0, 6); // custom certificate prefix (letters)
let boyId = "";
let girlId = "";

async function admin() {
  const t = await accessToken("ADMIN_A");
  return {
    get: async (path: string) => (await api(path, t, { school: SCHOOL_A() })).json(),
    post: (path: string, body?: unknown) => api(path, t, { method: "POST", school: SCHOOL_A(), body }),
  };
}

test.beforeAll(async () => {
  const a = await admin();
  const cur = (await a.get("/sessions")).find((s: { is_current: boolean }) => s.is_current).id;
  await a.post("/classes/bulk", { classes: [{ name: cls, display_order: 65 }] });
  const classId = (await a.get(`/classes?session_id=${cur}`)).items.find((c: { name: string }) => c.name === cls).id;
  await a.post("/sections/bulk", { academic_session_id: cur, class_ids: [classId], names: ["A"] });
  const sec = (await a.get(`/sections?session_id=${cur}&class_id=${classId}`)).items[0].id;
  const add = async (full_name: string, gender: string, father: string | null, mother: string | null, mobile: string, n: number) =>
    (await (await a.post("/students", { full_name, father_name: father, mother_name: mother, date_of_birth: "2015-05-05", gender, mobile,
      address: "12 MG Road, Lucknow", enrollment: { academic_session_id: cur, class_id: classId, section_id: sec, admission_number: `${tag}-C${n}`, admission_date: "2026-04-01" } })).json()).id;
  boyId = await add(boy, "male", "Rakesh Sharma", null, "9555500021", 1);
  girlId = await add(girl, "female", null, "Sunita Verma", "9555500022", 2);
  expect((await a.post("/teachers", { full_name: staffName, phone: "9555500023", email: `suresh-${tag.toLowerCase()}@example.com`, joining_date: "2020-06-01",
    staff_type: "non_teaching", designation: "Office Assistant" })).status).toBe(201);
});

async function asUser(browser: Browser, who: Parameters<typeof signIn>[1]): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, who);
  return page;
}

async function downloadPdf(page: Page, click: () => Promise<void>): Promise<string> {
  const [dl] = await Promise.all([page.waitForEvent("download"), click()]);
  const chunks: Buffer[] = [];
  for await (const c of await dl.createReadStream()) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  expect(body.subarray(0, 5).toString()).toBe("%PDF-");
  return dl.suggestedFilename();
}

test("the admin sets the principal, place and signature used on documents", async ({ browser }) => {
  const page = await asUser(browser, "ADMIN_A");
  await page.goto("/certificates?tab=Settings");
  await page.getByTestId("settings-principal").fill("Dr. Meera Iyer");
  await page.getByTestId("settings-place").fill("Lucknow");
  await page.getByTestId("save-document-settings").click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await page.getByTestId("signature-file").setInputFiles({ name: "signature.png", mimeType: "image/png", buffer: png(300, 90) });
  await expect(page.getByTestId("signature-preview")).toBeVisible();
});

test("a bonafide certificate is filled in from the student's record, numbered and printable", async ({ browser }) => {
  const page = await asUser(browser, "ADMIN_A");
  await page.goto(`/students/${boyId}`);
  await page.getByTestId("student-certificate").click();
  await expect(page.getByTestId("picked-student")).toContainText(boy);
  await page.getByTestId("pick-template-BC").click();
  await page.getByTestId("preview-certificate").click();
  await expect(page.getByTestId("issue-error")).toContainText("purpose");         // the wording uses the purpose
  await page.getByTestId("issue-purpose").fill("passport application");
  await expect(page.getByTestId("issue-certificate")).toBeDisabled();             // preview first
  await page.getByTestId("preview-certificate").click();
  const preview = page.getByTestId("certificate-preview");
  await expect(preview).toContainText(`${boy}, son of Rakesh Sharma, is a bonafide student`);
  await expect(preview).toContainText(`${cls} – A`);
  await expect(preview).toContainText("5 May 2015 (Fifth May Two Thousand Fifteen)");
  await page.getByTestId("issue-certificate").click();
  await expect(page.getByTestId("issued-number")).toHaveText(/^BC-\d{4}-\d{4}$/);
  const number = (await page.getByTestId("issued-number").textContent())!;
  expect(await downloadPdf(page, () => page.getByTestId("issued-result").getByTestId("pdf-download").click())).toBe(`${number}.pdf`);
});

test("a transfer certificate asks for its fields, marks the student as left, and only one is valid", async ({ browser }) => {
  const page = await asUser(browser, "ADMIN_A");
  await page.goto("/certificates");
  await page.getByTestId("pick-template-TC").click();
  await page.getByTestId("student-search").fill(boy);
  await page.getByTestId("student-results").getByRole("button", { name: new RegExp(boy) }).click();
  await page.getByTestId("preview-certificate").click();
  await expect(page.getByTestId("issue-error")).toHaveText("Fill in “Date of leaving”.");
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  await page.getByTestId("field-leaving_date").fill(today);
  await page.getByTestId("field-reason").fill("Family relocating to Pune");
  await page.getByTestId("field-conduct").fill("Good");
  await expect(page.getByTestId("mark-left")).toBeChecked();
  await page.getByTestId("preview-certificate").click();
  await expect(page.getByTestId("certificate-preview")).toContainText("Reason for leaving: Family relocating to Pune");
  await expect(page.getByTestId("certificate-preview")).not.toContainText("Remarks");   // optional and empty: line left out
  await page.getByTestId("issue-certificate").click();
  await expect(page.getByTestId("issued-number")).toHaveText(/^TC-\d{4}-\d{4}$/);
  await expect(page.getByTestId("issued-result")).toContainText("marked as having left");

  const a = await admin();
  const s = await a.get(`/students/${boyId}`);
  expect(s.status).toBe("inactive");
  expect(s.status_reason).toMatch(/transfer certificate TC-/);

  // a second TC is refused while the first is valid; a bonafide is refused now that he has left
  await page.getByTestId("issue-another").click();
  await page.getByTestId("pick-template-TC").click();
  await page.getByTestId("student-search").fill(boy);
  await page.getByTestId("student-results").getByRole("button", { name: new RegExp(boy) }).click();
  await page.getByTestId("field-leaving_date").fill(today);
  await page.getByTestId("field-reason").fill("Again");
  await page.getByTestId("field-conduct").fill("Good");
  await page.getByTestId("preview-certificate").click();
  await page.getByTestId("issue-certificate").click();
  await expect(page.getByTestId("issue-error")).toContainText("has already been issued to this student");
  const r = await a.post("/certificates", { template_id: (await a.get("/certificates/templates")).find((t: { prefix: string }) => t.prefix === "BC").id, student_id: boyId, purpose: "bank" });
  expect(r.status).toBe(409);
  expect((await r.json()).detail).toContain("isn't active");
});

test("the school adds its own certificate with an extra field and issues it", async ({ browser }) => {
  const page = await asUser(browser, "ADMIN_A");
  await page.goto("/certificates?tab=Templates");
  await page.getByTestId("add-template").click();
  await page.getByTestId("template-name").fill(`Sports ${tag}`);
  await page.getByTestId("template-title").fill("Certificate of Merit");
  await page.getByTestId("template-prefix").fill(SP);
  await page.getByTestId("template-body").fill("This is to certify that {{student_name}} of {{class_section}} won {{positon}} in {{event}}.");
  await page.getByTestId("add-field").click();
  await page.getByTestId("field-key-0").fill("event");
  await page.getByTestId("field-label-0").fill("Event");
  await page.getByTestId("save-template").click();
  await expect(page.getByTestId("template-error")).toContainText("Unknown placeholder {{positon}}");
  await page.getByTestId("template-body").fill("This is to certify that {{student_name}} of {{class_section}} took part in {{event}}.");
  await page.getByTestId("save-template").click();
  await expect(page.getByTestId(`template-${SP}`)).toContainText(`Sports ${tag}`);

  await page.getByTestId("certificates-tab-issue").click();
  await page.getByTestId(`pick-template-${SP}`).click();
  await page.getByTestId("student-search").fill(girl);
  await page.getByTestId("student-results").getByRole("button", { name: new RegExp(girl) }).click();
  await page.getByTestId("field-event").fill("Inter-school athletics");
  await page.getByTestId("preview-certificate").click();
  await expect(page.getByTestId("certificate-preview")).toContainText(`${girl} of ${cls} – A took part in Inter-school athletics.`);
  await page.getByTestId("issue-certificate").click();
  await expect(page.getByTestId("issued-number")).toHaveText(new RegExp(`^${SP}-\\d{4}-0001$`));
});

test("a revoked certificate shows as revoked when its QR code is scanned; the public sees only the essentials", async ({ browser }) => {
  const page = await asUser(browser, "ADMIN_A");
  const a = await admin();
  const list = await a.get(`/certificates?student_id=${boyId}`);
  const tc = list.items.find((c: { kind: string }) => c.kind === "transfer");
  const bc = list.items.find((c: { kind: string }) => c.kind === "bonafide");
  await page.goto("/certificates?tab=Issued");
  await page.getByTestId("issued-search").fill(tc.certificate_number);
  const row = page.getByTestId(`certificate-${tc.certificate_number}`);
  await expect(row.getByTestId("certificate-status")).toHaveText("Valid");
  await row.getByTestId("revoke-certificate").click();
  await page.getByTestId("revoke-reason").fill("Wrong date of leaving");
  await page.getByTestId("confirm-revoke").click();
  await expect(row.getByTestId("certificate-status")).toHaveText("Revoked");

  const visitor = await (await browser.newContext()).newPage();   // no login
  await visitor.goto(new URL(tc.verify_url).pathname);
  await expect(visitor.getByTestId("verify-status")).toHaveText("Revoked");
  await visitor.goto(new URL(bc.verify_url).pathname);
  await expect(visitor.getByTestId("verify-status")).toHaveText("Genuine and valid");
  await expect(visitor.getByTestId("verify-name")).toHaveText(boy);
  await expect(visitor.getByTestId("verify-result")).not.toContainText("Rakesh");             // no parent, date of birth or address
  await expect(visitor.getByTestId("verify-result")).not.toContainText("2015");
  await visitor.goto("/verify/0123456789abcdef0123456789abcdef");
  await expect(visitor.getByTestId("verify-result")).toContainText("Not found");
});

test("ID cards: print for a class, reprint keeps the card, a new card replaces the old one", async ({ browser }) => {
  const page = await asUser(browser, "ADMIN_A");
  await page.goto("/id-cards");
  await page.getByTestId("cards-section").selectOption({ label: `${cls} – A` });
  await expect(page.getByTestId(`person-${girl}`)).toContainText("No card");
  await expect(page.getByTestId(`person-${boy}`)).toHaveCount(0);                       // he has left
  await page.getByTestId("select-all").check();
  await page.getByTestId("print-cards").click();
  await expect(page.getByTestId("cards-replace")).toHaveCount(0);                        // nobody has a card yet
  expect(await downloadPdf(page, () => page.getByTestId("cards-download").click())).toMatch(/^id-cards-student-\d{4}-\d{2}-\d{2}\.pdf$/);
  await expect(page.getByTestId(`person-${girl}`).getByTestId("person-card")).toContainText("Card ");

  const a = await admin();
  const first = (await a.get(`/id-cards?kind=student&q=${encodeURIComponent(girl)}`)).items;
  expect(first).toHaveLength(1);
  // reprint: same card
  await page.getByTestId(`person-${girl}`).locator("input[type=checkbox]").check();
  await page.getByTestId("print-cards").click();
  await downloadPdf(page, () => page.getByTestId("cards-download").click());
  expect((await a.get(`/id-cards?kind=student&q=${encodeURIComponent(girl)}`)).items).toHaveLength(1);
  // issue a new card: the old one is replaced
  await page.getByTestId(`person-${girl}`).locator("input[type=checkbox]").check();
  await page.getByTestId("print-cards").click();
  await page.getByTestId("cards-replace").check();
  await downloadPdf(page, () => page.getByTestId("cards-download").click());
  const both = (await a.get(`/id-cards?kind=student&q=${encodeURIComponent(girl)}`)).items;
  expect(both.map((c: { status: string }) => c.status).sort()).toEqual(["active", "replaced"]);

  await page.getByTestId("idcards-tab-issued-cards").click();
  await expect(page.getByTestId("card-list")).toContainText(girl);
  await page.getByTestId("cards-status").selectOption("replaced");
  await expect(page.getByTestId("card-list")).toContainText(girl);
});

test("staff cards cover non-teaching staff; teacher cards teaching staff", async ({ browser }) => {
  const page = await asUser(browser, "ADMIN_A");
  await page.goto("/id-cards?tab=Staff");
  await expect(page.getByTestId(`person-${staffName}`)).toContainText("Office Assistant");
  await expect(page.getByTestId("people-list")).not.toContainText("E2E Teacher A");
  await page.getByTestId(`person-${staffName}`).locator("input[type=checkbox]").check();
  await page.getByTestId("print-cards").click();
  await downloadPdf(page, () => page.getByTestId("cards-download").click());
  await page.getByTestId("idcards-tab-teachers").click();
  await expect(page.getByTestId("people-list")).toContainText("E2E Teacher A");
  await expect(page.getByTestId("people-list")).not.toContainText(staffName);
});

test("only school admins reach certificates and ID cards; other schools see nothing", async () => {
  for (const who of ["ACCOUNTANT_A", "TEACHER_A", "PARENT_A"] as const) {
    const t = await accessToken(who);
    expect((await api("/certificates", t, { school: SCHOOL_A() })).status, who).toBe(403);
    expect((await api("/id-cards/people?kind=student", t, { school: SCHOOL_A() })).status, who).toBe(403);
  }
  const a = await admin();
  const cert = (await a.get(`/certificates?student_id=${girlId}`)).items[0];
  const tb = await accessToken("ADMIN_B");
  expect((await api(`/certificates/${cert.id}`, tb, { school: SCHOOL_B() })).status).toBe(404);
  expect((await api(`/certificates/${cert.id}/certificate.pdf`, tb, { school: SCHOOL_B() })).status).toBe(404);
  expect((await api("/id-cards/print", tb, { method: "POST", school: SCHOOL_B(), body: { kind: "student", ids: [girlId] } })).status).toBe(409);
});
