"""What can be notified, to whom, with which variables, and the default wording.

A school can change the wording (and switch each channel on or off) per event; the
defaults below apply until it does. Placeholders are written {{name}} and only the
variables listed for the event are allowed.

Default channels: in-app and email on; SMS and WhatsApp off until the school sets up
an account and turns them on (they cost money per message).
"""

from dataclasses import dataclass

CHANNELS = ("in_app", "email", "sms", "whatsapp")


@dataclass(frozen=True)
class Default:
    enabled: bool
    body: str
    subject: str | None = None  # email subject / in-app title


@dataclass(frozen=True)
class Event:
    key: str
    label: str
    description: str
    audience: str
    variables: dict[str, str]
    sample: dict[str, str]
    defaults: dict[str, Default]
    wa_params: tuple[str, ...] = ()  # suggested order of the WhatsApp template's {{1}}, {{2}}...
    channels: tuple[str, ...] = CHANNELS


COMMON = {
    "school_name": "School name",
    "school_phone": "School phone number",
    "recipient_name": "Name of the person receiving the message",
}
COMMON_SAMPLE = {"school_name": "Green Valley School", "school_phone": "011 4000 0000", "recipient_name": "Rohan Verma"}
STUDENT = {"student_name": "Student's name (several children: joined with “and”)"}
SIGN = "\n\n{{school_name}}"

EVENTS: dict[str, Event] = {}


def _add(e: Event) -> None:
    EVENTS[e.key] = e


