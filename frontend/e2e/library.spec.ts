import { expect, test, type Browser, type Page } from "@playwright/test";
import { accessToken, api, email, runTag, SCHOOL_A, SCHOOL_B, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });
const tag = runTag();
const title = `The Guide ${tag}`;
const title2 = `Atlas ${tag}`;
const kid = `Reader ${tag}`;
const cls = `Lib ${tag}`;
let studentId = "";
let bookId = "";
let acc: string[] = [];

test.beforeAll(async () => {
  const t = await accessToken("ADMIN_A");
  const post = (path: string, body?: unknown) => api(path, t, { method: "POST", school: SCHOOL_A(), body });
  const sessions: { id: string; is_current: boolean }[] = await (await api("/sessions", t, { school: SCHOOL_A() })).json();
  const cur = sessions.find((s) => s.is_current)!.id;
  await post("/classes/bulk", { classes: [{ name: cls, display_order: 63 }] });
  const classId = (await (await api(`/classes?session_id=${cur}`, t, { school: SCHOOL_A() })).json()).items.find((c: { name: string }) => c.name === cls).id;
  await post("/sections/bulk", { academic_session_id: cur, class_ids: [classId], names: ["A"] });
  const sec = (await (await api(`/sections?session_id=${cur}&class_id=${classId}`, t, { school: SCHOOL_A() })).json()).items[0].id;
  studentId = (await (await post("/students", { full_name: kid, father_name: "Father", mother_name: "Mother", date_of_birth: "2015-06-06", gender: "female",
    mobile: "9555500011", enrollment: { academic_session_id: cur, class_id: classId, section_id: sec, admission_number: `${tag}-LB`, admission_date: "2026-04-01" } })).json()).id;
  expect((await post(`/students/${studentId}/guardians`, { email: email("PARENT_A"), full_name: "E2E Parent A", relationship: "mother" })).status).toBe(201);
});

test.afterAll(async () => {
  const t = await accessToken("ADMIN_A");
  for (const l of await (await api(`/students/${studentId}/guardians`, t, { school: SCHOOL_A() })).json())
    await api(`/students/${studentId}/guardians/${l.id}`, t, { method: "DELETE", school: SCHOOL_A() });
});

/** A fresh browser context per person (switching users on one page can race the sign-out). */
async function asUser(browser: Browser, who: Parameters<typeof signIn>[1]): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, who);
  return page;
}

async function desk(page: Page, accession: string) {
  await page.goto("/library?tab=Issue%20%26%20return");
  await page.getByTestId("desk-accession").fill(accession);
  await page.getByTestId("desk-find").click();
  await expect(page.getByTestId("desk-copy")).toBeVisible();
}

test("the admin sets the borrowing rules; the librarian can't change them", async ({ browser }) => {
  let page: Page;
  page = await asUser(browser, "ADMIN_A");
  await page.goto("/library?tab=Settings");
  const rules = page.getByTestId("library-rules");
  await rules.getByTestId("rule-fine").fill("-1");
  await rules.getByTestId("save-rules").click();
  await expect(rules.getByTestId("rules-error")).toContainText("Fine per day");
  await rules.getByTestId("rule-fine").fill("2");
  await rules.getByTestId("rule-grace").fill("0");
  await rules.getByTestId("rule-max-fine").fill("");
  await rules.getByTestId("rule-max-student").fill("2");
  await rules.getByTestId("rule-loan-days-student").fill("14");
  await rules.getByTestId("save-rules").click();
  await expect(page.getByText("Library rules saved.")).toBeVisible();
  await expect(rules.getByTestId("rules-summary")).toContainText("₹2 for each day late after 0 grace days");

  page = await asUser(browser, "LIBRARIAN_A");
  await page.goto("/library?tab=Settings");
  await expect(page.getByTestId("rule-fine")).toBeDisabled();
  await expect(page.getByTestId("save-rules")).toHaveCount(0);
  const res = await api("/library/settings", await accessToken("LIBRARIAN_A"), { method: "PUT", school: SCHOOL_A(), body: {
    loan_days_student: 99, loan_days_staff: 30, max_books_student: 9, max_books_staff: 5, fine_per_day: "0", grace_days: 0, max_fine: null,
    max_renewals: 1, block_when_overdue: true, block_when_fines_due: true } });
  expect(res.status).toBe(403);
});

