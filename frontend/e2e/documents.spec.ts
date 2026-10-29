import { expect, test } from "@playwright/test";
import { accessToken, api, API_URL, minimalPdf, png, runTag, SCHOOL_A, SCHOOL_B, signIn, assignTeacherForStudent } from "./helpers";

test.describe.configure({ mode: "serial" });

const tag = runTag();
let studentId = "";
const today = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date());

test.beforeAll(async () => {
  const t = await accessToken("ADMIN_A");
  const sessions: { id: string; is_current: boolean }[] = await (await api("/sessions", t, { school: SCHOOL_A() })).json();
  const current = sessions.find((s) => s.is_current)!.id;
  await api("/classes/bulk", t, { method: "POST", school: SCHOOL_A(), body: { classes: [{ name: "Class 1", display_order: 4 }] } });
  const classes = (await (await api(`/classes?session_id=${current}`, t, { school: SCHOOL_A() })).json()).items;
  const class1 = classes.find((c: { name: string }) => c.name === "Class 1").id;
  await api("/sections/bulk", t, { method: "POST", school: SCHOOL_A(), body: { academic_session_id: current, class_ids: [class1], names: ["A"] } });
  const sec = (await (await api(`/sections?session_id=${current}&class_id=${class1}`, t, { school: SCHOOL_A() })).json()).items
    .find((s: { name: string }) => s.name === "A").id;
  const res = await api("/students", t, {
    method: "POST", school: SCHOOL_A(),
    body: {
      full_name: `Doc Student ${tag}`, father_name: "Parent", date_of_birth: "2019-03-03", gender: "female", mobile: "9811100000",
      enrollment: { academic_session_id: current, class_id: class1, section_id: sec, admission_number: `${tag}-DOC`, admission_date: "2026-04-01" },
    },
  });
  studentId = (await res.json()).id;
});

