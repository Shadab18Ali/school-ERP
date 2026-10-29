import { expect, test } from "@playwright/test";
import { signIn, type Account } from "./helpers";

const PAGES = {
  "/students": "Students",
  "/classes": "Classes & sections",
  "/fees": "Fee",  // "Fee structures" for staff, "Fees" for parents
  "/attendance": "Attendance",
  "/reports": "Reports",
  "/settings": "Settings",
  "/sessions": "Academic sessions",
  "/admin/schools": "Schools",
  "/portal": "My children",
  "/notices": "Notices",
  "/my": "My school record",
  "/teachers": "Teachers",
  "/teaching": "My classes",
  "/timetable": "Timetable",
  "/homework": "Homework",
  "/exams": "Exams",
  "/report-cards": "Report cards",
  "/admissions": "Admissions",
  "/enquiries": "Enquiries",
  "/fees/online": "Online payments",
  "/communication": "Communication",
  "/library": "Library",
  "/transport": "Transport",
  "/inventory": "Inventory",
  "/leave": "My leave",
  "/staff-leave": "Staff leave",
  "/staff-attendance": "Staff attendance",
  "/payroll": "Payroll",
  "/certificates": "Certificates",
  "/id-cards": "ID cards",
  "/analytics": "Analytics",
  "/admin/plans": "Plans",
  "/admin/analytics": "Platform analytics",
  "/admin/invoices": "Invoices",
  "/admin/billing": "Billing setup",
  "/admin/audit": "Platform audit log",
  "/audit-log": "Audit log",
} as const;
type Path = keyof typeof PAGES;

// Must match backend/app/core/permissions.py
const ALLOWED: Partial<Record<Account, Path[]>> = {
  SUPER: ["/admin/schools", "/admin/plans", "/admin/analytics", "/admin/invoices", "/admin/billing", "/admin/audit"],
  ADMIN_A: ["/students", "/classes", "/fees", "/attendance", "/reports", "/settings", "/sessions", "/notices", "/teachers", "/timetable", "/homework", "/exams", "/report-cards", "/admissions", "/enquiries", "/fees/online", "/communication", "/library", "/transport", "/inventory", "/leave", "/staff-leave", "/staff-attendance", "/payroll", "/certificates", "/id-cards", "/analytics", "/audit-log"],
  ADMIN_B: ["/students", "/classes", "/fees", "/attendance", "/reports", "/settings", "/sessions", "/notices", "/teachers", "/timetable", "/homework", "/exams", "/report-cards", "/admissions", "/enquiries", "/fees/online", "/communication", "/library", "/transport", "/inventory", "/leave", "/staff-leave", "/staff-attendance", "/payroll", "/certificates", "/id-cards", "/analytics", "/audit-log"],
  ACCOUNTANT_A: ["/students", "/classes", "/fees", "/reports", "/sessions", "/notices", "/timetable", "/admissions", "/enquiries", "/fees/online", "/library", "/transport", "/inventory", "/leave", "/analytics"],
  TEACHER_A: ["/students", "/classes", "/attendance", "/reports", "/sessions", "/notices", "/teaching", "/timetable", "/homework", "/exams", "/library", "/leave"],
  PARENT_A: ["/portal", "/notices"],
  STUDENT_A: ["/my", "/notices"],
  LIBRARIAN_A: ["/notices", "/library", "/leave"],
};

const NAV_LABEL: Record<Path, string> = { ...PAGES, "/settings": "School settings", "/fees": "Fees" };

test.describe.configure({ timeout: 120_000 }); // every role visits every page (28 and counting)

for (const who of ["SUPER", "ADMIN_A", "ACCOUNTANT_A", "TEACHER_A", "PARENT_A", "STUDENT_A", "LIBRARIAN_A"] as Account[]) {
  test(`${who}: sees only permitted pages and menu items`, async ({ page }) => {
    await signIn(page, who);
    const nav = page.getByRole("navigation", { name: "Main" });

    for (const [path, title] of Object.entries(PAGES) as [Path, string][]) {
      const allowed = ALLOWED[who]!.includes(path);

      await expect(nav.getByRole("link", { name: NAV_LABEL[path], exact: true }), `${who} menu: ${path}`)
        .toHaveCount(allowed ? 1 : 0);

      // Typing the URL directly must not bypass the menu.
      await page.goto(path);
      if (allowed) {
        await expect(page.getByRole("heading", { level: 1, name: title }), `${who} should open ${path}`).toBeVisible();
        await expect(page.getByTestId("access-denied")).toHaveCount(0);
      } else {
        await expect(page.getByTestId("access-denied"), `${who} must be refused ${path}`).toBeVisible();
      }
    }

    // Everyone has a dashboard, a profile and their own notifications.
    await page.goto("/profile");
    await expect(page.getByRole("heading", { level: 1, name: "My profile" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Notifications", exact: true })).toHaveCount(1);
    await page.goto("/notifications");
    await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
  });
}
