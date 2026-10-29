import { expect, test, type Browser, type Page } from "@playwright/test";
import { accessToken, api, email, minimalPdf, runTag, SCHOOL_A, SCHOOL_B, signIn } from "./helpers";

test.describe.configure({ mode: "serial", timeout: 90_000 }); // several sign-ins per test
const tag = runTag();
const kid = `Bus Rider ${tag}`;
const kid2 = `Van Rider ${tag}`;
const cls = `Bus ${tag}`;
const zone = `Zone ${tag}`;
const reg = `DL1T${tag}`;        // stored compact; shown grouped
const van = `HR2V${tag}`;
const route = `North ${tag}`;
const driver = `Driver ${tag}`;
let kidId = "";
let kid2Id = "";
let routeId = "";

const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const plusDays = (n: number) => iso(new Date(Date.now() + n * 86_400_000));
const monthLabel = (d: Date) => `${d.toLocaleString("en-US", { month: "short" })} ${d.getFullYear()}`;

async function admin() {
  const t = await accessToken("ADMIN_A");
  return {
    get: async (path: string) => (await api(path, t, { school: SCHOOL_A() })).json(),
    post: (path: string, body?: unknown) => api(path, t, { method: "POST", school: SCHOOL_A(), body }),
  };
}

async function transportDues(studentId: string): Promise<string[]> {
  const acc = await (await api(`/fee-collection/students/${studentId}`, await accessToken("ACCOUNTANT_A"), { school: SCHOOL_A() })).json();
  return (acc.dues as { fee_head_name: string; due_month: string }[]).filter((d) => d.fee_head_name === `Transport – ${zone}`).map((d) => d.due_month);
}

test.beforeAll(async () => {
  const a = await admin();
  const sessions: { id: string; is_current: boolean; start_date: string }[] = await a.get("/sessions");
  const cur = sessions.find((s) => s.is_current)!;
  await a.post("/classes/bulk", { classes: [{ name: cls, display_order: 64 }] });
  const classId = (await a.get(`/classes?session_id=${cur.id}`)).items.find((c: { name: string }) => c.name === cls).id;
  await a.post("/sections/bulk", { academic_session_id: cur.id, class_ids: [classId], names: ["A"] });
  const sec = (await a.get(`/sections?session_id=${cur.id}&class_id=${classId}`)).items[0].id;
  const add = async (name: string, adm: string) => (await (await a.post("/students", { full_name: name, father_name: "Father", mother_name: "Mother", date_of_birth: "2015-07-07",
    gender: "male", mobile: "9555500022", enrollment: { academic_session_id: cur.id, class_id: classId, section_id: sec, admission_number: adm, admission_date: cur.start_date } })).json()).id as string;
  kidId = await add(kid, `${tag}-TR1`);
  kid2Id = await add(kid2, `${tag}-TR2`);
  expect((await a.post(`/students/${kidId}/guardians`, { email: email("PARENT_A"), full_name: "E2E Parent A", relationship: "father" })).status).toBe(201);
});

test.afterAll(async () => {
  const t = await accessToken("ADMIN_A");
  for (const l of await (await api(`/students/${kidId}/guardians`, t, { school: SCHOOL_A() })).json())
    await api(`/students/${kidId}/guardians/${l.id}`, t, { method: "DELETE", school: SCHOOL_A() });
});

/** A fresh browser context per person (switching users on one page can race the sign-out). */
async function asUser(browser: Browser, who: Parameters<typeof signIn>[1]): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, who);
  return page;
}