test.describe("student documents (admin)", () => {
  test("upload a PDF and an image; see type, date and checklist", async ({ page }) => {
    await signIn(page, "ADMIN_A", `/students/${studentId}`);
    await page.getByRole("tab", { name: "Documents" }).click();
    await expect(page.getByText("No documents yet")).toBeVisible();

    await page.getByLabel("Document type").selectOption("birth_certificate");
    await page.getByTestId("document-input").setInputFiles({ name: "Birth Certificate.pdf", mimeType: "application/pdf", buffer: minimalPdf() });
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(page.getByText("Birth certificate uploaded.")).toBeVisible();

    await page.getByLabel("Document type").selectOption("transfer_certificate");
    await page.getByTestId("document-input").setInputFiles({ name: "tc-scan.png", mimeType: "image/png", buffer: png(300, 400) });
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(page.getByText("Transfer certificate uploaded.")).toBeVisible();

    const pdfRow = page.getByTestId("document-Birth Certificate.pdf");
    await expect(pdfRow).toContainText("Birth certificate");
    await expect(pdfRow.getByTestId("uploaded-on")).toContainText(`Uploaded ${today}`);
    await expect(page.getByTestId("document-tc-scan.png")).toContainText("Transfer certificate");
    const checklist = page.getByTestId("document-checklist");
    await expect(checklist.getByRole("listitem").filter({ hasText: "Birth certificate" }).getByLabel("Uploaded")).toBeVisible();
    await expect(checklist.getByRole("listitem").filter({ hasText: "Address proof" }).getByLabel("Missing")).toBeVisible();
  });

  test("preview images and PDFs without exposing any storage URL", async ({ page }) => {
    const storageRequests: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/storage/v1/")) storageRequests.push(r.url()); });
    await signIn(page, "ADMIN_A", `/students/${studentId}`);
    await page.getByRole("tab", { name: "Documents" }).click();

    await page.getByRole("button", { name: "Preview Transfer certificate" }).click();
    const img = page.getByTestId("preview-image");
    await expect(img).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(300);
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).last().click();

    await page.getByRole("button", { name: "Preview Birth certificate" }).click();
    await expect(page.getByTestId("preview-pdf")).toHaveAttribute("data", /^blob:/);
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).last().click();

    expect(storageRequests, "the browser must never talk to Storage directly").toEqual([]);
  });

  test("download keeps the original file name and exact bytes", async ({ page }) => {
    await signIn(page, "ADMIN_A", `/students/${studentId}`);
    await page.getByRole("tab", { name: "Documents" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download Birth certificate" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("Birth Certificate.pdf");
    const path = await download.path();
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(path!).equals(minimalPdf())).toBe(true);
  });

  test("upload validation", async ({ page }) => {
    await signIn(page, "ADMIN_A", `/students/${studentId}`);
    await page.getByRole("tab", { name: "Documents" }).click();

    await page.getByLabel("Document type").selectOption("other");
    await page.getByTestId("document-input").setInputFiles({ name: "misc.pdf", mimeType: "application/pdf", buffer: minimalPdf() });
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(page.getByTestId("upload-error")).toHaveText("Describe the document (e.g. Medical certificate).");

    // a program renamed to .pdf is caught by the server, which reads the bytes
    await page.getByLabel(/^Description/).fill("Suspicious file");
    await page.getByTestId("document-input").setInputFiles({ name: "invoice.pdf", mimeType: "application/pdf", buffer: Buffer.from("MZ\x90\x00 not a pdf") });
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(page.getByTestId("upload-error")).toHaveText("Upload a PDF, JPEG, PNG or WebP file.");

    await page.getByTestId("document-input").setInputFiles({ name: "huge.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(11 * 1024 * 1024, 1) });
    await expect(page.getByTestId("upload-error")).toHaveText("Documents must be 10 MB or smaller.");

    await page.getByTestId("document-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await expect(page.getByTestId("upload-error")).toHaveText("Upload a PDF, JPEG, PNG or WebP file.");
  });

  test("edit details, then delete", async ({ page }) => {
    await signIn(page, "ADMIN_A", `/students/${studentId}`);
    await page.getByRole("tab", { name: "Documents" }).click();
    await page.getByRole("button", { name: "More actions for Transfer certificate" }).click();
    await page.getByRole("menuitem", { name: "Edit details" }).click();
    await page.getByRole("dialog").getByLabel("Document type").selectOption("other");
    await page.getByRole("dialog").getByLabel(/^Description/).fill("School leaving certificate");
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("document-tc-scan.png")).toContainText("School leaving certificate");

    await page.getByRole("button", { name: "More actions for School leaving certificate" }).click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete document" }).click();
    await expect(page.getByText("School leaving certificate deleted.")).toBeVisible();
    await expect(page.getByTestId("document-tc-scan.png")).toHaveCount(0);
    await expect(page.getByTestId("documents-list").getByRole("listitem")).toHaveCount(1);
  });
});

test.describe("student documents: security", () => {
  test("teachers can see the student but not the documents", async ({ page }) => {
    await assignTeacherForStudent(studentId); // a teacher of the student's class
    await signIn(page, "TEACHER_A", `/students/${studentId}`);
    await expect(page.getByRole("heading", { level: 1, name: `Doc Student ${tag}` })).toBeVisible();
    await page.getByRole("tab", { name: "Documents" }).click();
    await expect(page.getByTestId("documents-restricted")).toBeVisible();
    await expect(page.getByTestId("document-input")).toHaveCount(0);
  });

  test("API: only the right school's admins get files, privately", async () => {
    const [adminA, adminB, teacherA, accountantA] = await Promise.all(
      [accessToken("ADMIN_A"), accessToken("ADMIN_B"), accessToken("TEACHER_A"), accessToken("ACCOUNTANT_A")]);
    const list = await (await api(`/students/${studentId}/documents`, adminA, { school: SCHOOL_A() })).json();
    expect(list).toHaveLength(1);
    const doc = list[0];
    expect(Object.keys(doc).some((k) => /path|url/i.test(k)), "no storage path or URL is ever returned").toBe(false);

    const file = (token?: string, school?: string) => fetch(`${API_URL()}/api/v1/students/${studentId}/documents/${doc.id}/file`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(school ? { "X-School-Id": school } : {}) },
    });
    const ok = await file(adminA, SCHOOL_A());
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toContain("no-store");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("content-security-policy")).toContain("sandbox");

    expect((await file(undefined, SCHOOL_A())).status).toBe(401);
    expect((await file(teacherA, SCHOOL_A())).status).toBe(403);
    expect((await file(accountantA, SCHOOL_A())).status).toBe(403);
    expect((await file(adminB, SCHOOL_A())).status).toBe(403); // can't act inside School A
    expect((await api(`/students/${studentId}/documents`, adminB, { school: SCHOOL_B() })).status).toBe(404); // and A's student isn't in B
    expect((await api(`/students/${studentId}/documents/${doc.id}`, teacherA, { method: "DELETE", school: SCHOOL_A() })).status).toBe(403);

    // guessing the storage location doesn't work: the bucket is private
    const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/+$/, "");
    const guess = `${supabase}/storage/v1/object/public/student-documents/${SCHOOL_A()}/${studentId}/${doc.id.replaceAll("-", "")}.pdf`;
    expect((await fetch(guess)).status).toBeGreaterThanOrEqual(400);
  });
});
