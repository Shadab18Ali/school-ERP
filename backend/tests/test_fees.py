import uuid
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.schemas.fees import FeeHeadBulk, FeeItemCreate, FeeItemOut, FeeItemUpdate, FeeStructureCopy

H = uuid.uuid4()


def item(**kw):
    return FeeItemCreate(**{"fee_head_id": H, "amount": "1500", "frequency": "monthly", **kw})


def test_amount_is_exact_decimal():
    i = item(amount="1500.5")
    assert i.amount == Decimal("1500.50") and isinstance(i.amount, Decimal)


@pytest.mark.parametrize(
    "bad,msg",
    [
        ("0", "more than zero"),
        ("-5", "more than zero"),
        ("12.345", "2 decimal"),
        ("10000000.01", "too large"),
        ("NaN", "finite number"),
        ("Infinity", "finite number"),
        ("abc", "decimal"),
    ],
)
def test_bad_amounts(bad, msg):
    with pytest.raises(ValidationError, match=msg):
        item(amount=bad)


def test_money_is_serialised_as_text_not_float():
    out = FeeItemOut(
        id=uuid.uuid4(),
        fee_head_id=H,
        fee_head_name="Tuition",
        amount=Decimal("1500"),
        frequency="monthly",
        is_optional=False,
        billing_months=None,
        due_month=None,
        sort_order=0,
        occurrences=12,
        annual_amount=Decimal("18000"),
        due_months=[],
    )
    data = out.model_dump(mode="json")
    assert data["amount"] == "1500.00" and data["annual_amount"] == "18000.00"


def test_billing_months_are_sorted_and_deduplicated():
    assert item(billing_months=[12, 4, 4, 7]).billing_months == [4, 7, 12]


@pytest.mark.parametrize("months", [[], [0], [13]])
def test_bad_months(months):
    with pytest.raises(ValidationError):
        item(billing_months=months)


def test_months_only_for_monthly_and_due_month_only_for_others():
    with pytest.raises(ValidationError, match="only be chosen for monthly"):
        item(frequency="yearly", billing_months=[4])
    with pytest.raises(ValidationError, match="don't have a due month"):
        item(frequency="monthly", due_month=9)
    assert item(frequency="yearly", due_month=9).due_month == 9


def test_update_rejects_nulls_and_unknown_fields():
    with pytest.raises(ValidationError):
        FeeItemUpdate.model_validate({"amount": None})
    with pytest.raises(ValidationError):
        FeeItemUpdate.model_validate({"school_id": str(uuid.uuid4())})
    assert FeeItemUpdate.model_validate({"billing_months": None}).model_fields_set == {"billing_months"}


def test_copy_options():
    t = [{"academic_session_id": str(uuid.uuid4()), "class_id": str(uuid.uuid4())}]
    c = FeeStructureCopy(targets=t, increase_percent="8", round_to="10")
    assert c.increase_percent == Decimal("8") and c.round_to == Decimal("10")
    for bad in (
        {"round_to": "7"},
        {"increase_percent": "150"},
        {"increase_percent": "-60"},
        {"increase_percent": "1.234"},
    ):
        with pytest.raises(ValidationError):
            FeeStructureCopy(targets=t, **bad)
    with pytest.raises(ValidationError):
        FeeStructureCopy(targets=[])


def test_bulk_heads_dedupe():
    assert FeeHeadBulk(names=["Tuition Fee", "tuition  fee", "Exam Fee"]).names == ["Tuition Fee", "Exam Fee"]