test("the admin sets up a fare zone, a bus, a driver with papers, a route and its stops", async ({ browser }) => {
  const page = await asUser(browser, "ADMIN_A");

  // fare zone: ₹900 a month, no transport in May and June
  await page.goto("/transport?tab=Fare%20zones");
  await page.getByTestId("add-zone").click();
  await page.getByTestId("zone-name").fill(zone);
  await page.getByTestId("zone-amount").fill("0");
  await page.getByTestId("save-zone").click();
  await expect(page.getByTestId("zone-error")).toContainText("fare in rupees");
  await page.getByTestId("zone-amount").fill("900");
  await page.getByTestId("zone-month-5").click();
  await page.getByTestId("zone-month-6").click();
  await page.getByTestId("save-zone").click();
  await expect(page.getByTestId(`zone-${zone}`)).toContainText("₹900");
  await expect(page.getByTestId(`zone-${zone}`)).toContainText("every month except May, Jun");
  await expect(page.getByTestId(`zone-${zone}`)).toContainText(`Transport – ${zone}`);

  // vehicle (registration typed with spaces, stored compact)
  await page.goto("/transport?tab=Vehicles");
  await page.getByTestId("add-vehicle").click();
  await page.getByTestId("vehicle-reg").fill(`dl 1t ${tag.toLowerCase()}`);
  await page.getByTestId("vehicle-seats").fill("40");
  await page.getByTestId("save-vehicle").click();
  await expect(page.getByTestId(`vehicle-${reg}`)).toBeVisible();
  await expect(page.getByTestId(`vehicle-${reg}`)).toContainText("5 papers missing");

  // vehicle papers: an expired insurance shows up as expired, here and on the dashboard
  await page.getByTestId(`vehicle-${reg}`).getByRole("link").click();
  await page.getByTestId("upload-document").click();
  await page.getByTestId("document-type").selectOption("insurance");
  await page.getByTestId("document-number").fill(`POL-${tag}`);
  await page.getByTestId("document-valid-until").fill(plusDays(-3));
  await page.getByTestId("document-input").setInputFiles({ name: "insurance.pdf", mimeType: "application/pdf", buffer: minimalPdf() });
  await page.getByTestId("save-document").click();
  await expect(page.getByTestId("doc-insurance").getByTestId("doc-expired")).toBeVisible();
  await page.getByTestId("doc-insurance").getByTestId("view-document").click();
  await expect(page.getByTestId("preview-pdf")).toHaveAttribute("data", /^blob:/);
  await page.getByRole("button", { name: "Close" }).first().click();
  await page.getByRole("button", { name: /More actions for Insurance/ }).click();
  await page.getByRole("menuitem", { name: "Edit details" }).click();
  await page.getByTestId("edit-valid-until").fill(plusDays(200));
  await page.getByTestId("save-document-details").click();
  await expect(page.getByTestId("doc-insurance")).toContainText("Valid till");

  // driver: the licence is required; an expiring one is flagged
  await page.goto("/transport?tab=Drivers");
  await page.getByTestId("add-driver").click();
  await page.getByTestId("staff-name").fill(driver);
  await page.getByTestId("staff-phone").fill("9811100022");
  await page.getByTestId("save-staff").click();
  await expect(page.getByTestId("staff-error")).toContainText("licence");
  await page.getByTestId("staff-licence").fill(`DL-04${tag}12345`);
  await page.getByTestId("staff-licence-until").fill(plusDays(20));
  await page.getByTestId("save-staff").click();
  const row = page.getByTestId("staff-row").filter({ hasText: driver });
  await expect(row.getByTestId("licence-expiring")).toBeVisible();
  await row.getByRole("link", { name: driver }).click();
  await page.getByTestId("upload-document").click();
  await page.getByTestId("document-type").selectOption("driving_license");
  await page.getByTestId("document-valid-until").fill(plusDays(20));
  await page.getByTestId("document-input").setInputFiles({ name: "licence.pdf", mimeType: "application/pdf", buffer: minimalPdf() });
  await page.getByTestId("save-document").click();
  await expect(page.getByTestId("doc-driving_license")).toBeVisible();

  // route with the bus and the driver, then two stops in the zone
  await page.goto("/transport?tab=Routes");
  await page.getByTestId("add-route").click();
  await page.getByTestId("route-name").fill(route);
  const busId = ((await (await admin()).get("/transport/vehicles")) as { id: string; registration_number: string }[]).find((v) => v.registration_number === reg)!.id;
  await page.getByTestId("route-vehicle").selectOption(busId);
  await page.getByTestId("route-driver").selectOption({ label: driver });
  await page.getByTestId("save-route").click();
  await page.getByTestId(`route-${route}`).getByRole("link").click();
  await expect(page.getByTestId("route-heading")).toContainText(route);
  routeId = page.url().split("/").pop()!;
  for (const [name, time] of [["Market", "07:10"], ["Lake View", "07:25"]]) {
    await page.getByTestId("add-stop").click();
    await page.getByTestId("stop-name").fill(name);
    await page.getByTestId("stop-pickup").fill(time);
    await page.getByTestId("stop-zone").selectOption({ label: `${zone} · ₹900 a month` });
    await page.getByTestId("save-stop").click();
    await expect(page.getByTestId(`stop-${name}`)).toBeVisible();
  }
  await page.getByRole("button", { name: "Move Lake View up" }).click();
  await expect(page.getByTestId("stop-list").locator("li").first()).toContainText("Lake View");

  // the dashboard lists the driver's licence as expiring
  await page.goto("/transport");
  await expect(page.getByTestId("compliance-list")).toContainText(driver);
});

