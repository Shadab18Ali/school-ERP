import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { accessToken, api, assignTeacher, email, minimalPdf, png, runTag, SCHOOL_A, SCHOOL_B, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });
const tag = runTag();
const [H, G] = [`H${tag}`, `G${tag}`]; // Class 6 sections: TEACHER_A teaches H only
const kid = `Hw Kid ${tag}`;   // STUDENT_A's record; PARENT_A's child
const mate = `Hw Mate ${tag}`; // classmate in H
const other = `Hw Other ${tag}`; // in G
const title = `Fractions ${tag}`;
const ids: Record<string, string> = {};
const sec: Record<string, string> = {};
let hwId = "";
let otherHw = "";

test.beforeAll(async () => {
  const t = await accessToken("ADMIN_A");
  const post = (path: string, body?: unknown) => api(path, t, { method: "POST", school: SCHOOL_A(), body });
  const sessions: { id: string; is_current: boolean }[] = await (await api("/sessions", t, { school: SCHOOL_A() })).json();
  const current = sessions.find((s) => s.is_current)!.id;
  await post("/classes/bulk", { classes: [{ name: "Class 6", display_order: 9 }] });
  const cls = (await (await api(`/classes?session_id=${current}`, t, { school: SCHOOL_A() })).json()).items.find((c: { name: string }) => c.name === "Class 6").id;
  await post("/sections/bulk", { academic_session_id: current, class_ids: [cls], names: [H, G] });
  for (const s of (await (await api(`/sections?session_id=${current}&class_id=${cls}`, t, { school: SCHOOL_A() })).json()).items) sec[s.name] = s.id;
  await assignTeacher(sec[H], { subject: "Mathematics" });
  await post("/timetable/subjects/common");
  for (const [i, [n, s]] of ([[kid, H], [mate, H], [other, G]] as const).entries()) {
    const st = await (await post("/students", { full_name: n, father_name: "Father", date_of_birth: "2015-05-05", gender: "female", mobile: `93333000${i}${i}`,
      enrollment: { academic_session_id: current, class_id: cls, section_id: sec[s], admission_number: `${tag}-H${i}`, admission_date: "2026-04-01" } })).json();
    ids[n] = st.id;
  }
  expect((await api(`/students/${ids[kid]}/login`, t, { method: "PUT", school: SCHOOL_A(), body: { email: email("STUDENT_A") } })).status).toBe(200);
  expect((await post(`/students/${ids[kid]}/guardians`, { email: email("PARENT_A"), full_name: "E2E Parent A", relationship: "mother" })).status).toBe(201);
  // homework for the other section, set by the admin (TEACHER_A doesn't teach G)
  const due = new Date(Date.now() + 3 * 86400000).toISOString();
  otherHw = (await (await post("/homework", { section_id: sec[G], title: `G only ${tag}`, due_at: due })).json()).id;
});

test.afterAll(async () => {
  const t = await accessToken("ADMIN_A");
  await api(`/students/${ids[kid]}/login`, t, { method: "DELETE", school: SCHOOL_A() });
  for (const l of await (await api(`/students/${ids[kid]}/guardians`, t, { school: SCHOOL_A() })).json())
    await api(`/students/${ids[kid]}/guardians/${l.id}`, t, { method: "DELETE", school: SCHOOL_A() });
});

