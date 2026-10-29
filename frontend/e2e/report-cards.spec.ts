import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { accessToken, api, assignTeacher, email, png, runTag, SCHOOL_A, SCHOOL_B, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });
const tag = runTag();
const cls = `RC Class ${tag}`;
const kid = `Rc Kid ${tag}`;   // STUDENT_A's record; PARENT_A's child
const mate = `Rc Mate ${tag}`;
const tpl = `Blue ${tag}`;
const ids: Record<string, string> = {};
let section = "";
let examId = "";

async function pdfFrom(page: import("@playwright/test").Page, click: () => Promise<void>) {
  const [dl] = await Promise.all([page.waitForEvent("download"), click()]);
  return readFileSync((await dl.path())!);
}

test.beforeAll(async () => {
  const t = await accessToken("ADMIN_A");
  const post = (path: string, body?: unknown) => api(path, t, { method: "POST", school: SCHOOL_A(), body });
  const sessions: { id: string; is_current: boolean; start_date: string }[] = await (await api("/sessions", t, { school: SCHOOL_A() })).json();
  const cur = sessions.find((s) => s.is_current)!;
  await post("/classes/bulk", { classes: [{ name: cls, display_order: 31 }] });
  const classId = (await (await api(`/classes?session_id=${cur.id}`, t, { school: SCHOOL_A() })).json()).items.find((c: { name: string }) => c.name === cls).id;
  await post("/sections/bulk", { academic_session_id: cur.id, class_ids: [classId], names: ["A"] });
  section = (await (await api(`/sections?session_id=${cur.id}&class_id=${classId}`, t, { school: SCHOOL_A() })).json()).items[0].id;
  await assignTeacher(section, { classTeacher: true });
  for (const [i, n] of [kid, mate].entries()) {
    const st = await (await post("/students", { full_name: n, father_name: "Father Name", mother_name: "Mother Name", date_of_birth: "2015-08-08", gender: "female",
      mobile: `91111000${i}${i}`, enrollment: { academic_session_id: cur.id, class_id: classId, section_id: section, admission_number: `${tag}-R${i}`, admission_date: cur.start_date } })).json();
    ids[n] = st.id;
  }
  expect((await api(`/students/${ids[kid]}/login`, t, { method: "PUT", school: SCHOOL_A(), body: { email: email("STUDENT_A") } })).status).toBe(200);
  expect((await post(`/students/${ids[kid]}/guardians`, { email: email("PARENT_A"), full_name: "E2E Parent A", relationship: "mother" })).status).toBe(201);

  // an exam with marks for both students
  const subs = await (await post("/timetable/subjects/common")).json();
  const maths = subs.find((s: { name: string }) => s.name === "Mathematics").id;
  const setup = await (await post("/exams/types/standard")).json();
  await post("/exams/grades/standard");
  const annual = setup.types.find((x: { name: string }) => x.name === "Annual").id;
  const d = new Date(`${cur.start_date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 200);
  examId = (await (await post("/exams", { exam_type_id: annual, name: `Annual ${tag}` })).json()).id;
  const x = await (await post(`/exams/${examId}/papers`, { class_ids: [classId], subject_id: maths, exam_date: d.toISOString().slice(0, 10),
    start_time: "09:00", end_time: "12:00", max_marks: "100", pass_marks: "33" })).json();
  await post(`/exams/${examId}/status`, { status: "scheduled" });
  const paper = x.papers[0].id;
  const sheet = await (await api(`/exams/${examId}/papers/${paper}/marks?section_id=${section}`, t, { school: SCHOOL_A() })).json();
  const res = await api(`/exams/${examId}/papers/${paper}/marks`, t, { method: "PUT", school: SCHOOL_A(), body: { section_id: section,
    entries: sheet.students.map((s: { enrollment_id: string; full_name: string }) => ({ enrollment_id: s.enrollment_id, marks: s.full_name === kid ? "88" : "64" })) } });
  expect(res.status).toBe(200);
});

test.afterAll(async () => {
  const t = await accessToken("ADMIN_A");
  await api(`/students/${ids[kid]}/login`, t, { method: "DELETE", school: SCHOOL_A() });
  for (const l of await (await api(`/students/${ids[kid]}/guardians`, t, { school: SCHOOL_A() })).json())
    await api(`/students/${ids[kid]}/guardians/${l.id}`, t, { method: "DELETE", school: SCHOOL_A() });
});

test("admins design a template: layout, colour, sections, signatures; preview and default", async ({ page }) => {
  await signIn(page, "ADMIN_A", "/report-cards");
  await expect(page.getByRole("heading", { level: 1, name: "Report cards" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Standard|Blue/ }).first()).toBeVisible();
  await page.getByTestId("new-template").click();
  await page.getByRole("dialog").getByLabel("Name").fill(tpl);
  await page.getByTestId("create-template").click();
  await expect(page.getByRole("tab", { name: tpl })).toHaveAttribute("aria-selected", "true");

  const ed = page.getByTestId("template-editor");
  await ed.getByLabel("Title on the card").fill("Progress Report");
  await ed.getByText("Modern", { exact: true }).click();
  await ed.getByRole("button", { name: "Colour #1d4ed8" }).click();
  await ed.getByLabel("Rank in section").uncheck();
  await ed.getByLabel("Signature 3").fill("");
  await ed.getByLabel("Principal's name").fill("Dr. A. Sharma");
  await ed.getByLabel("Footer note").fill("This is a computer-generated report card.");
  await ed.getByLabel("Colour code").fill("blue");
  await page.getByTestId("save-template").click();
  await expect(page.getByTestId("template-error")).toHaveText("Choose a colour like #2f6b57.");
  await ed.getByLabel("Colour code").fill("#1d4ed8");
  await page.getByTestId("save-template").click();
  await expect(page.getByText("Template saved.")).toBeVisible();
  await ed.getByTestId("signature-input").setInputFiles({ name: "sign.png", mimeType: "image/png", buffer: png(400, 120) });
  await expect(page.getByTestId("signature-image")).toBeVisible();
  const preview = await pdfFrom(page, () => page.getByTestId("download-preview").click());
  expect(preview.subarray(0, 5).toString()).toBe("%PDF-");

  await page.getByTestId("make-default").click();
  await expect(page.getByTestId("is-default")).toBeVisible();
  // the saved settings come back from the server
  await page.reload();
  await page.getByRole("tab", { name: tpl }).click();
  await expect(ed.getByLabel("Title on the card")).toHaveValue("Progress Report");
  await expect(ed.getByLabel("Rank in section")).not.toBeChecked();
  await expect(ed.getByLabel("Signature 3")).toHaveValue("");

  const t = await accessToken("ADMIN_A");
  const list = await (await api("/report-cards/templates", t, { school: SCHOOL_A() })).json();
  const mine = list.find((x: { name: string }) => x.name === tpl);
  expect(mine).toMatchObject({ layout: "modern", accent_color: "#1d4ed8", show_rank: false, signature_3: null, has_signature: true, is_default: true });
  expect((await api(`/report-cards/templates/${mine.id}`, t, { method: "DELETE", school: SCHOOL_A() })).status).toBe(409); // the default
  const [teacher, adminB] = await Promise.all([accessToken("TEACHER_A"), accessToken("ADMIN_B")]);
  expect((await api("/report-cards/templates", teacher, { school: SCHOOL_A() })).status).toBe(403);
  expect((await api(`/report-cards/templates/${mine.id}`, adminB, { school: SCHOOL_B() })).status).toBe(404);
});

test("teachers write the class teacher's remarks; only admins write the principal's", async ({ page }) => {
  await signIn(page, "TEACHER_A", `/exams/${examId}?tab=report-cards&section=${section}`);
  await expect(page.getByRole("tab", { name: "Report cards" })).toHaveAttribute("aria-selected", "true");
  const row = page.getByTestId(`remarks-row-${tag}-R0`);
  await expect(row.getByRole("textbox", { name: /Principal's remarks/ })).toBeDisabled();
  await row.getByRole("textbox", { name: /Class teacher's remarks/ }).fill("Regular, attentive and helpful to classmates.");
  await page.getByTestId("save-remarks").click();
  await expect(page.getByText("Remarks saved for 1 student.")).toBeVisible();
  const card = await pdfFrom(page, () => row.getByTestId(`card-${tag}-R0`).click());
  expect(card.subarray(0, 5).toString()).toBe("%PDF-");

  const t = await accessToken("TEACHER_A");
  const sheet = await (await api(`/exams/${examId}/remarks?section_id=${section}`, t, { school: SCHOOL_A() })).json();
  const r = await api(`/exams/${examId}/remarks`, t, { method: "PUT", school: SCHOOL_A(), body: { section_id: section,
    entries: [{ enrollment_id: sheet.students[0].enrollment_id, principal_remarks: "Promoted" }] } });
  expect(r.status).toBe(403);
});

test("admins add principal's remarks, choose the template and print cards; remarks lock on publication", async ({ page }) => {
  await signIn(page, "ADMIN_A", `/exams/${examId}?tab=report-cards&section=${section}`);
  await page.getByLabel("Report card template").selectOption({ label: "Standard" });
  await expect(page.getByText("Template chosen for this exam.")).toBeVisible();
  const admin = await accessToken("ADMIN_A");
  const std = (await (await api("/report-cards/templates", admin, { school: SCHOOL_A() })).json()).find((x: { name: string }) => x.name === "Standard");
  expect((await (await api(`/exams/${examId}`, admin, { school: SCHOOL_A() })).json()).report_card_template_id).toBe(std.id);
  await page.getByLabel("Report card template").selectOption({ label: `Default (${tpl})` });
  await expect.poll(async () => (await (await api(`/exams/${examId}`, admin, { school: SCHOOL_A() })).json()).report_card_template_id).toBeNull();
  const row = page.getByTestId(`remarks-row-${tag}-R0`);
  await expect(row.getByRole("textbox", { name: /Class teacher's remarks/ })).toHaveValue("Regular, attentive and helpful to classmates.");
  await row.getByRole("textbox", { name: /Principal's remarks/ }).fill("Promoted to the next class. Well done!");
  await page.getByTestId("save-remarks").click();
  await expect(page.getByText("Remarks saved for 1 student.")).toBeVisible();
  const all = await pdfFrom(page, () => page.getByTestId("all-report-cards").click());
  expect(all.subarray(0, 5).toString()).toBe("%PDF-");
  expect((all.toString("latin1").match(/\/Type \/Page[^s]/g) ?? []).length).toBe(2); // one page per student

  await page.getByRole("tab", { name: "Date sheet" }).click();
  await page.getByTestId("publish-results").click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish results" }).click();
  await expect(page.getByTestId("exam-status")).toHaveText("Results published");
  await page.getByRole("tab", { name: "Report cards" }).click();
  await expect(page.getByTestId("remarks-locked")).toContainText("remarks are locked");
});

test("students and parents see the remarks and download their own report card", async ({ page }) => {
  await signIn(page, "STUDENT_A", "/my");
  await page.getByRole("tab", { name: "Results", exact: true }).click();
  const card = page.getByTestId(`exam-result-Annual ${tag}`);
  await expect(card.getByTestId("teacher-remarks")).toHaveText("Regular, attentive and helpful to classmates.");
  await expect(card.getByTestId("principal-remarks")).toHaveText("Promoted to the next class. Well done!");
  const pdf = await pdfFrom(page, () => card.getByTestId("download-report-card").click());
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");

  const parent = await accessToken("PARENT_A");
  expect((await api(`/portal/children/${ids[kid]}/exams/${examId}/report-card.pdf`, parent, { school: SCHOOL_A() })).status).toBe(200);
  expect((await api(`/portal/children/${ids[mate]}/exams/${examId}/report-card.pdf`, parent, { school: SCHOOL_A() })).status).toBe(404);
  const st = await accessToken("STUDENT_A");
  expect((await api(`/exams/${examId}/results/report-cards.pdf?section_id=${section}`, st, { school: SCHOOL_A() })).status).toBe(403);
});