test("the librarian adds books; the ISBN is checked; copies get accession numbers", async ({ browser }) => {
  const page = await asUser(browser, "LIBRARIAN_A");
  // the librarian's home page is the library dashboard
  await expect(page.getByTestId("library-dashboard")).toBeVisible();
  await page.goto("/library?tab=Catalogue");
  await page.getByTestId("add-book").click();
  await page.getByTestId("book-title").fill(title);
  await page.getByTestId("book-authors").fill("R. K. Narayan");
  await page.getByTestId("book-isbn").fill("0-306-40615-3");
  await page.getByTestId("book-category").selectOption("__new");
  await page.getByTestId("book-new-category").fill(`Novels ${tag}`);
  await page.getByTestId("book-copies").fill("2");
  await page.getByTestId("book-price").fill("300");
  await page.getByTestId("save-book").click();
  await expect(page.getByTestId("book-error")).toContainText("ISBN isn't valid");
  await page.getByTestId("book-isbn").fill("0-306-40615-2");
  await page.getByTestId("save-book").click();
  await expect(page.getByTestId("book-heading")).toHaveText(title);
  await expect(page.getByTestId("book-summary")).toContainText("2 of 2 on the shelf");
  await expect(page.getByTestId("copy-row")).toHaveCount(2);
  acc = (await page.getByTestId("copy-row").locator(".font-mono").allTextContents()).map((s) => s.trim());
  expect(acc.every((a) => /^ACC-\d{6}$/.test(a))).toBe(true);
  bookId = page.url().split("/").pop()!;

  // a second book, with the accession numbers already written in the books
  await page.goto("/library?tab=Catalogue");
  await page.getByTestId("add-book").click();
  await page.getByTestId("book-title").fill(title2);
  await page.getByTestId("manual-accession").check();
  await page.getByTestId("book-accessions").fill(`R${tag}-1`);
  await page.getByTestId("save-book").click();
  await expect(page.getByTestId("book-heading")).toHaveText(title2);
  await expect(page.getByTestId("copy-row")).toContainText(`R${tag}-1`);

  // the same ISBN twice is refused (by the database, whatever the screen does)
  const dup = await api("/library/books", await accessToken("LIBRARIAN_A"), { method: "POST", school: SCHOOL_A(), body: { title: "Dup", isbn: "9780306406157" } });
  expect(dup.status).toBe(409);
  // search by author and by the ISBN-10
  await page.goto("/library?tab=Catalogue");
  await page.getByTestId("book-search").fill("narayan");
  await expect(page.getByTestId("book-row").filter({ hasText: title })).toBeVisible();
  await page.getByTestId("book-search").fill("0306406152");
  await expect(page.getByTestId("book-row").filter({ hasText: title })).toBeVisible();
});

