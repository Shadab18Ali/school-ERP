import asyncio
import json
from datetime import date, timedelta

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from starlette.requests import Request

from app.api.v1.routes.admissions import DOC_LABEL, DOC_MAP, FeeIn, StatusIn
from app.api.v1.routes.public_admissions import ApplicationIn, _friendly
from app.core import ratelimit

WINDOW = "00000000-0000-4000-8000-000000000001"


def form(**kw) -> dict:
    base = {
        "window_id": WINDOW,
        "student_name": "  Asha   Kumar ",
        "date_of_birth": "2020-05-05",
        "gender": "female",
        "father_name": "Ravi Kumar",
        "contact_phone": "+91 98111-00001",
        "address_line": "12 Ring Road",
        "city": "Delhi",
        "state": "Delhi",
        "postal_code": "110 024",
        "declaration": True,
    }
    return {**base, **kw}


def friendly(**kw) -> str:
    with pytest.raises(ValidationError) as exc:
        ApplicationIn.model_validate_json(json.dumps(form(**kw)))
    return _friendly(exc.value)


def test_valid_form_is_tidied():
    a = ApplicationIn.model_validate_json(json.dumps(form()))
    assert a.student_name == "Asha Kumar" and a.contact_phone == "+919811100001" and a.postal_code == "110024"


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"declaration": False}, "Please confirm that the information is correct."),
        ({"father_name": None}, "Enter the father's or the mother's name."),
        ({"postal_code": "11"}, "Enter a 6-digit PIN code."),
        ({"contact_email": "not-an-email"}, "Enter a valid email address."),
        ({"student_name": "A"}, "Enter the child's full name (2 to 150 letters)."),
        ({"contact_phone": "12"}, "Enter a valid mobile number"),
        ({"gender": "x"}, "Choose the child's gender."),
        ({"date_of_birth": str(date.today() - timedelta(days=100))}, "at least 2 years old"),
        ({"date_of_birth": "1990-01-01"}, "over 20"),
    ],
)
def test_messages_parents_understand(change, message):
    assert message in friendly(**change)


def test_unknown_fields_are_refused():
    with pytest.raises(ValidationError):
        ApplicationIn.model_validate_json(json.dumps(form(is_admin=True)))


def test_staff_inputs():
    with pytest.raises(ValidationError):
        StatusIn(status="enrolled")  # only the database moves an application to enrolled (via student creation)
    with pytest.raises(ValidationError):
        FeeIn(amount="-1", paid_on=date.today())
    with pytest.raises(ValidationError):
        FeeIn(amount="10.555", paid_on=date.today())
    assert set(DOC_MAP) == set(DOC_LABEL)
    assert DOC_MAP["previous_report_card"] == "previous_marksheet"


def _request(ip: str) -> Request:
    return Request({"type": "http", "headers": [], "client": (ip, 1234), "method": "GET", "path": "/"})


def test_rate_limit_per_client():
    ratelimit.reset()
    for _ in range(3):
        asyncio.run(ratelimit.limit(_request("1.1.1.1"), "t", 3, 60))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(ratelimit.limit(_request("1.1.1.1"), "t", 3, 60))
    assert exc.value.status_code == 429 and "Retry-After" in exc.value.headers
    asyncio.run(ratelimit.limit(_request("2.2.2.2"), "t", 3, 60))  # another client is not affected
    ratelimit.reset()


def _fwd(ip: str, xff: str) -> Request:
    return Request(
        {
            "type": "http",
            "headers": [(b"x-forwarded-for", xff.encode())],
            "client": (ip, 1),
            "method": "GET",
            "path": "/",
        }
    )


def test_client_ip_ignores_forged_forwarded_for():
    # no trusted proxy: a client can't pick its own identity with the header
    assert ratelimit.client_ip(_fwd("10.0.0.5", "6.6.6.6"), trusted_hops=0) == "10.0.0.5"
    # one trusted proxy: it appended the real client last; entries before it may be forged
    assert ratelimit.client_ip(_fwd("10.0.0.1", "6.6.6.6, 203.0.113.7"), trusted_hops=1) == "203.0.113.7"
    assert ratelimit.client_ip(_fwd("10.0.0.1", "6.6.6.6, 203.0.113.7, 10.0.0.9"), trusted_hops=2) == "203.0.113.7"
    assert ratelimit.client_ip(_request("10.0.0.1"), trusted_hops=1) == "10.0.0.1"


def test_rate_limit_forgets_quiet_clients():
    ratelimit.reset()
    asyncio.run(ratelimit.limit(_request("3.3.3.3"), "t", 3, 60))
    assert ratelimit._hits  # the hit was recorded
    ratelimit._sweep(10**12)  # far in the future: everyone has gone quiet
    assert not ratelimit._hits
