"""Single source of truth for what each role may do.

The API enforces these with `require_permission(...)`, and `/me` sends the
caller's effective permissions to the frontend, which uses them only to decide
what to show. The frontend never decides access on its own.

Data isolation between schools is enforced separately (tenant context + RLS);
permissions only answer "what may this person do inside a school they belong to?".
"""

from collections.abc import Iterable
from enum import StrEnum


class Permission(StrEnum):
    DASHBOARD_VIEW = "dashboard:view"
    STUDENTS_VIEW = "students:view"
    STUDENTS_MANAGE = "students:manage"
    CLASSES_VIEW = "classes:view"
    CLASSES_MANAGE = "classes:manage"
    FEES_VIEW = "fees:view"
    FEES_COLLECT = "fees:collect"
    ATTENDANCE_VIEW = "attendance:view"
    ATTENDANCE_MARK = "attendance:mark"
    REPORTS_VIEW = "reports:view"
    SETTINGS_MANAGE = "settings:manage"
    SESSIONS_VIEW = "sessions:view"
    SESSIONS_MANAGE = "sessions:manage"
    # student documents are more sensitive than the student list: admins only
    DOCUMENTS_VIEW = "documents:view"
    DOCUMENTS_MANAGE = "documents:manage"
    FEE_STRUCTURES_VIEW = "fee_structures:view"
    FEE_STRUCTURES_MANAGE = "fee_structures:manage"
    NOTICES_VIEW = "notices:view"
    NOTICES_MANAGE = "notices:manage"
    PORTAL_VIEW = "portal:view"  # parent portal: own children only
    SELF_VIEW = "self:view"  # student portal: own record only
    TEACHERS_VIEW = "teachers:view"  # staff records: admins only
    TEACHERS_MANAGE = "teachers:manage"
    TEACHING_VIEW = "teaching:view"  # teacher portal: own assigned classes only
    TIMETABLE_VIEW = "timetable:view"  # which classes' timetables is decided by RLS
    TIMETABLE_MANAGE = "timetable:manage"
    # which homework is decided by RLS: teachers their classes (and only their own to change)
    HOMEWORK_VIEW = "homework:view"
    HOMEWORK_MANAGE = "homework:manage"
    EXAMS_VIEW = "exams:view"  # exams, date sheets, results (teachers: their sections' results only, by RLS)
    EXAMS_MANAGE = "exams:manage"  # exam types, grades, exams, date sheets, publishing
    REPORT_CARDS_MANAGE = "report_cards:manage"  # templates: school admins
    ADMISSIONS_VIEW = "admissions:view"  # online applications: admins and accountants
    ADMISSIONS_MANAGE = "admissions:manage"  # review, decide, create the student: admins
    ADMISSIONS_FEE = "admissions:fee"  # record the admission fee: admins and accountants
    ENQUIRIES_VIEW = "enquiries:view"  # admission CRM: the school office (admins and accountants)
    ENQUIRIES_MANAGE = "enquiries:manage"  # add and work enquiries (deleting: admins only, by RLS)
    PAYMENTS_REFUND = "payments:refund"  # refund online payments: school admins only
    NOTIFICATIONS_MANAGE = "notifications:manage"  # templates, channels, history: school admins
    # library: the catalogue and one's own loans (staff); running the library; collecting fines
    LIBRARY_VIEW = "library:view"
    LIBRARY_MANAGE = "library:manage"  # admins and librarians: catalogue, issue, return, renew
    LIBRARY_FINES = "library:fines"  # admins, librarians, accountants: fines and the library dashboard
    # transport: routes, stops, vehicles, drivers, students on routes (accountants: read, for fee queries)
    TRANSPORT_VIEW = "transport:view"
    TRANSPORT_MANAGE = "transport:manage"  # school admins
    # inventory: items, stock and history (accountants: read, for purchases and stock value)
    INVENTORY_VIEW = "inventory:view"
    INVENTORY_MANAGE = "inventory:manage"  # school admins: items, stock in/out, assignments
    # staff leave: apply for one's own leave (needs a staff record linked to the login)
    LEAVE_SELF = "leave:self"
    HR_MANAGE = "hr:manage"  # school admins: leave types, approvals, balances, holidays, staff attendance
    # payroll: salary structures, monthly payroll, payslips — school admins only (also enforced by RLS)
    PAYROLL_MANAGE = "payroll:manage"
    # certificates (bonafide, character, transfer, study, custom) and ID cards — school admins (also enforced by RLS)
    CERTIFICATES_MANAGE = "certificates:manage"
    ID_CARDS_MANAGE = "id_cards:manage"
    # analytics (whole-school charts; also enforced in the database): student analytics — school admins;
    # fee and admission analytics — school admins and accountants
    ANALYTICS_STUDENTS = "analytics:students"
    ANALYTICS_FEES = "analytics:fees"
    ANALYTICS_ADMISSIONS = "analytics:admissions"
    # staff sign-ins the school manages itself (accountants); administrators are added by the platform
    STAFF_ACCOUNTS_MANAGE = "staff_accounts:manage"
    MARKS_ENTER = "marks:enter"  # teachers: assigned sections only, until results are published
    # the school's audit log (who did what, sign-ins): school admins. Payroll entries only for its payroll admins (RLS)
    AUDIT_VIEW = "audit:view"
    # cancel (reverse) a receipt recorded at the desk, with a reason: school admins, not accountants (who record
    # them) — one person can't both take money and make the receipt disappear
    FEES_CANCEL = "fees:cancel"
    # platform-level (not tied to a school)
    PLATFORM_SCHOOLS_MANAGE = "platform:schools.manage"