test("issuing at the desk respects the limits; the parent sees the book", async ({ browser }) => {
  let page: Page;
  page = await asUser(browser, "LIBRARIAN_A");
  await desk(page, acc[0]);
  await expect(page.getByTestId("desk-copy")).toContainText("Available");
  await page.getByTestId("borrower-search").fill(kid);
  await page.getByTestId("borrower-option").filter({ hasText: kid }).click();
  await expect(page.getByTestId("issue-borrower")).toHaveText(kid);
  await page.getByTestId("issue-book").click();
  await expect(page.getByTestId("desk-done")).toContainText(`issued to ${kid}`);

  // the same copy is now on loan
  await desk(page, acc[0]);
  await expect(page.getByTestId("desk-loan")).toContainText(kid);
  // a second copy of the same book is refused by the database
  await desk(page, acc[1]);
  await page.getByTestId("borrower-search").fill(kid);
  await page.getByTestId("borrower-option").filter({ hasText: kid }).click();
  await page.getByTestId("issue-book").click();
  await expect(page.getByTestId("issue-error")).toContainText("already has a copy of this book");
  // another book is fine (2 allowed)
  await desk(page, `R${tag}-1`);
  await page.getByTestId("borrower-search").fill(kid);
  await page.getByTestId("borrower-option").filter({ hasText: kid }).click();
  await page.getByTestId("issue-book").click();
  await expect(page.getByTestId("desk-done")).toContainText(`issued to ${kid}`);
  // renew once, not twice
  await desk(page, `R${tag}-1`);
  await page.getByTestId("loan-renew").click();
  await expect(page.getByText(/Renewed: now due/)).toBeVisible();
  await page.getByTestId("loan-renew").click();
  await expect(page.getByText("renewed the most times allowed")).toBeVisible();

  page = await asUser(browser, "PARENT_A");
  await page.goto(`/portal/${studentId}?tab=Library`);
  await expect(page.getByRole("tab", { name: "Library" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("library-current").getByTestId("student-loan")).toHaveCount(2);
  await expect(page.getByTestId("library-current")).toContainText(title);
});

test("a lost book is charged its price, blocks borrowing, and the accountant collects it", async ({ browser }) => {
  let page: Page;
  page = await asUser(browser, "LIBRARIAN_A");
  await desk(page, acc[0]);
  await page.getByTestId("loan-return").click();
  await page.getByTestId("condition-lost").check();
  await page.getByTestId("confirm-return").click();
  await expect(page.getByTestId("desk-done")).toContainText("₹300");
  await expect(page.getByTestId("desk-done").getByTestId("fine-status")).toHaveText("Fine unpaid");

  // the borrower page shows the block and the history
  await page.goto("/library?tab=Borrowers");
  await page.getByTestId("borrower-search").fill(kid);
  await page.getByTestId("borrower-option").filter({ hasText: kid }).click();
  await expect(page.getByTestId("borrower-heading")).toHaveText(kid);
  await expect(page.getByTestId("borrower-blocked")).toContainText("unpaid library fine");
  await expect(page.getByTestId("borrower-history")).toContainText(title);
  await expect(page.getByTestId("borrower-current")).toContainText(title2);
  // and the database refuses another issue while the fine is unpaid
  await page.getByTestId("borrower-accession").fill(acc[1]);
  await page.getByRole("button", { name: "Find" }).click();
  await page.getByTestId("issue-book").click();
  await expect(page.getByTestId("issue-error")).toContainText("unpaid library fine");

  page = await asUser(browser, "ACCOUNTANT_A");
  await page.goto("/library?tab=Loans&state=fines_unpaid");
  const row = page.getByTestId("loan-row").filter({ hasText: kid });
  await expect(row).toContainText("₹300");
  await expect(row.getByTestId("loan-return")).toHaveCount(0);  // accountants collect, they don't run the desk
  await row.getByTestId("loan-collect").click();
  await page.getByTestId("collect-mode").selectOption("upi");
  await page.getByTestId("confirm-collect").click();
  await expect(page.getByTestId("collect-error")).toContainText("reference");
  await page.getByTestId("collect-reference").fill(`UPI${tag}`);
  await page.getByTestId("confirm-collect").click();
  await expect(page.getByText(/Payment recorded: receipt LIB-\d{6}/)).toBeVisible();
  await page.getByTestId("loans-tab-fines_settled").click();
  await expect(page.getByTestId("loan-row").filter({ hasText: kid }).getByTestId("fine-status")).toHaveText("Fine paid");

  page = await asUser(browser, "PARENT_A");
  await page.goto(`/portal/${studentId}?tab=Library`);
  await expect(page.getByTestId("library-history")).toContainText(title);
  await expect(page.getByTestId("library-history").getByTestId("fine-status")).toHaveText("Fine paid");
});

test("only admins waive; the dashboard adds up", async ({ browser }) => {
  let page: Page;
  page = await asUser(browser, "LIBRARIAN_A");
  await desk(page, `R${tag}-1`);
  await page.getByTestId("loan-return").click();
  await page.getByTestId("condition-damaged").check();
  await page.getByTestId("return-charge").fill("50");
  await page.getByTestId("confirm-return").click();
  await expect(page.getByTestId("desk-done")).toContainText("₹50");
  await expect(page.getByTestId("loan-waive")).toHaveCount(0);  // librarians can't waive
  const loans = await (await api(`/library/loans?state=fines_unpaid&q=${encodeURIComponent(kid)}`, await accessToken("LIBRARIAN_A"), { school: SCHOOL_A() })).json();
  expect((await api(`/library/loans/${loans.items[0].id}/waive`, await accessToken("LIBRARIAN_A"), { method: "POST", school: SCHOOL_A(), body: { reason: "Please" } })).status).toBe(403);

  page = await asUser(browser, "ADMIN_A");
  await page.goto("/library?tab=Loans&state=fines_unpaid");
  const row = page.getByTestId("loan-row").filter({ hasText: kid });
  await row.getByTestId("loan-waive").click();
  await page.getByTestId("waive-reason").fill("Binding was already loose");
  await page.getByTestId("confirm-waive").click();
  await expect(page.getByText("Fine waived.")).toBeVisible();

  await page.goto("/library");
  const dash = page.getByTestId("library-dashboard");
  await expect(dash).toBeVisible();
  const d = await (await api("/library/dashboard", await accessToken("ADMIN_A"), { school: SCHOOL_A() })).json();
  await expect(dash.getByTestId("kpi-issued-value")).toHaveText(String(d.issued));
  await expect(dash.getByTestId("kpi-available-value")).toHaveText(String(d.available));
  await expect(dash.getByTestId("kpi-overdue-value")).toHaveText(String(d.overdue));
  expect(Number(d.fines_collected_total)).toBeGreaterThanOrEqual(300);
  expect(Number(d.fines_waived_total)).toBeGreaterThanOrEqual(50);
});

test("library duty turns a staff member into a librarian, and back", async ({ browser }) => {
  let page: Page;
  const t = await accessToken("ADMIN_A");
  const teachers = (await (await api(`/teachers?search=${encodeURIComponent(email("TEACHER_A"))}`, t, { school: SCHOOL_A() })).json()).items;
  const teacherId = teachers[0].id;
  // without duty: catalogue and own books only
  page = await asUser(browser, "TEACHER_A");
  await page.goto("/library");
  await expect(page.getByTestId("library-tab-catalogue")).toBeVisible();
  await expect(page.getByTestId("library-tab-my-books")).toBeVisible();
  await expect(page.getByTestId("library-tab-issue-return")).toHaveCount(0);
  expect((await api("/library/loans", await accessToken("TEACHER_A"), { method: "POST", school: SCHOOL_A(), body: { accession_number: acc[1], student_id: studentId } })).status).toBe(403);

  page = await asUser(browser, "ADMIN_A");
  await page.goto(`/teachers/${teacherId}`);
  await page.getByTestId("library-duty-toggle").click();  // saved on the server, then shown ticked
  await expect(page.getByText("Library duty given.")).toBeVisible();
  await expect(page.getByTestId("library-duty-toggle")).toBeChecked();

  page = await asUser(browser, "TEACHER_A");
  await page.goto("/library");
  await expect(page.getByTestId("library-tab-issue-return")).toBeVisible();
  await expect(page.getByTestId("library-dashboard")).toBeVisible();

  page = await asUser(browser, "ADMIN_A");
  await page.goto(`/teachers/${teacherId}`);
  await page.getByTestId("library-duty-toggle").click();
  await expect(page.getByText("Library duty removed.")).toBeVisible();
  await expect(page.getByTestId("library-duty-toggle")).not.toBeChecked();
  expect((await api("/library/dashboard", await accessToken("TEACHER_A"), { school: SCHOOL_A() })).status).toBe(403);
});

test("families and other schools see none of the library's records", async () => {
  expect((await api("/library/books", await accessToken("PARENT_A"), { school: SCHOOL_A() })).status).toBe(403);
  expect((await api("/library/loans", await accessToken("STUDENT_A"), { school: SCHOOL_A() })).status).toBe(403);
  expect((await api(`/library/books/${bookId}`, await accessToken("ADMIN_B"), { school: SCHOOL_B() })).status).toBe(404);
  const b = await (await api("/library/loans?state=all", await accessToken("ADMIN_B"), { school: SCHOOL_B() })).json();
  expect(JSON.stringify(b)).not.toContain(kid);
  // a parent can't read another family's child's library
  expect((await api(`/portal/children/${crypto.randomUUID()}/library`, await accessToken("PARENT_A"), { school: SCHOOL_A() })).status).toBe(404);
});