test("a teacher sets homework with a file, only for their own class", async ({ page }) => {
  await signIn(page, "TEACHER_A", "/homework");
  await expect(page.getByRole("heading", { level: 1, name: "Homework" })).toBeVisible();
  await page.getByTestId("new-homework").click();
  const d = page.getByRole("dialog");
  await expect(d.getByLabel("Class").locator("option", { hasText: `Class 6 – ${H}` })).toHaveCount(1);
  const classes = await d.getByLabel("Class").locator("option").allTextContents();
  expect(classes).toContain(`Class 6 – ${H}`);
  expect(classes).not.toContain(`Class 6 – ${G}`); // not assigned to them
  await d.getByTestId("save-homework").click();
  await expect(d.getByText("Choose a class.")).toBeVisible();
  await d.getByLabel("Class").selectOption({ label: `Class 6 – ${H}` });
  await expect(d.getByLabel("Subject")).toHaveValue(/.+/); // their subject in that class is picked for them
  await expect(d.getByLabel("Subject").locator("option:checked")).toHaveText("Mathematics");
  await d.getByLabel(/^Title/).fill(title);
  await d.getByLabel("Description").fill("Solve questions 1 to 10 from page 42.\nShow your working.");
  await d.getByLabel(/^Deadline/).fill("2020-01-01T10:00");
  await d.getByTestId("save-homework").click();
  await expect(d.getByText("The deadline must be in the future.")).toBeVisible();
  const due = new Date(Date.now() + 2 * 86400000);
  const pad = (n: number) => String(n).padStart(2, "0");
  await d.getByLabel(/^Deadline/).fill(`${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}T17:00`);
  await d.getByLabel("Maximum marks").fill("20");
  await d.getByLabel("Files for students").setInputFiles({ name: "worksheet.pdf", mimeType: "application/pdf", buffer: minimalPdf() });
  await d.getByTestId("save-homework").click();
  await expect(page).toHaveURL(/\/homework\/[0-9a-f-]{36}$/);
  hwId = page.url().split("/").pop()!;
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.getByTestId("homework-meta")).toContainText(`Class 6 – ${H} · Mathematics · set by E2E Teacher A · out of 20`);
  await expect(page.getByTestId("attachments")).toContainText("worksheet.pdf");
  await expect(page.getByTestId("submission-summary")).toContainText("0 of 2 submitted");
  await expect(page.getByTestId(`roster-${tag}-H0`).getByTestId("roster-status")).toHaveText("Not submitted");

  // an assignment from the class page
  await page.goto(`/teaching/${sec[H]}`);
  await page.getByRole("tab", { name: "Assignments", exact: true }).click();
  await page.getByTestId("new-homework").click();
  await expect(d.getByLabel("Type")).toHaveValue("assignment");
  await d.getByLabel(/^Title/).fill(`Project ${tag}`);
  await d.getByTestId("save-homework").click();
  await expect(page.getByRole("heading", { level: 1, name: `Project ${tag}` })).toBeVisible();
  await page.goto(`/teaching/${sec[H]}`);
  await page.getByRole("tab", { name: "Homework", exact: true }).click();
  await expect(page.getByTestId(`homework-row-${title}`)).toBeVisible();
  await expect(page.getByTestId(`homework-row-Project ${tag}`)).toHaveCount(0); // assignments have their own tab
});

test("the student downloads the file and submits work", async ({ page }) => {
  await signIn(page, "STUDENT_A", "/my");
  await page.getByRole("tab", { name: "Homework", exact: true }).click();
  const row = page.getByTestId(`my-homework-${title}`);
  await expect(row.getByTestId("homework-status")).toHaveText("To do");
  await expect(page.getByTestId("student-homework")).not.toContainText(`G only ${tag}`); // another class's homework
  await row.click();
  await expect(page.getByTestId("homework-description")).toContainText("Show your working.");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download worksheet.pdf" }).click()]);
  expect(readFileSync((await dl.path())!).subarray(0, 5).toString()).toBe("%PDF-");

  await page.getByTestId("submit-homework").click();
  await expect(page.getByTestId("submit-error")).toHaveText("Write an answer or attach at least one file.");
  await page.getByLabel("Answer").fill("Q1: 3/4\nQ2: 5/8");
  await page.getByLabel("Attach files").setInputFiles([{ name: "page1.png", mimeType: "image/png", buffer: png(400, 300) }]);
  await page.getByTestId("submit-homework").click();
  await expect(page.getByText("Submitted. Your teacher can see it now.")).toBeVisible();
  await expect(page.getByTestId("homework-status")).toHaveText("Submitted");
  await expect(page.getByTestId("my-files")).toContainText("page1.png");

  // add a second page, remove the first, still allowed before review
  await page.getByLabel("Attach files").setInputFiles([{ name: "page2.png", mimeType: "image/png", buffer: png(400, 300) }]);
  await page.getByTestId("submit-homework").click();
  await expect(page.getByTestId("my-files")).toContainText("page2.png");
  await page.getByRole("button", { name: "Remove page1.png" }).click();
  await expect(page.getByTestId("file-page1.png")).toHaveCount(0);
  // a disguised program is refused
  await page.getByLabel("Attach files").setInputFiles([{ name: "answers.pdf", mimeType: "application/pdf", buffer: Buffer.from("MZ".repeat(300)) }]);
  await page.getByTestId("submit-homework").click();
  await expect(page.getByTestId("submit-error")).toContainText("answers.pdf: Upload a PDF, photo");

  await page.getByRole("main").getByRole("link", { name: "My school record" }).click();
  await expect(page.getByTestId(`my-homework-${title}`).getByTestId("homework-status")).toHaveText("Submitted");
});

