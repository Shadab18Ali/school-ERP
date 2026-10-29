import re
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.api.v1.routes.inventory import (
    CATEGORIES,
    CATEGORY_LABEL,
    IN_REASONS,
    OUT_REASONS,
    REASON_LABEL,
    ItemIn,
    StockIn,
    _qty,
    today,
)

MIGRATION = (Path(__file__).resolve().parents[2] / "supabase" / "migrations" / "0024_inventory.sql").read_text()
STAFF = "00000000-0000-4000-8000-000000000001"


def _db_list(pattern: str) -> set[str]:
    m = re.search(pattern, MIGRATION)
    assert m, pattern
    return set(re.findall(r"'([a-z_]+)'", m.group(1)))


# ---------------------------------------------------------------- the API and the database agree
def test_lists_match_the_database():
    assert set(CATEGORIES) == _db_list(r"category\s+text not null check \(category in \(([^)]*)\)")
    assert set(IN_REASONS) == _db_list(r"kind = 'in' and reason in \(([^)]*)\)")
    assert set(OUT_REASONS) == _db_list(r"kind = 'out' and reason in \(([^)]*)\)")
    assert set(CATEGORIES) == {"computer", "furniture", "laboratory", "sports", "stationery", "electronics", "other"}
    assert all(c in CATEGORY_LABEL for c in CATEGORIES)
    assert all(r in REASON_LABEL for r in (*IN_REASONS, *OUT_REASONS))


# ---------------------------------------------------------------- quantities
def test_quantities():
    assert _qty(Decimal("3"), "piece") == Decimal("3")
    assert _qty(Decimal("2.5"), "kg") == Decimal("2.5")
    with pytest.raises(ValueError, match="whole number"):
        _qty(Decimal("2.5"), "ream")
    with pytest.raises(ValueError, match="2 decimal"):
        _qty(Decimal("1.234"), "litre")
    assert _qty(None) is None


# ---------------------------------------------------------------- items
def test_item_input():
    it = ItemIn(name="  Desktop   computer ", category="computer", location=" Computer Lab ", min_quantity="2")
    assert (
        it.name == "Desktop computer"
        and it.location == "Computer Lab"
        and it.unit == "piece"
        and it.condition == "good"
    )
    assert "opening" not in it.fields() and "is_active" not in it.fields()
    for bad in (
        {"category": "space"},
        {"condition": "broken"},
        {"unit": "gallon"},
        {"location": ""},
        {"name": "x"},
        {"unit_cost": "-1"},
        {"unit_cost": "10.555"},
        {"min_quantity": "1.5"},  # counted in pieces
    ):
        with pytest.raises(ValidationError):
            ItemIn(**{"name": "Chair", "category": "furniture", "location": "Hall", **bad})


def test_opening_stock():
    it = ItemIn(
        name="A4 paper",
        category="stationery",
        unit="ream",
        location="Store",
        opening={"quantity": "30", "reason": "purchase", "moved_on": today(), "unit_cost": "250"},
    )
    assert it.opening and it.opening.quantity == 30 and it.opening.reason == "purchase"
    with pytest.raises(ValidationError, match="whole number"):
        ItemIn(
            name="A4",
            category="stationery",
            unit="ream",
            location="S",
            opening={"quantity": "1.5", "moved_on": today()},
        )
    with pytest.raises(ValidationError, match="future"):
        ItemIn(
            name="A4",
            category="stationery",
            location="S",
            opening={"quantity": "1", "moved_on": today() + timedelta(days=1)},
        )
    with pytest.raises(ValidationError):
        ItemIn(
            name="A4",
            category="stationery",
            location="S",
            opening={"quantity": "1", "moved_on": today(), "reason": "issued"},
        )
    with pytest.raises(ValidationError, match="future"):
        ItemIn(name="A4", category="stationery", location="S", purchase_date=today() + timedelta(days=2))


# ---------------------------------------------------------------- stock in / out
def test_stock_movements():
    s = StockIn(kind="in", reason="purchase", quantity="5", moved_on=today(), unit_cost="100", vendor=" Shop ")
    assert s.vendor == "Shop" and s.unit_cost == 100
    out = StockIn(
        kind="out", reason="consumed", quantity="2", moved_on=today(), unit_cost="9", vendor="x", recipient="Exam cell"
    )
    assert out.unit_cost is None and out.vendor is None  # cost and vendor belong to stock in
    with pytest.raises(ValidationError, match="reason"):
        StockIn(kind="in", reason="issued", quantity="1", moved_on=today())
    with pytest.raises(ValidationError, match="reason"):
        StockIn(kind="out", reason="purchase", quantity="1", moved_on=today())
    with pytest.raises(ValidationError, match="issued to"):
        StockIn(kind="out", reason="issued", quantity="1", moved_on=today())
    assert StockIn(kind="out", reason="issued", quantity="1", moved_on=today(), teacher_id=STAFF).teacher_id
    assert (
        StockIn(kind="out", reason="issued", quantity="1", moved_on=today(), recipient="Class 5-A").recipient
        == "Class 5-A"
    )
    for bad in ({"quantity": "0"}, {"quantity": "-3"}, {"kind": "change"}):
        with pytest.raises(ValidationError):
            StockIn(**{"kind": "in", "reason": "found", "quantity": "1", "moved_on": today(), **bad})