test("a student is put on a stop; transport dues appear at the fee desk only from that month", async ({ browser }) => {
  const page = await asUser(browser, "ADMIN_A");
  await page.goto(`/transport/routes/${routeId}`);
  await page.getByTestId("route-assign").click();
  await page.getByTestId("assign-student-search").fill(kid);
  await page.getByTestId("assign-student-results").getByRole("button", { name: new RegExp(kid) }).click();
  await page.getByTestId("assign-stop").selectOption({ label: "1. Lake View · 7:25 am" });
  await expect(page.getByTestId("assign-fare")).toContainText("₹900 a month");
  await page.getByTestId("confirm-assign").click();
  await expect(page.getByTestId("route-seats")).toContainText("1 of 40 seats taken");
  await expect(page.getByTestId("stop-Lake View").getByTestId("stop-riders")).toHaveText("1 student");

  const dues = await transportDues(kidId);
  const thisMonth = `${plusDays(0).slice(0, 7)}-01`;
  expect(dues.length).toBeGreaterThan(0);
  expect(dues.every((m) => m >= thisMonth)).toBe(true);                    // nothing before the start
  expect(dues.some((m) => m.slice(5, 7) === "05" || m.slice(5, 7) === "06")).toBe(false); // vacation months not billed

  const desk = await asUser(browser, "ACCOUNTANT_A");
  await desk.goto("/fees/collect");
  await desk.getByLabel("Search students").fill(tag);
  await desk.getByRole("link", { name: kid }).click();
  await expect(desk.getByLabel(`Pay Transport – ${zone} ${monthLabel(new Date())}`)).toBeVisible();
});