_add(
    Event(
        key="fee_reminder",
        label="Fee reminder",
        description="Overdue school fees. Sent when staff send reminders, or automatically on the days of the month you choose.",
        audience="Parents",
        variables={
            **COMMON,
            **STUDENT,
            "class_section": "Class and section",
            "amount_due": "Overdue amount",
            "total_outstanding": "Total still to pay this session",
            "portal_link": "Link to pay online / see fees",
        },
        sample={
            "student_name": "Aarav Verma",
            "class_section": "Class 5 – A",
            "amount_due": "₹4,500",
            "total_outstanding": "₹13,500",
            "portal_link": "https://erp.example.in/portal",
        },
        defaults={
            "in_app": Default(
                True,
                "{{amount_due}} is overdue for {{student_name}} ({{class_section}}). Pay online or at the school office.",
                "Fee reminder: {{student_name}}",
            ),
            "email": Default(
                True,
                "Dear {{recipient_name}},\n\nThis is a reminder that {{amount_due}} in school fees is overdue for {{student_name}} "
                "({{class_section}}). The total still to pay this session is {{total_outstanding}}.\n\nYou can pay online in the parent "
                "portal: {{portal_link}}\n\nIf you have already paid, please ignore this message." + SIGN,
                "Fee reminder for {{student_name}}",
            ),
            "sms": Default(
                False,
                "{{school_name}}: Fee of {{amount_due}} is overdue for {{student_name}}. Please pay soon. Ignore if paid.",
            ),
            "whatsapp": Default(False, "Fee of {{amount_due}} is overdue for {{student_name}}."),
        },
        wa_params=("student_name", "amount_due", "school_name"),
    )
)
_add(
    Event(
        key="payment_received",
        label="Payment confirmation",
        description="A fee receipt, whether paid at the office or online.",
        audience="Parents",
        variables={
            **COMMON,
            **STUDENT,
            "class_section": "Class and section",
            "amount": "Amount paid",
            "receipt_number": "Receipt number",
            "payment_mode": "How it was paid",
            "payment_date": "Date of payment",
            "balance": "Still to pay after this payment",
            "portal_link": "Link to the receipt in the parent portal",
        },
        sample={
            "student_name": "Aarav Verma",
            "class_section": "Class 5 – A",
            "amount": "₹4,500",
            "receipt_number": "GVS/2026-27/000123",
            "payment_mode": "UPI",
            "payment_date": "12 Oct 2026",
            "balance": "₹9,000",
            "portal_link": "https://erp.example.in/portal",
        },
        defaults={
            "in_app": Default(
                True,
                "Receipt {{receipt_number}} for {{student_name}}. Still to pay: {{balance}}.",
                "Payment received: {{amount}}",
            ),
            "email": Default(
                True,
                "Dear {{recipient_name}},\n\nWe have received {{amount}} for {{student_name}} ({{class_section}}) on {{payment_date}} "
                "by {{payment_mode}}.\nReceipt number: {{receipt_number}}\nStill to pay this session: {{balance}}\n\n"
                "The receipt is in the parent portal: {{portal_link}}" + SIGN,
                "Payment received — receipt {{receipt_number}}",
            ),
            "sms": Default(
                False,
                "{{school_name}}: Received {{amount}} for {{student_name}}. Receipt {{receipt_number}}. Balance {{balance}}.",
            ),
            "whatsapp": Default(False, "Received {{amount}} for {{student_name}}. Receipt {{receipt_number}}."),
        },
        wa_params=("amount", "student_name", "receipt_number", "school_name"),
    )
)
_add(
    Event(
        key="student_absent",
        label="Attendance alert",
        description="A student is marked absent (today or yesterday).",
        audience="Parents",
        variables={
            **COMMON,
            **STUDENT,
            "class_section": "Class and section",
            "date": "Date of the absence",
            "portal_link": "Link to attendance in the parent portal",
        },
        sample={
            "student_name": "Aarav Verma",
            "class_section": "Class 5 – A",
            "date": "12 Oct 2026",
            "portal_link": "https://erp.example.in/portal",
        },
        defaults={
            "in_app": Default(
                True, "{{student_name}} ({{class_section}}) was marked absent on {{date}}.", "Absent: {{student_name}}"
            ),
            "email": Default(
                True,
                "Dear {{recipient_name}},\n\n{{student_name}} ({{class_section}}) was marked absent on {{date}}. If you did not expect "
                "this, please contact the class teacher." + SIGN,
                "{{student_name}} was absent on {{date}}",
            ),
            "sms": Default(
                False,
                "{{school_name}}: {{student_name}} was absent on {{date}}. Please contact the class teacher if unexpected.",
            ),
            "whatsapp": Default(False, "{{student_name}} was absent on {{date}}."),
        },
        wa_params=("student_name", "date", "school_name"),
    )
)
_add(
    Event(
        key="homework_assigned",
        label="Homework",
        description="New homework or an assignment for a section.",
        audience="Parents and students",
        variables={
            **COMMON,
            **STUDENT,
            "class_section": "Class and section",
            "title": "Homework title",
            "kind": "Homework or Assignment",
            "subject": "Subject",
            "due_date": "Due date",
            "portal_link": "Link to the homework",
        },
        sample={
            "student_name": "Aarav Verma",
            "class_section": "Class 5 – A",
            "title": "Read chapter 4",
            "kind": "Homework",
            "subject": "English",
            "due_date": "15 Oct 2026",
            "portal_link": "https://erp.example.in/portal",
        },
        defaults={
            "in_app": Default(True, "{{subject}}: {{title}}. Due {{due_date}}.", "New {{kind}}: {{title}}"),
            "email": Default(
                False,
                "Dear {{recipient_name}},\n\nNew {{kind}} for {{student_name}} ({{class_section}}):\n{{subject}} — {{title}}\n"
                "Due: {{due_date}}\n\nDetails: {{portal_link}}" + SIGN,
                "New {{kind}}: {{title}} (due {{due_date}})",
            ),
            "sms": Default(
                False, "{{school_name}}: New {{kind}} for {{student_name}}: {{subject}} - {{title}}, due {{due_date}}."
            ),
            "whatsapp": Default(False, "New {{kind}} for {{student_name}}: {{title}}, due {{due_date}}."),
        },
        wa_params=("student_name", "title", "due_date"),
    )
)
_add(
    Event(
        key="exam_scheduled",
        label="Exam date sheet",
        description="An exam's date sheet is announced (the exam is scheduled).",
        audience="Parents and students",
        variables={
            **COMMON,
            **STUDENT,
            "exam_name": "Exam name",
            "first_date": "First paper",
            "last_date": "Last paper",
            "portal_link": "Link to the date sheet",
        },
        sample={
            "student_name": "Aarav Verma",
            "exam_name": "Half Yearly",
            "first_date": "20 Oct 2026",
            "last_date": "28 Oct 2026",
            "portal_link": "https://erp.example.in/portal",
        },
        defaults={
            "in_app": Default(
                True, "{{exam_name}}: {{first_date}} to {{last_date}}. See the date sheet.", "{{exam_name}} date sheet"
            ),
            "email": Default(
                True,
                "Dear {{recipient_name}},\n\nThe date sheet for {{exam_name}} is out. Papers run from {{first_date}} to {{last_date}}.\n\n"
                "See it here: {{portal_link}}" + SIGN,
                "{{exam_name}} date sheet",
            ),
            "sms": Default(
                False, "{{school_name}}: {{exam_name}} from {{first_date}} to {{last_date}}. Date sheet in the app."
            ),
            "whatsapp": Default(False, "{{exam_name}} from {{first_date}} to {{last_date}}."),
        },
        wa_params=("exam_name", "first_date", "last_date"),
    )
)
_add(
    Event(
        key="results_published",
        label="Exam results",
        description="An exam's results are published.",
        audience="Parents and students",
        variables={**COMMON, **STUDENT, "exam_name": "Exam name", "portal_link": "Link to the results"},
        sample={
            "student_name": "Aarav Verma",
            "exam_name": "Half Yearly",
            "portal_link": "https://erp.example.in/portal",
        },
        defaults={
            "in_app": Default(
                True, "Results and report card for {{student_name}} are available.", "{{exam_name}} results"
            ),
            "email": Default(
                True,
                "Dear {{recipient_name}},\n\nThe {{exam_name}} results for {{student_name}} are out. The report card can be "
                "downloaded from the portal: {{portal_link}}" + SIGN,
                "{{exam_name}} results for {{student_name}}",
            ),
            "sms": Default(False, "{{school_name}}: {{exam_name}} results for {{student_name}} are out. See the app."),
            "whatsapp": Default(False, "{{exam_name}} results for {{student_name}} are out."),
        },
        wa_params=("exam_name", "student_name"),
    )
)
_add(
    Event(
        key="admission_update",
        label="Admission updates",
        description="Each step of an online application (received, under review, verified, approved, not approved, fee paid, admitted).",
        audience="Applicants (no account needed)",
        variables={
            **COMMON,
            "student_name": "Child's name",
            "application_number": "Application number",
            "class_name": "Class applied for",
            "status_label": "New status",
            "status_detail": "What happens next (or the reason if not approved)",
            "track_link": "Link to track the application",
        },
        sample={
            "student_name": "Diya Sharma",
            "application_number": "ADM2026-00042",
            "class_name": "Class 1",
            "status_label": "Approved",
            "status_detail": "Please pay the admission fee of ₹2,500 at the school office.",
            "track_link": "https://erp.example.in/apply/gvs/track?number=ADM2026-00042",
        },
        defaults={
            "email": Default(
                True,
                "Dear {{recipient_name}},\n\nApplication {{application_number}} for {{student_name}} ({{class_name}}): "
                "{{status_label}}.\n{{status_detail}}\n\nTrack it here: {{track_link}}" + SIGN,
                "Application {{application_number}}: {{status_label}}",
            ),
            "sms": Default(
                False,
                "{{school_name}}: Application {{application_number}} for {{student_name}}: {{status_label}}. Track: {{track_link}}",
            ),
            "whatsapp": Default(False, "Application {{application_number}}: {{status_label}}."),
        },
        wa_params=("application_number", "student_name", "status_label"),
        channels=("email", "sms", "whatsapp"),
    )
)
_add(
    Event(
        key="notice_published",
        label="School notices",
        description="A notice is published (or reaches its scheduled time), to the notice's audience and classes.",
        audience="As chosen on the notice",
        variables={
            **COMMON,
            "title": "Notice title",
            "excerpt": "Start of the notice",
            "portal_link": "Link to the notice",
        },
        sample={
            "title": "Diwali holidays",
            "excerpt": "The school will be closed from 20 to 24 October.",
            "portal_link": "https://erp.example.in/notices",
        },
        defaults={
            "in_app": Default(True, "{{excerpt}}", "{{title}}"),
            "email": Default(
                True, "{{excerpt}}\n\nRead the full notice: {{portal_link}}" + SIGN, "{{school_name}}: {{title}}"
            ),
            "sms": Default(False, "{{school_name}} notice: {{title}}. Details in the app."),
            "whatsapp": Default(False, "Notice: {{title}}."),
        },
        wa_params=("title", "school_name"),
    )
)
_add(
    Event(
        key="library_overdue",
        label="Library book overdue",
        description="A library book borrowed by a student is past its due date (one message per book, from 9 am).",
        audience="Parents and the student",
        variables={
            **COMMON,
            **STUDENT,
            "book_title": "Title of the book",
            "accession_number": "Accession number of the copy",
            "due_date": "Date it was due",
            "days_overdue": "Days past the due date",
            "fine_so_far": "Fine so far",
            "portal_link": "Link to the student's library books",
        },
        sample={
            "student_name": "Aarav Verma",
            "book_title": "Swami and Friends",
            "accession_number": "ACC-000123",
            "due_date": "10 Oct 2026",
            "days_overdue": "2",
            "fine_so_far": "₹4",
            "portal_link": "https://erp.example.in/portal",
        },
        defaults={
            "in_app": Default(
                True,
                "“{{book_title}}” was due back on {{due_date}} ({{days_overdue}} days ago). Fine so far: {{fine_so_far}}.",
                "Library book overdue: {{student_name}}",
            ),
            "email": Default(
                True,
                "Dear {{recipient_name}},\n\nThe library book “{{book_title}}” ({{accession_number}}) borrowed by {{student_name}} "
                "was due back on {{due_date}}. Please return it to the school library as soon as possible.\n"
                "Fine so far: {{fine_so_far}}\n\nSee the library books in the portal: {{portal_link}}" + SIGN,
                "Library book overdue: {{book_title}}",
            ),
            "sms": Default(
                False,
                "{{school_name}}: Library book {{book_title}} borrowed by {{student_name}} was due on {{due_date}}. Please return it.",
            ),
            "whatsapp": Default(False, "Library book {{book_title}} was due on {{due_date}}."),
        },
        wa_params=("student_name", "book_title", "due_date", "school_name"),
    )
)

TEST = Event(
    key="test",
    label="Test message",
    description="Sent by an admin to check a channel.",
    audience="The admin",
    variables=dict(COMMON),
    sample={},
    defaults={
        "email": Default(
            True,
            "This is a test message. Email notifications from {{school_name}} are working." + SIGN,
            "Test message from {{school_name}}",
        ),
        "sms": Default(True, "Test message from {{school_name}}. SMS notifications are working."),
        "whatsapp": Default(True, "hello_world"),
    },
    channels=("email", "sms", "whatsapp"),
)

STATUS_LABEL = {
    "submitted": "Application received",
    "under_review": "Under review",
    "verified": "Documents verified",
    "approved": "Approved",
    "rejected": "Not approved",
    "fee_paid": "Admission fee received",
    "enrolled": "Admission complete",
}
MODE_LABEL = {
    "cash": "cash",
    "upi": "UPI",
    "bank_transfer": "bank transfer",
    "cheque": "cheque",
    "other": "other",
    "online": "online payment",
}
