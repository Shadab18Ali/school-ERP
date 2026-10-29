import io
from datetime import date, datetime
from decimal import Decimal

import pytest
from pypdf import PdfReader

from app.schemas.collection import PaymentCreate
from app.services.receipts import (
    ReceiptData,
    ReceiptLine,
    amount_in_words,
    build_receipt_pdf,
    inr,
    number_to_words_indian,
)


@pytest.mark.parametrize(
    "n,words",
    [
        (0, "Zero"),
        (7, "Seven"),
        (19, "Nineteen"),
        (45, "Forty Five"),
        (100, "One Hundred"),
        (1500, "One Thousand Five Hundred"),
        (100000, "One Lakh"),
        (2550000, "Twenty Five Lakh Fifty Thousand"),
        (12345678, "One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight"),
    ],
)
def test_indian_number_words(n, words):
    assert number_to_words_indian(n) == words


def test_amount_in_words_with_paise():
    assert amount_in_words(Decimal("1500.50")) == "Rupees One Thousand Five Hundred and Fifty Paise Only"
    assert amount_in_words(Decimal("26000")) == "Rupees Twenty Six Thousand Only"


@pytest.mark.parametrize(
    "amount,text",
    [
        ("500", "₹500.00"),
        ("1500", "₹1,500.00"),
        ("100000", "₹1,00,000.00"),
        ("1234567.5", "₹12,34,567.50"),
    ],
)
def test_indian_grouping(amount, text):
    assert inr(Decimal(amount)) == text


def _receipt(number="VERY-LONG-SCHOOL-CODE/2026-27/000123", logo=None):
    return ReceiptData(
        "Green Valley Public School",
        "12 Ring Road, New Delhi 110025",
        "Phone 011-2345 · office@gv.in",
        "CBSE 2130456",
        logo,
        number,
        date(2026, 10, 7),
        "2026-27",
        "Aarav Sharma",
        "STU00001",
        "Class 5 – A",
        "ADM-0041",
        "Rakesh Sharma",
        [
            ReceiptLine("Tuition Fee", "Apr 2026", Decimal("1500")),
            ReceiptLine("Annual Fee", "2026-27", Decimal("2000")),
        ],
        Decimal("3500"),
        "UPI",
        "UTR123",
        "Paid by father",
        Decimal("29500"),
        "Asha",
        datetime(2026, 10, 7, 10, 0),
    )


def test_receipt_pdf_contents():
    pdf = build_receipt_pdf(_receipt())
    assert pdf.startswith(b"%PDF-")
    text = PdfReader(io.BytesIO(pdf)).pages[0].extract_text()
    for expected in (
        "VERY-LONG-SCHOOL-CODE/2026-27/000123",
        "Aarav Sharma",
        "STU00001",
        "Tuition Fee",
        "₹1,500.00",
        "₹3,500.00",
        "Three Thousand Five Hundred",
        "UTR123",
        "₹29,500.00",
        "Paid by father",
    ):
        assert expected in text, expected


def test_broken_logo_never_blocks_a_receipt():
    assert build_receipt_pdf(_receipt(logo=b"\x89PNG\r\n\x1a\nnot really")).startswith(b"%PDF-")


def test_payment_validation():
    base = {
        "idempotency_key": "11111111-1111-4111-8111-111111111111",
        "payment_date": "2026-10-01",
        "allocations": [{"due_id": "22222222-2222-4222-8222-222222222222", "amount": "100"}],
    }
    PaymentCreate(**base, payment_mode="cash")
    for mode in ("upi", "bank_transfer", "cheque"):
        with pytest.raises(ValueError, match="Enter the"):
            PaymentCreate(**base, payment_mode=mode)
    with pytest.raises(ValueError, match="future"):
        PaymentCreate(**{**base, "payment_date": "2999-01-01"}, payment_mode="cash")
    with pytest.raises(ValueError, match="twice"):
        PaymentCreate(**{**base, "allocations": base["allocations"] * 2}, payment_mode="cash")
    with pytest.raises(ValueError):
        PaymentCreate(
            **{**base, "allocations": [{"due_id": base["allocations"][0]["due_id"], "amount": "0"}]},
            payment_mode="cash",
        )
    with pytest.raises(ValueError):
        PaymentCreate(**base, payment_mode="cash", received_by="someone")  # unknown fields refused