test("a full vehicle and a driver with an expired licence are refused", async ({ browser }) => {
  const a = await admin();
  const v = await (await a.post("/transport/vehicles", { registration_number: van, vehicle_type: "van", seating_capacity: 1 })).json();
  const z = (await a.get("/transport/zones")).find((x: { name: string }) => x.name === zone);
  const r = await (await a.post("/transport/routes", { name: `Van ${tag}`, vehicle_id: v.id })).json();
  const stop = (await (await a.post(`/transport/routes/${r.id}/stops`, { name: "Station", fare_zone_id: z.id })).json()).stop_list[0];
  expect((await a.post("/transport/assignments", { student_id: kid2Id, route_id: r.id, stop_id: stop.id, start_date: plusDays(0) })).status).toBe(201);
  const old = await (await a.post("/transport/staff", { role: "driver", full_name: `Expired ${tag}`, phone: "9811100033", license_number: `DL-09${tag}99999`, license_valid_until: plusDays(-1) })).json();

  const page = await asUser(browser, "ADMIN_A");
  await page.goto(`/students/${kidId}?tab=Transport`);
  await page.getByTestId("student-tab-transport").click();
  await page.getByTestId("student-assign").click();
  await page.getByTestId("assign-route").selectOption({ label: `Van ${tag} · 1/1 seats` });
  await page.getByTestId("assign-stop").selectOption({ index: 1 });
  await page.getByTestId("assign-start").fill(plusDays(1));
  await page.getByTestId("confirm-assign").click();
  await expect(page.getByTestId("assign-error")).toContainText("is full");
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.goto(`/transport/routes/${r.id}`);
  await page.getByTestId("edit-route").click();
  await page.getByTestId("route-driver").selectOption({ label: old.full_name });
  await page.getByTestId("save-route").click();
  await expect(page.getByTestId("route-error")).toContainText("driving licence expired");
});

test("moving to another stop from a date keeps earlier months; stopping removes later dues", async ({ browser }) => {
  const page = await asUser(browser, "ADMIN_A");
  await page.goto(`/students/${kidId}?tab=Transport`);
  await page.getByTestId("student-tab-transport").click();
  const panel = page.getByTestId("student-transport");
  await panel.getByRole("button", { name: new RegExp(`Actions for ${kid}`) }).click();
  await page.getByRole("menuitem", { name: /Move to another stop/ }).click();
  await page.getByTestId("assign-route").selectOption({ label: `${route} · 1/40 seats` });
  await page.getByTestId("assign-stop").selectOption({ label: "2. Market · 7:10 am" });
  await page.getByTestId("assign-start").fill(plusDays(1));
  await page.getByTestId("confirm-assign").click();
  await expect(panel.getByTestId("assignment-row")).toHaveCount(2);
  await expect(panel.getByTestId("assignment-row").first()).toContainText("Market");
  await expect(panel.getByTestId("assignment-row").first()).toContainText("Starts later");

  const before = await transportDues(kidId);
  // the move hasn't started yet, so it can be removed outright (the current trip keeps its end date: today)
  await panel.getByRole("button", { name: new RegExp(`Actions for ${kid}`) }).first().click();
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  await page.getByTestId("confirm-remove").click();
  await expect(panel.getByTestId("assignment-row")).toHaveCount(1);

  // stop transport today: only this month's due remains
  await panel.getByRole("button", { name: new RegExp(`Actions for ${kid}`) }).click();
  await page.getByRole("menuitem", { name: "Stop transport…" }).click();
  await page.getByTestId("end-date").fill(plusDays(0));
  await page.getByTestId("confirm-end").click();
  await expect(panel.getByTestId("assignment-row")).toContainText("Current");
  const after = await transportDues(kidId);
  expect(after).toEqual([`${plusDays(0).slice(0, 7)}-01`]);
  expect(before.length).toBeGreaterThanOrEqual(after.length);
});

test("the parent sees the route, stop, times and the crew's phone numbers — for their own child only", async ({ browser }) => {
  // put the child back on the bus from tomorrow so the parent has a current or upcoming trip
  const a = await admin();
  const r = await a.get(`/transport/routes/${routeId}`);
  const stop = r.stop_list.find((s: { name: string }) => s.name === "Lake View");
  expect((await a.post("/transport/assignments", { student_id: kidId, route_id: routeId, stop_id: stop.id, start_date: plusDays(1) })).status).toBe(201);

  const page = await asUser(browser, "PARENT_A");
  await page.goto(`/portal/${kidId}`);
  await page.getByRole("tab", { name: "Transport" }).click();
  const box = page.getByTestId("family-transport");
  await expect(box.getByTestId("family-route").first()).toHaveText(route);
  await expect(box.getByTestId("family-stop").first()).toHaveText("Lake View");
  await expect(box).toContainText(driver);
  await expect(box).toContainText("98111 00022");
  await expect(box.getByTestId("family-fare").first()).toHaveText("₹900 a month");
  await expect(box).not.toContainText("licence");

  const t = await accessToken("PARENT_A");
  expect((await api(`/portal/children/${kid2Id}/transport`, t, { school: SCHOOL_A() })).status).toBe(404);
  expect((await api("/transport/routes", t, { school: SCHOOL_A() })).status).toBe(403);
});

