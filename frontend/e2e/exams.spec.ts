import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { accessToken, api, assignTeacher, email, runTag, SCHOOL_A, SCHOOL_B, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });
const tag = runTag();
const cls = `Exam Class ${tag}`; // a class of its own, so other tests' students don't affect publishing
const [E, F] = ["E", "F"];       // TEACHER_A teaches E only
const kid = `Ex Kid ${tag}`;     // STUDENT_A's record; PARENT_A's child (in E)
const mate = `Ex Mate ${tag}`;   // in E
const other = `Ex Other ${tag}`; // in F
const exam = `Half Yearly ${tag}`;
const ids: Record<string, string> = {};
const sec: Record<string, string> = {};
let examId = "";
let day1 = "";
let day2 = "";

test.beforeAll(async () => {
  const t = await accessToken("ADMIN_A");
  const post = (path: string, body?: unknown) => api(path, t, { method: "POST", school: SCHOOL_A(), body });
  const sessions: { id: string; is_current: boolean; start_date: string }[] = await (await api("/sessions", t, { school: SCHOOL_A() })).json();
  const current = sessions.find((s) => s.is_current)!;
  const d = new Date(`${current.start_date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 150);
  day1 = d.toISOString().slice(0, 10);
  d.setUTCDate(d.getUTCDate() + 1);
  day2 = d.toISOString().slice(0, 10);
  await post("/classes/bulk", { classes: [{ name: cls, display_order: 30 }] });
  const classId = (await (await api(`/classes?session_id=${current.id}`, t, { school: SCHOOL_A() })).json()).items.find((c: { name: string }) => c.name === cls).id;
  ids.class = classId;
  await post("/sections/bulk", { academic_session_id: current.id, class_ids: [classId], names: [E, F] });
  for (const s of (await (await api(`/sections?session_id=${current.id}&class_id=${classId}`, t, { school: SCHOOL_A() })).json()).items) sec[s.name] = s.id;
  await assignTeacher(sec[E], { subject: "Mathematics" });
  await post("/timetable/subjects/common");
  for (const [i, [n, s]] of ([[kid, E], [mate, E], [other, F]] as const).entries()) {
    const st = await (await post("/students", { full_name: n, father_name: "Father", date_of_birth: "2014-04-04", gender: "male", mobile: `92222000${i}${i}`,
      enrollment: { academic_session_id: current.id, class_id: classId, section_id: sec[s], admission_number: `${tag}-X${i}`, admission_date: current.start_date } })).json();
    ids[n] = st.id;
  }
  expect((await api(`/students/${ids[kid]}/login`, t, { method: "PUT", school: SCHOOL_A(), body: { email: email("STUDENT_A") } })).status).toBe(200);
  expect((await post(`/students/${ids[kid]}/guardians`, { email: email("PARENT_A"), full_name: "E2E Parent A", relationship: "father" })).status).toBe(201);
});

test.afterAll(async () => {
  const t = await accessToken("ADMIN_A");
  await api(`/students/${ids[kid]}/login`, t, { method: "DELETE", school: SCHOOL_A() });
  for (const l of await (await api(`/students/${ids[kid]}/guardians`, t, { school: SCHOOL_A() })).json())
    await api(`/students/${ids[kid]}/guardians/${l.id}`, t, { method: "DELETE", school: SCHOOL_A() });
});

async function enter(page: Page, rows: Record<string, string | "absent">) {
  for (const [no, v] of Object.entries(rows)) {
    const row = page.getByTestId(`marks-row-${no}`);
    if (v === "absent") await row.getByRole("checkbox").check();
    else await row.getByRole("textbox").fill(v);
  }
}

test("setup: standard and custom exam types, grading scale", async ({ page }) => {
  await signIn(page, "ADMIN_A", "/exams");
  await page.getByRole("tab", { name: "Setup" }).click();
  await page.getByTestId("standard-types").click();
  for (const t of ["Unit Test", "Half Yearly", "Annual"]) await expect(page.getByTestId(`type-${t}`)).toBeVisible();
  await page.getByLabel("New exam type").fill(`Pre-Board ${tag}`);
  await page.getByTestId("add-type").click();
  await expect(page.getByTestId(`type-Pre-Board ${tag}`)).toBeVisible();
  await page.getByLabel("New exam type").fill("unit test");
  await page.getByTestId("add-type").click();
  await expect(page.getByText("An exam type with this name already exists.")).toBeVisible();

  await page.getByTestId("standard-grades").click();
  await expect(page.getByText("Standard scale applied.")).toBeVisible();
  const scale = page.getByTestId("grade-scale");
  await expect(scale.getByRole("textbox", { name: "Grade" })).toHaveCount(8);
  await scale.getByRole("button", { name: "Remove grade E" }).click(); // no grade from 0% left
  await page.getByTestId("save-grades").click();
  await expect(page.getByTestId("grade-error")).toContainText("One grade must start at 0%");
  await page.getByTestId("standard-grades").click();
  await expect(scale.getByRole("textbox", { name: "Grade" })).toHaveCount(8);
});

test("create an exam and its date sheet; clashes and invalid papers are refused", async ({ page }) => {
  await signIn(page, "ADMIN_A", "/exams");
  await page.getByTestId("new-exam").click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Exam type").selectOption({ label: "Half Yearly" });
  await d.getByLabel("Name").fill(exam);
  await d.getByTestId("save-exam").click();
  await expect(page.getByRole("heading", { level: 1, name: exam })).toBeVisible();
  examId = page.url().split("/").pop()!;
  await expect(page.getByTestId("exam-status")).toHaveText("Draft");
  await page.getByTestId("schedule-exam").click();
  await expect(page.getByTestId("status-error")).toHaveText("Add the date sheet (at least one paper) first.");

  const paper = async (subject: string, date: string, start: string, end: string, max: string, pass: string) => {
    await page.getByTestId("add-paper").click();
    await d.getByLabel(cls).check();
    await d.getByLabel("Subject").selectOption({ label: subject });
    await d.getByLabel("Date").fill(date);
    await d.getByLabel("Starts").fill(start);
    await d.getByLabel("Ends").fill(end);
    await d.getByLabel("Maximum marks").fill(max);
    await d.getByLabel("Passing marks").fill(pass);
    await d.getByTestId("save-paper").click();
  };
  await paper("Mathematics", day1, "09:00", "12:00", "100", "33");
  await expect(page.getByTestId(`paper-${cls}-Mathematics`)).toContainText("09:00 – 12:00");
  await paper("English", day1, "10:00", "11:00", "80", "26.5");
  await expect(d.getByTestId("paper-error")).toContainText("already has Mathematics");
  await d.getByLabel("Passing marks").fill("90");
  await d.getByTestId("save-paper").click();
  await expect(d.getByTestId("paper-error")).toHaveText("Passing marks must be between 0 and the maximum.");
  await d.getByLabel("Passing marks").fill("26.5");
  await d.getByLabel("Date").fill(day2);
  await d.getByTestId("save-paper").click();
  await expect(page.getByTestId(`paper-${cls}-English`)).toContainText("80");
  await page.getByTestId("schedule-exam").click();
  await expect(page.getByTestId("exam-status")).toHaveText("Scheduled");
});

test("a teacher enters marks for their own section only; invalid marks are refused", async ({ page }) => {
  await signIn(page, "TEACHER_A", `/teaching/${sec[E]}`);
  await page.getByRole("tab", { name: "Exams", exact: true }).click();
  await expect(page.getByTestId(`class-exam-${exam}`)).toContainText("Mathematics");
  await page.getByRole("tab", { name: "Marks", exact: true }).click();
  await page.getByTestId(`class-exam-${exam}`).getByTestId("marks-link-Mathematics").getByRole("link").click();
  await expect(page.getByRole("tab", { name: "Marks entry" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Class", { exact: true }).locator("option", { hasText: `${cls} – ${E}` })).toHaveCount(1);  // loaded
  const classes = await page.getByLabel("Class", { exact: true }).locator("option").allTextContents();
  expect(classes.some((c) => c.startsWith(`${cls} – ${E}`))).toBe(true);
  expect(classes.some((c) => c.startsWith(`${cls} – ${F}`))).toBe(false); // not their section

  await enter(page, { [`${tag}-X0`]: "105", [`${tag}-X1`]: "40" });
  await expect(page.getByTestId(`marks-row-${tag}-X0`).getByTestId("marks-problem")).toHaveText("More than 100");
  await page.getByTestId("save-marks").click();
  await expect(page.getByTestId("marks-error")).toHaveText("Fix the highlighted marks first.");
  await enter(page, { [`${tag}-X0`]: "12.345" });
  await expect(page.getByTestId(`marks-row-${tag}-X0`).getByTestId("marks-problem")).toHaveText("At most 2 decimals");
  await enter(page, { [`${tag}-X0`]: "95.5" });
  await page.getByTestId("save-marks").click();
  await expect(page.getByText("Marks saved: 2 new, 0 changed.")).toBeVisible();
  await expect(page.getByTestId("marks-progress")).toContainText("2 of 2 entered");

  await page.getByLabel("Paper").selectOption({ label: "English (out of 80)" });
  await expect(page.getByTestId("marks-progress")).toContainText("0 of 2 entered");
  await enter(page, { [`${tag}-X0`]: "absent", [`${tag}-X1`]: "70" });
  await page.getByTestId("save-marks").click();
  await expect(page.getByText("Marks saved: 2 new, 0 changed.")).toBeVisible();

  // the API refuses the other section and values above the maximum too
  const t = await accessToken("TEACHER_A");
  const x = await (await api(`/exams/${examId}`, t, { school: SCHOOL_A() })).json();
  const maths = x.papers.find((p: { subject_name: string }) => p.subject_name === "Mathematics").id;
  expect((await api(`/exams/${examId}/papers/${maths}/marks?section_id=${sec[F]}`, t, { school: SCHOOL_A() })).status).toBe(404);
  const sheet = await (await api(`/exams/${examId}/papers/${maths}/marks?section_id=${sec[E]}`, t, { school: SCHOOL_A() })).json();
  const bad = await api(`/exams/${examId}/papers/${maths}/marks`, t, { method: "PUT", school: SCHOOL_A(),
    body: { section_id: sec[E], entries: [{ enrollment_id: sheet.students[0].enrollment_id, marks: "101" }] } });
  expect(bad.status).toBe(422);
  expect((await api("/exams", t, { method: "POST", school: SCHOOL_A(), body: { exam_type_id: x.exam_type_id, name: "Mine" } })).status).toBe(403);
});

test("results are calculated; publishing needs every mark; published marks are locked", async ({ page }) => {
  await signIn(page, "ADMIN_A", `/exams/${examId}`);
  await page.getByRole("tab", { name: "Results" }).click();
  await page.getByLabel("Class", { exact: true }).selectOption({ label: `${cls} – ${E}` });
  const mateRow = page.getByTestId(`result-row-${tag}-X1`);
  const kidRow = page.getByTestId(`result-row-${tag}-X0`);
  await expect(mateRow.getByTestId("result-total")).toHaveText("110");
  await expect(mateRow.getByTestId("result-percentage")).toHaveText("61.11");
  await expect(mateRow.getByTestId("result-grade")).toHaveText("B2");
  await expect(mateRow.getByTestId("result-badge")).toHaveText("Pass");
  await expect(mateRow.getByTestId("result-rank")).toHaveText("1");
  await expect(kidRow.getByTestId("result-percentage")).toHaveText("53.06"); // 95.5 + absent(0) out of 180
  await expect(kidRow.getByTestId("result-badge")).toHaveText("Fail");       // absent in English
  await expect(kidRow.getByTestId("result-rank")).toHaveText("2");
  await expect(page.getByTestId("summary-passed")).toHaveText("1");
  const [sheet] = await Promise.all([page.waitForEvent("download"), page.getByTestId("result-sheet-pdf").click()]);
  expect(readFileSync((await sheet.path())!).subarray(0, 5).toString()).toBe("%PDF-");

  await page.getByTestId("publish-results").click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish results" }).click();
  await expect(page.getByTestId("status-error")).toContainText(`2 mark(s) are missing (for example ${other} in ${cls} – ${F}`);

  await page.getByRole("tab", { name: "Marks entry" }).click();
  await page.getByLabel("Class", { exact: true }).selectOption({ label: `${cls} – ${F} (0/2)` });
  await enter(page, { [`${tag}-X2`]: "88" });
  await page.getByTestId("save-marks").click();
  await expect(page.getByText("Marks saved: 1 new, 0 changed.")).toBeVisible();
  await page.getByLabel("Paper").selectOption({ label: "English (out of 80)" });
  await expect(page.getByTestId("marks-progress")).toContainText("0 of 1 entered");
  await enter(page, { [`${tag}-X2`]: "72" });
  await page.getByTestId("save-marks").click();
  await expect(page.getByText("Marks saved: 1 new, 0 changed.")).toBeVisible();

  await page.getByTestId("publish-results").click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish results" }).click();
  await expect(page.getByTestId("exam-status")).toHaveText("Results published");
  await expect(page.getByTestId("marks-locked")).toContainText("marks are locked");
  await expect(page.getByTestId("save-marks")).toHaveCount(0);
});

test("students and parents see their own result and report card, only once published", async ({ page }) => {
  await signIn(page, "STUDENT_A", "/my");
  await page.getByRole("tab", { name: "Exams", exact: true }).click();
  await expect(page.getByTestId(`exam-schedule-${exam}`)).toContainText("Mathematics");
  await page.getByRole("tab", { name: "Results", exact: true }).click();
  const card = page.getByTestId(`exam-result-${exam}`);
  await expect(card.getByTestId("result-percentage")).toHaveText("53.06%");
  await expect(card.getByTestId("result-rank")).toHaveText("2 of 2");
  await expect(card.getByTestId("result-badge")).toHaveText("Fail");
  await expect(card.getByTestId("subject-English").getByTestId("subject-marks")).toHaveText("Absent");
  const [rc] = await Promise.all([page.waitForEvent("download"), card.getByTestId("download-report-card").click()]);
  expect(readFileSync((await rc.path())!).subarray(0, 5).toString()).toBe("%PDF-");
  await expect(card).not.toContainText(mate); // nobody else's marks

  const parentPage = await page.context().browser()!.newPage();
  try {
    await signIn(parentPage, "PARENT_A", `/portal/${ids[kid]}`);
    await parentPage.getByRole("tab", { name: "Exam results" }).click();
    await expect(parentPage.getByTestId(`exam-result-${exam}`).getByTestId("result-grade")).toHaveText("C1");
  } finally { await parentPage.close(); }

  const [st, parent, acct, adminB] = await Promise.all([accessToken("STUDENT_A"), accessToken("PARENT_A"), accessToken("ACCOUNTANT_A"), accessToken("ADMIN_B")]);
  expect((await api(`/exams/${examId}/results?section_id=${sec[E]}`, st, { school: SCHOOL_A() })).status).toBe(403);
  expect((await api(`/portal/children/${ids[mate]}/exams`, parent, { school: SCHOOL_A() })).status).toBe(404);
  expect((await api("/exams", acct, { school: SCHOOL_A() })).status).toBe(403);
  expect((await api(`/exams/${examId}`, adminB, { school: SCHOOL_B() })).status).toBe(404);

  // unpublishing hides results again and reopens marks entry
  const admin = await accessToken("ADMIN_A");
  expect((await api(`/exams/${examId}/status`, admin, { method: "POST", school: SCHOOL_A(), body: { status: "scheduled" } })).status).toBe(200);
  const mine = await (await api("/my/exams", st, { school: SCHOOL_A() })).json();
  const x = mine.find((e: { id: string }) => e.id === examId);
  expect(x.status).toBe("scheduled");
  expect(x.result).toBeNull();
  expect((await api(`/my/exams/${examId}/report-card.pdf`, st, { school: SCHOOL_A() })).status).toBe(404);
});