P = Permission

SCHOOL_PERMISSIONS: frozenset[Permission] = frozenset(p for p in Permission if not p.value.startswith("platform:"))
PLATFORM_PERMISSIONS: frozenset[Permission] = frozenset(p for p in Permission if p.value.startswith("platform:"))

# Parents and students get view access to modules whose data will later be
# filtered to their own children / themselves.
# Staff-wide permissions exclude the parent portal (admins have no children by role).
# (and the teacher portal: an admin who also teaches holds the teacher role too).
STAFF_PERMISSIONS: frozenset[Permission] = SCHOOL_PERMISSIONS - {
    Permission.PORTAL_VIEW,
    Permission.SELF_VIEW,
    Permission.TEACHING_VIEW,
}

ROLE_PERMISSIONS: dict[str, frozenset[Permission]] = {
    "school_admin": STAFF_PERMISSIONS,
    "accountant": frozenset(
        {
            P.DASHBOARD_VIEW,
            P.STUDENTS_VIEW,
            P.CLASSES_VIEW,
            P.FEES_VIEW,
            P.FEES_COLLECT,
            P.REPORTS_VIEW,
            P.SESSIONS_VIEW,
            P.FEE_STRUCTURES_VIEW,
            P.FEE_STRUCTURES_MANAGE,
            P.NOTICES_VIEW,
            P.TIMETABLE_VIEW,
            P.ADMISSIONS_VIEW,
            P.ADMISSIONS_FEE,
            P.ENQUIRIES_VIEW,
            P.ENQUIRIES_MANAGE,
            P.LIBRARY_VIEW,
            P.LIBRARY_FINES,
            P.TRANSPORT_VIEW,
            P.INVENTORY_VIEW,
            P.LEAVE_SELF,
            P.ANALYTICS_FEES,
            P.ANALYTICS_ADMISSIONS,
        }
    ),
    "teacher": frozenset(
        {
            P.DASHBOARD_VIEW,
            P.STUDENTS_VIEW,
            P.CLASSES_VIEW,
            P.ATTENDANCE_VIEW,
            P.ATTENDANCE_MARK,
            P.REPORTS_VIEW,
            P.SESSIONS_VIEW,
            P.NOTICES_VIEW,
            P.TEACHING_VIEW,  # what a teacher sees is limited to assigned sections by RLS
            P.TIMETABLE_VIEW,
            P.HOMEWORK_VIEW,
            P.HOMEWORK_MANAGE,
            P.EXAMS_VIEW,
            P.MARKS_ENTER,
            P.LIBRARY_VIEW,
            P.LEAVE_SELF,
        }
    ),
    # A staff member on library duty (given by an admin on the staff record).
    "librarian": frozenset(
        {P.DASHBOARD_VIEW, P.NOTICES_VIEW, P.LIBRARY_VIEW, P.LIBRARY_MANAGE, P.LIBRARY_FINES, P.LEAVE_SELF}
    ),
    # Parents see fees and attendance through the portal, for their own children only.
    "parent": frozenset({P.DASHBOARD_VIEW, P.NOTICES_VIEW, P.PORTAL_VIEW}),
    # Students see their own attendance, fees and receipts through /my.
    "student": frozenset({P.DASHBOARD_VIEW, P.NOTICES_VIEW, P.SELF_VIEW}),
}


# Salaries are for a school's own administrators: platform super admins run the service but don't
# get payroll (the database refuses them too — private.is_payroll_admin).
# Nor do they reverse a school's receipts (a school's own money decision).
SUPER_ADMIN_SCHOOL_PERMISSIONS: frozenset[Permission] = STAFF_PERMISSIONS - {
    Permission.PAYROLL_MANAGE,
    Permission.FEES_CANCEL,
}


def school_permissions(roles: Iterable[str], *, is_super_admin: bool = False) -> frozenset[Permission]:
    if is_super_admin:
        # a super admin who is also a school admin of this school gets payroll through that role
        return SUPER_ADMIN_SCHOOL_PERMISSIONS | (
            ROLE_PERMISSIONS["school_admin"] if "school_admin" in roles else frozenset()
        )
    perms: set[Permission] = set()
    for role in roles:
        perms |= ROLE_PERMISSIONS.get(role, frozenset())
    return frozenset(perms)


def platform_permissions(is_super_admin: bool) -> frozenset[Permission]:
    return PLATFORM_PERMISSIONS if is_super_admin else frozenset()


def sorted_values(perms: Iterable[Permission]) -> list[str]:
    return sorted(p.value for p in perms)