test("accountants can look but not change; teachers and other schools see nothing", async ({ browser }) => {
  const page = await asUser(browser, "ACCOUNTANT_A");
  await page.goto("/transport");
  await expect(page.getByTestId("transport-dashboard")).toBeVisible();
  await page.goto("/transport?tab=Routes");
  await expect(page.getByTestId(`route-${route}`)).toBeVisible();
  await expect(page.getByTestId("add-route")).toHaveCount(0);
  await page.getByTestId(`route-${route}`).getByRole("link").click();
  await expect(page.getByTestId("route-heading")).toBeVisible();
  await expect(page.getByTestId("edit-route")).toHaveCount(0);
  await expect(page.getByTestId("add-stop")).toHaveCount(0);

  const acct = await accessToken("ACCOUNTANT_A");
  const staff: Record<string, unknown>[] = await (await api("/transport/staff", acct, { school: SCHOOL_A() })).json();
  const d = staff.find((s) => s.full_name === driver)!;
  expect(d).toBeTruthy();
  expect(d.license_number).toBeUndefined();    // limited fields for accountants
  expect((await api("/transport/vehicles", acct, { method: "POST", school: SCHOOL_A(), body: { registration_number: "XX00X0000", vehicle_type: "bus", seating_capacity: 10 } })).status).toBe(403);
  const vehicles: { id: string; registration_number: string }[] = await (await api("/transport/vehicles", acct, { school: SCHOOL_A() })).json();
  const bus = vehicles.find((v) => v.registration_number === reg)!;
  expect((await (await api(`/transport/vehicles/${bus.id}`, acct, { school: SCHOOL_A() })).json()).documents).toEqual([]);

  const teacher = await accessToken("TEACHER_A");
  expect((await api("/transport/students", teacher, { school: SCHOOL_A() })).status).toBe(403);
  const librarian = await accessToken("LIBRARIAN_A");
  expect((await api("/transport/routes", librarian, { school: SCHOOL_A() })).status).toBe(403);

  const b = await accessToken("ADMIN_B");
  expect((await api(`/transport/routes/${routeId}`, b, { school: SCHOOL_B() })).status).toBe(404);
  expect((await api(`/transport/routes/${routeId}`, b, { school: SCHOOL_A() })).status).toBe(403);
  const bRoutes: { name: string }[] = await (await api("/transport/routes", b, { school: SCHOOL_B() })).json();
  expect(bRoutes.some((r) => r.name === route)).toBe(false);
  expect((await api(`/transport/student/${kidId}`, b, { school: SCHOOL_B() })).status).toBe(404);
});

test("@mobile transport pages work on a phone without sideways scrolling", async ({ page }) => {
  await signIn(page, "ADMIN_A");
  for (const tab of ["", "?tab=Students", "?tab=Routes", "?tab=Vehicles", "?tab=Drivers", "?tab=Fare%20zones"]) {
    await page.goto(`/transport${tab}`);
    await expect(page.getByRole("heading", { level: 1, name: "Transport" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `no sideways scroll on /transport${tab}`).toBeLessThanOrEqual(1);
  }
  await page.goto("/transport?tab=Routes");
  const link = page.getByTestId("route-list").getByRole("link").first();
  if (await link.count()) {
    await link.click();
    await expect(page.getByTestId("route-heading")).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  }
});