test("the teacher reviews: marks within the maximum, feedback", async ({ page }) => {
  await signIn(page, "TEACHER_A", `/homework/${hwId}`);
  await expect(page.getByTestId("submission-summary")).toContainText("1 of 2 submitted · 0 reviewed · 1 not submitted");
  const row = page.getByTestId(`roster-${tag}-H0`);
  await expect(row.getByTestId("roster-status")).toHaveText("Submitted");
  await row.getByRole("button", { name: "Review" }).click();
  const d = page.getByRole("dialog");
  await expect(d.getByTestId("submission-answer")).toContainText("Q2: 5/8");
  await expect(d.getByTestId("submission-files")).toContainText("page2.png");
  const [dl] = await Promise.all([page.waitForEvent("download"), d.getByRole("button", { name: "Download page2.png" }).click()]);
  expect(readFileSync((await dl.path())!).subarray(1, 4).toString()).toBe("PNG");
  await d.getByLabel(/Marks/).fill("25");
  await d.getByTestId("save-review").click();
  await expect(d.getByTestId("review-error")).toHaveText("Marks must be between 0 and 20.");
  await d.getByLabel(/Marks/).fill("17.5");
  await d.getByLabel("Feedback").fill("Good work. Recheck Q4.");
  await d.getByTestId("save-review").click();
  await expect(page.getByText("Review saved.")).toBeVisible();
  await expect(row.getByTestId("roster-status")).toHaveText("Reviewed");
  await expect(row.getByTestId("roster-marks")).toHaveText("17.5");
  // work has been submitted, so the homework can't be deleted
  await expect(page.getByRole("button", { name: "Delete" })).toBeDisabled();

  // admin-set homework in G: not this teacher's
  const t = await accessToken("TEACHER_A");
  expect((await api(`/homework/${otherHw}`, t, { school: SCHOOL_A() })).status).toBe(404);
  const due = new Date(Date.now() + 86400000).toISOString();
  expect((await api("/homework", t, { method: "POST", school: SCHOOL_A(), body: { section_id: sec[G], title: "Not mine", due_at: due } })).status).toBe(404);
});

test("the student and parent see marks and feedback; reviewed work is locked", async ({ page }) => {
  await signIn(page, "STUDENT_A", `/my/homework/${hwId}`);
  await expect(page.getByTestId("homework-status")).toHaveText("Reviewed");
  await expect(page.getByTestId("review-marks")).toContainText("17.5 / 20");
  await expect(page.getByTestId("review-feedback")).toHaveText("Good work. Recheck Q4.");
  await expect(page.getByTestId("submit-homework")).toHaveCount(0);
  const st = await accessToken("STUDENT_A");
  const again = await api(`/my/homework/${hwId}/submission`, st, { method: "POST", school: SCHOOL_A(), body: undefined });
  expect([409, 422]).toContain(again.status);
  expect((await api(`/my/homework/${otherHw}`, st, { school: SCHOOL_A() })).status).toBe(404);
  expect((await api("/homework", st, { school: SCHOOL_A() })).status).toBe(403);

  const parentPage = await page.context().browser()!.newPage();
  try {
    await signIn(parentPage, "PARENT_A", `/portal/${ids[kid]}`);
    await parentPage.getByRole("tab", { name: "Homework" }).click();
    const row = parentPage.getByTestId(`my-homework-${title}`);
    await expect(row.getByTestId("homework-status")).toHaveText("Reviewed");
    await expect(row).toContainText("17.5/20");
    await expect(parentPage.getByTestId(`my-homework-Project ${tag}`).getByTestId("homework-status")).toHaveText("To do");
    await row.click();
    await expect(parentPage.getByTestId("review-feedback")).toHaveText("Good work. Recheck Q4.");
    await expect(parentPage.getByTestId("submission-answer")).toContainText("Q1: 3/4");
    await expect(parentPage.getByTestId("submit-homework")).toHaveCount(0); // parents can't submit
    const [dl] = await Promise.all([parentPage.waitForEvent("download"), parentPage.getByRole("button", { name: "Download worksheet.pdf" }).click()]);
    expect(readFileSync((await dl.path())!).subarray(0, 5).toString()).toBe("%PDF-");
  } finally { await parentPage.close(); }

  const [parent, acct, adminB] = await Promise.all([accessToken("PARENT_A"), accessToken("ACCOUNTANT_A"), accessToken("ADMIN_B")]);
  expect((await api(`/portal/children/${ids[mate]}/homework`, parent, { school: SCHOOL_A() })).status).toBe(404); // not their child
  expect((await api(`/my/homework/${hwId}/submission`, parent, { method: "POST", school: SCHOOL_A() })).status).toBe(403);
  expect((await api("/homework", acct, { school: SCHOOL_A() })).status).toBe(403);
  expect((await api(`/homework/${hwId}`, adminB, { school: SCHOOL_B() })).status).toBe(404);
});

test("admins see every class's homework and can delete unsubmitted work", async ({ page }) => {
  await signIn(page, "ADMIN_A", "/homework");
  await page.getByLabel("Search homework").fill(tag);
  await expect(page.getByTestId(`homework-row-${title}`).getByTestId("homework-counts")).toContainText("1/2 submitted");
  await expect(page.getByTestId(`homework-row-G only ${tag}`)).toBeVisible();
  await page.getByTestId(`homework-row-G only ${tag}`).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/homework$/);
  await page.getByLabel("Search homework").fill(tag);
  await expect(page.getByTestId(`homework-row-${title}`)).toBeVisible();
  await expect(page.getByTestId(`homework-row-G only ${tag}`)).toHaveCount(0);
});
