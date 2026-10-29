"""Library: catalogue (books, authors, categories, copies), circulation (issue, return,
renew), fines and the library dashboard.

Rules live in the database (migration 0022): copy availability, borrowing limits,
overdue and unpaid-fine blocks, fine calculation (from the rate in force when the book
was issued), who may waive. This module checks input, calls those functions and
shapes the answers. Librarians work without access to student or staff records:
borrowers are found through `library_find_borrowers`, and loans carry the borrower's
name and class from the day of issue.
"""

import re
import uuid
from datetime import date
from decimal import Decimal
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db, pg_error
from app.services.audit import write_audit
from app.services.exports import to_csv

router = APIRouter(prefix="/library", tags=["library"])
VIEW = Depends(require_permission(Permission.LIBRARY_VIEW))
MANAGE = Depends(require_permission(Permission.LIBRARY_MANAGE))
FINES = Depends(require_permission(Permission.LIBRARY_FINES))
ADMIN = Depends(require_permission(Permission.SETTINGS_MANAGE))

UNIQUE = {
    "library_books_isbn_key": "A book with this ISBN is already in the catalogue.",
    "library_categories_name_key": "A category with this name already exists.",
    "library_authors_name_key": "An author with this name already exists.",
    "library_copies_accession_key": "This accession number is already used.",
}
PAYMENT_MODES = ("cash", "upi", "card", "bank_transfer", "cheque")
PaymentMode = Literal["cash", "upi", "card", "bank_transfer", "cheque"]


def _clean(v: object) -> object:
    if isinstance(v, str):
        v = re.sub(r"\s+", " ", v).strip()
        return v or None
    return v


def isbn13(raw: str | None) -> str | None:
    """Same rules as private.isbn13: ISBN-10 or -13 (spaces/hyphens allowed) -> ISBN-13."""
    if raw is None:
        return None
    s = re.sub(r"[\s-]", "", raw).upper()
    if not s:
        return None
    if re.fullmatch(r"[0-9]{9}[0-9X]", s):
        total = sum((10 if ch == "X" else int(ch)) * (10 - i) for i, ch in enumerate(s))
        if total % 11:
            raise ValueError("That ISBN isn't valid: the check digit doesn't match.")
        s = "978" + s[:9]
        return s + str((10 - sum(int(c) * (3 if i % 2 else 1) for i, c in enumerate(s)) % 10) % 10)
    if re.fullmatch(r"97[89][0-9]{10}", s):
        if (10 - sum(int(c) * (3 if i % 2 else 1) for i, c in enumerate(s[:12])) % 10) % 10 != int(s[12]):
            raise ValueError("That ISBN isn't valid: the check digit doesn't match.")
        return s
    raise ValueError("An ISBN has 10 or 13 digits (ISBN-13 starts with 978 or 979).")


async def _call(db: AsyncSession, sql: str, params: dict[str, Any]) -> Any:
    try:
        return await db.execute(text(sql), params)
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None


# ------------------------------------------------------------------ settings
class SettingsIn(BaseModel):
    model_config = {"extra": "forbid"}
    loan_days_student: int = Field(ge=1, le=180)
    loan_days_staff: int = Field(ge=1, le=365)
    max_books_student: int = Field(ge=1, le=20)
    max_books_staff: int = Field(ge=1, le=50)
    fine_per_day: Decimal = Field(ge=0, le=1000, max_digits=6, decimal_places=2)
    grace_days: int = Field(ge=0, le=30)
    max_fine: Decimal | None = Field(default=None, gt=0, max_digits=8, decimal_places=2)
    max_renewals: int = Field(ge=0, le=5)
    block_when_overdue: bool
    block_when_fines_due: bool


SETTING_COLS = (
    "loan_days_student, loan_days_staff, max_books_student, max_books_staff, fine_per_day, grace_days, max_fine, "
    "max_renewals, block_when_overdue, block_when_fines_due"
)


async def _settings(db: AsyncSession, school: uuid.UUID) -> dict:
    r = (
        (
            await db.execute(
                text(f"select {SETTING_COLS}, updated_at from private.library_rules(:s)"),
                {"s": school},
            )
        )
        .mappings()
        .one()
    )
    configured = (
        await db.execute(
            text("select exists (select 1 from public.library_settings where school_id = :s)"), {"s": school}
        )
    ).scalar()
    return {**dict(r), "configured": configured, "updated_at": r["updated_at"].isoformat() if configured else None}


@router.get("/settings")
async def get_settings_(ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> dict:
    return await _settings(db, ctx.school_id)


@router.put("/settings")
async def save_settings(
    payload: SettingsIn,
    request: Request,
    ctx: SchoolContext = ADMIN,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    v = payload.model_dump()
    cols = list(v)
    await _call(
        db,
        f"insert into public.library_settings (school_id, {', '.join(cols)}, updated_by) "
        f"values (:school_id, {', '.join(':' + c for c in cols)}, :updated_by) on conflict (school_id) do update set "
        + ", ".join(f"{c} = excluded.{c}" for c in cols)
        + ", updated_by = excluded.updated_by",
        {**v, "school_id": ctx.school_id, "updated_by": user.id},
    )
    await write_audit(
        db,
        request,
        action="library.settings_saved",
        entity_type="school",
        entity_id=str(ctx.school_id),
        school_id=ctx.school_id,
        metadata={k: str(x) if isinstance(x, Decimal) else x for k, x in v.items()},
    )
    await db.commit()
    return await _settings(db, ctx.school_id)


# ------------------------------------------------------------------ dashboard
@router.get("/dashboard")
async def dashboard(ctx: SchoolContext = FINES, db: AsyncSession = Depends(get_db)) -> dict:
    d = (await _call(db, "select private.library_dashboard(:s)", {"s": ctx.school_id})).scalar()
    for k in ("fines_unpaid", "fines_accruing", "fines_collected_month", "fines_collected_total", "fines_waived_total"):
        d[k] = f"{Decimal(str(d[k])):.2f}"
    d["fine_per_day"] = f"{Decimal(str(d['fine_per_day'])):.2f}"
    return d


# ------------------------------------------------------------------ categories & authors
class NameIn(BaseModel):
    model_config = {"extra": "forbid"}
    name: str = Field(min_length=2, max_length=150)
    _c = field_validator("name", mode="before")(classmethod(lambda cls, v: _clean(v)))


@router.get("/categories")
async def categories(ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> list[dict]:
    rows = (
        await db.execute(
            text(
                "select c.id, c.name, (select count(*) from public.library_books b where b.category_id = c.id) "
                "as books "
                "from public.library_categories c where c.school_id = :s order by lower(c.name)"
            ),
            {"s": ctx.school_id},
        )
    ).mappings()
    return [{**dict(r), "id": str(r["id"])} for r in rows]


@router.post("/categories", status_code=status.HTTP_201_CREATED)
async def add_category(payload: NameIn, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> dict:
    if len(payload.name) > 80:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Keep the category name under 80 characters.")
    r = await _call(
        db,
        "insert into public.library_categories (school_id, name) values (:s, :n) returning id",
        {"s": ctx.school_id, "n": payload.name},
    )
    cid = r.scalar_one()
    await db.commit()
    return {"id": str(cid), "name": payload.name, "books": 0}


@router.patch("/categories/{category_id}")
async def rename_category(
    category_id: uuid.UUID, payload: NameIn, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    r = await _call(
        db,
        "update public.library_categories set name = :n where id = :id and school_id = :s",
        {"n": payload.name, "id": category_id, "s": ctx.school_id},
    )
    if r.rowcount != 1:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Category not found.")
    await db.commit()
    return {"id": str(category_id), "name": payload.name}


@router.delete("/categories/{category_id}")
async def delete_category(
    category_id: uuid.UUID, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    try:
        r = await db.execute(
            text("delete from public.library_categories where id = :id and school_id = :s"),
            {"id": category_id, "s": ctx.school_id},
        )
    except DBAPIError as exc:
        if pg_error(exc).sqlstate == "23503":
            await db.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, "Books use this category. Move them first.") from None
        raise await http_error_from_db(db, exc) from None
    if r.rowcount != 1:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Category not found.")
    await db.commit()
    return {"ok": True}


@router.get("/authors")
async def authors(
    q: str | None = Query(default=None, max_length=100), ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)
) -> list[dict]:
    rows = (
        await db.execute(
            text(
                "select a.id, a.name from public.library_authors a where a.school_id = :s "
                "and (:q = '' or lower(a.name) like '%' || :q || '%') order by lower(a.name) limit 20"
            ),
            {"s": ctx.school_id, "q": (q or "").strip().lower()},
        )
    ).mappings()
    return [{"id": str(r["id"]), "name": r["name"]} for r in rows]


# ------------------------------------------------------------------ books
class BookIn(BaseModel):
    model_config = {"extra": "forbid"}
    title: str = Field(min_length=1, max_length=300)
    subtitle: str | None = Field(default=None, max_length=300)
    isbn: str | None = Field(default=None, max_length=20)
    authors: list[str] = Field(default_factory=list, max_length=10)
    category_id: uuid.UUID | None = None
    publisher: str | None = Field(default=None, max_length=150)
    edition: str | None = Field(default=None, max_length=50)
    publication_year: int | None = Field(default=None, ge=1450, le=2100)
    language: str | None = Field(default=None, max_length=40)
    shelf_location: str | None = Field(default=None, max_length=40)
    description: str | None = Field(default=None, max_length=2000)

    _c = field_validator(
        "title", "subtitle", "isbn", "publisher", "edition", "language", "shelf_location", mode="before"
    )(classmethod(lambda cls, v: _clean(v)))

    @field_validator("description", mode="before")
    @classmethod
    def _desc(cls, v: object) -> object:
        return (v.strip() or None) if isinstance(v, str) else v

    @field_validator("isbn")
    @classmethod
    def _isbn(cls, v: str | None) -> str | None:
        return isbn13(v)

    @field_validator("authors", mode="before")
    @classmethod
    def _authors(cls, v: object) -> object:
        if not isinstance(v, list):
            return v
        out: list[str] = []
        for a in v:
            a = _clean(a)
            if a and a.lower() not in {x.lower() for x in out}:
                if not 2 <= len(a) <= 150:
                    raise ValueError("Author names are 2 to 150 characters.")
                out.append(a)
        return out


class NewBookIn(BookIn):
    copies: int = Field(default=1, ge=0, le=100)
    accession_numbers: list[str] | None = Field(default=None, max_length=100)
    price: Decimal | None = Field(default=None, ge=0, le=1000000, max_digits=9, decimal_places=2)
    acquired_on: date | None = None

    @field_validator("accession_numbers", mode="before")
    @classmethod
    def _acc(cls, v: object) -> object:
        return _accessions(v)


def _accessions(v: object) -> object:
    if isinstance(v, str):
        v = re.split(r"[,\s]+", v)
    if not isinstance(v, list):
        return v
    out = [str(x).strip() for x in v if str(x).strip()]
    if not out:
        return None
    for a in out:
        if not re.fullmatch(r"[A-Za-z0-9/_-]{1,30}", a):
            raise ValueError(f"Accession number {a!r}: use letters, digits, / _ - (up to 30).")
    if len({a.lower() for a in out}) != len(out):
        raise ValueError("The same accession number is listed twice.")
    return out


async def _set_authors(db: AsyncSession, school: uuid.UUID, book: uuid.UUID, names: list[str]) -> None:
    await db.execute(text("delete from public.library_book_authors where book_id = :b"), {"b": book})
    for pos, name in enumerate(names, start=1):
        aid = (
            await db.execute(
                text("select id from public.library_authors where school_id = :s and lower(btrim(name)) = lower(:n)"),
                {"s": school, "n": name},
            )
        ).scalar()
        if aid is None:
            aid = (
                await _call(
                    db,
                    "insert into public.library_authors (school_id, name) values (:s, :n) returning id",
                    {"s": school, "n": name},
                )
            ).scalar_one()
        await _call(
            db,
            "insert into public.library_book_authors (book_id, author_id, school_id, position) values (:b, :a, :s, :p)",
            {"b": book, "a": aid, "s": school, "p": pos},
        )


BOOK_SELECT = """
select b.id, b.title, b.subtitle, b.isbn, b.publisher, b.edition, b.publication_year, b.language, b.category_id,
       cat.name as category, b.shelf_location, b.description, b.is_active, b.created_at,
       coalesce((select array_agg(a.name order by ba.position) from public.library_book_authors ba
                 join public.library_authors a on a.id = ba.author_id where ba.book_id = b.id), '{}') as authors,
       (select count(*) from public.library_copies c where c.book_id = b.id and c.status <> 'withdrawn') as copies,
       (select count(*) from public.library_copies c where c.book_id = b.id and c.status = 'available') as available,
       (select count(*) from public.library_copies c where c.book_id = b.id and c.status = 'issued') as issued
from public.library_books b left join public.library_categories cat on cat.id = b.category_id
"""


def _book(r: Any) -> dict:
    d = dict(r)
    d["id"] = str(d["id"])
    d["category_id"] = str(d["category_id"]) if d["category_id"] else None
    d["authors"] = list(d["authors"] or [])
    d["created_at"] = d["created_at"].isoformat()
    return d


@router.get("/books")
async def books(
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
    q: str | None = Query(default=None, max_length=100),
    category_id: uuid.UUID | None = None,
    availability: Literal["all", "available", "out"] = "all",
    include_withdrawn: bool = False,
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict:
    where = ["b.school_id = :s"]
    p: dict[str, Any] = {"s": ctx.school_id}
    if not include_withdrawn:
        where.append("b.is_active")
    if category_id:
        where.append("b.category_id = :c")
        p["c"] = category_id
    term = (q or "").strip()
    if term:
        p["q"] = term.lower()
        try:
            p["isbn"] = isbn13(term)
        except ValueError:
            p["isbn"] = None
        where.append(
            "(lower(b.title) like '%' || :q || '%' or lower(coalesce(b.subtitle, '')) like '%' || :q || '%' "
            "or b.isbn = :isbn or exists (select 1 from public.library_book_authors ba join public.library_authors a "
            "on a.id = ba.author_id where ba.book_id = b.id and lower(a.name) like '%' || :q || '%') "
            "or exists (select 1 from public.library_copies c where c.book_id = b.id and "
            "lower(c.accession_number) = :q))"
        )
    if availability == "available":
        where.append("exists (select 1 from public.library_copies c where c.book_id = b.id and c.status = 'available')")
    elif availability == "out":
        where.append(
            "exists (select 1 from public.library_copies c where c.book_id = b.id and c.status <> 'withdrawn') "
            "and not exists (select 1 from public.library_copies c where c.book_id = b.id and c.status = 'available')"
        )
    w = " and ".join(where)
    total = (await db.execute(text(f"select count(*) from public.library_books b where {w}"), p)).scalar_one()
    rows = (
        await db.execute(
            text(f"{BOOK_SELECT} where {w} order by lower(b.title), b.id limit :lim offset :off"),
            {**p, "lim": page_size, "off": (page - 1) * page_size},
        )
    ).mappings()
    return {"items": [_book(r) for r in rows], "total": total, "page": page, "page_size": page_size}


async def _book_detail(db: AsyncSession, ctx: SchoolContext, book_id: uuid.UUID) -> dict:
    r = (
        (
            await db.execute(
                text(f"{BOOK_SELECT} where b.id = :id and b.school_id = :s"), {"id": book_id, "s": ctx.school_id}
            )
        )
        .mappings()
        .first()
    )
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Book not found.")
    out = _book(r)
    manage = ctx.can(Permission.LIBRARY_MANAGE)
    copies = (
        await db.execute(
            text(
                "select c.id, c.accession_number, c.status, c.price, c.acquired_on, c.note, "
                "l.id as loan_id, l.borrower_name, l.borrower_class, l.due_date, "
                "(select count(*) from public.library_loans x where x.copy_id = c.id) as times_issued "
                "from public.library_copies c left join public.library_loans l on l.copy_id = c.id and "
                "l.returned_on is null "
                "where c.book_id = :b order by c.status = 'withdrawn', lower(c.accession_number)"
            ),
            {"b": book_id},
        )
    ).mappings()
    out["copy_list"] = [
        {
            "id": str(c["id"]),
            "accession_number": c["accession_number"],
            "status": c["status"],
            "price": f"{c['price']:.2f}" if c["price"] is not None else None,
            "acquired_on": c["acquired_on"].isoformat() if c["acquired_on"] else None,
            "note": c["note"],
            "times_issued": c["times_issued"],
            # who has it: library staff only (RLS hides other people's loans anyway)
            "loan": {
                "id": str(c["loan_id"]),
                "borrower_name": c["borrower_name"],
                "borrower_class": c["borrower_class"],
                "due_date": c["due_date"].isoformat(),
            }
            if c["loan_id"] and manage
            else None,
        }
        for c in copies
    ]
    out["can_manage"] = manage
    return out


@router.get("/books/{book_id}")
async def book(book_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> dict:
    return await _book_detail(db, ctx, book_id)


@router.post("/books", status_code=status.HTTP_201_CREATED)
async def add_book(
    payload: NewBookIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if payload.acquired_on and payload.acquired_on > date.today():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The date acquired can't be in the future.")
    v = payload.model_dump(exclude={"authors", "copies", "accession_numbers", "price", "acquired_on"})
    cols = list(v)
    book_id = (
        await _call(
            db,
            f"insert into public.library_books (school_id, {', '.join(cols)}, created_by) "
            f"values (:school_id, {', '.join(':' + c for c in cols)}, :by) returning id",
            {**v, "school_id": ctx.school_id, "by": user.id},
        )
    ).scalar_one()
    await _set_authors(db, ctx.school_id, book_id, payload.authors)
    if payload.accession_numbers or payload.copies:
        await _call(
            db,
            "select private.library_add_copies(:b, :n, cast(:acc as text[]), :price, :acq)",
            {
                "b": book_id,
                "n": payload.copies,
                "acc": payload.accession_numbers,
                "price": payload.price,
                "acq": payload.acquired_on,
            },
        )
    await write_audit(
        db,
        request,
        action="library.book_added",
        entity_type="library_book",
        entity_id=str(book_id),
        school_id=ctx.school_id,
        metadata={"title": payload.title, "isbn": payload.isbn},
    )
    await db.commit()
    return await _book_detail(db, ctx, book_id)


class BookUpdate(BookIn):
    is_active: bool = True


@router.put("/books/{book_id}")
async def update_book(
    book_id: uuid.UUID, payload: BookUpdate, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    v = payload.model_dump(exclude={"authors"})
    r = await _call(
        db,
        "update public.library_books set "
        + ", ".join(f"{c} = :{c}" for c in v)
        + " where id = :id and school_id = :school_id",
        {**v, "id": book_id, "school_id": ctx.school_id},
    )
    if r.rowcount != 1:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Book not found.")
    await _set_authors(db, ctx.school_id, book_id, payload.authors)
    await db.commit()
    return await _book_detail(db, ctx, book_id)


@router.delete("/books/{book_id}")
async def delete_book(book_id: uuid.UUID, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> dict:
    try:
        r = await db.execute(
            text("delete from public.library_books where id = :id and school_id = :s"),
            {"id": book_id, "s": ctx.school_id},
        )
    except DBAPIError as exc:
        if pg_error(exc).sqlstate == "23503":
            await db.rollback()
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "This book has copies, so it is kept for the borrowing history. Withdraw it from the catalogue "
                "instead.",
            ) from None
        raise await http_error_from_db(db, exc) from None
    if r.rowcount != 1:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Book not found.")
    await db.commit()
    return {"ok": True}


# ------------------------------------------------------------------ copies
class CopiesIn(BaseModel):
    model_config = {"extra": "forbid"}
    count: int = Field(default=1, ge=0, le=100)
    accession_numbers: list[str] | None = Field(default=None, max_length=100)
    price: Decimal | None = Field(default=None, ge=0, le=1000000, max_digits=9, decimal_places=2)
    acquired_on: date | None = None

    @field_validator("accession_numbers", mode="before")
    @classmethod
    def _acc(cls, v: object) -> object:
        return _accessions(v)

    @model_validator(mode="after")
    def _some(self) -> "CopiesIn":
        if not self.accession_numbers and self.count < 1:
            raise ValueError("Add at least one copy.")
        return self


@router.post("/books/{book_id}/copies", status_code=status.HTTP_201_CREATED)
async def add_copies(
    book_id: uuid.UUID, payload: CopiesIn, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    await _book_detail(db, ctx, book_id)  # 404 for another school's book
    await _call(
        db,
        "select private.library_add_copies(:b, :n, cast(:acc as text[]), :price, :acq)",
        {
            "b": book_id,
            "n": payload.count,
            "acc": payload.accession_numbers,
            "price": payload.price,
            "acq": payload.acquired_on,
        },
    )
    await db.commit()
    return await _book_detail(db, ctx, book_id)


class CopyUpdate(BaseModel):
    model_config = {"extra": "forbid"}
    accession_number: str = Field(pattern=r"^[A-Za-z0-9/_-]{1,30}$")
    price: Decimal | None = Field(default=None, ge=0, le=1000000, max_digits=9, decimal_places=2)
    acquired_on: date | None = None
    note: str | None = Field(default=None, max_length=300)
    _c = field_validator("accession_number", "note", mode="before")(classmethod(lambda cls, v: _clean(v)))


async def _copy_book(db: AsyncSession, ctx: SchoolContext, copy_id: uuid.UUID) -> uuid.UUID:
    b = (
        await db.execute(
            text("select book_id from public.library_copies where id = :id and school_id = :s"),
            {"id": copy_id, "s": ctx.school_id},
        )
    ).scalar()
    if b is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Copy not found.")
    return b


@router.patch("/copies/{copy_id}")
async def update_copy(
    copy_id: uuid.UUID, payload: CopyUpdate, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    book_id = await _copy_book(db, ctx, copy_id)
    if payload.acquired_on and payload.acquired_on > date.today():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The date acquired can't be in the future.")
    await _call(
        db,
        "update public.library_copies set accession_number = :a, price = :p, acquired_on = :d, note = :n where "
        "id = :id",
        {"a": payload.accession_number, "p": payload.price, "d": payload.acquired_on, "n": payload.note, "id": copy_id},
    )
    await db.commit()
    return await _book_detail(db, ctx, book_id)


class CopyStatusIn(BaseModel):
    model_config = {"extra": "forbid"}
    status: Literal["available", "damaged", "lost", "withdrawn"]
    note: str | None = Field(default=None, max_length=300)


@router.post("/copies/{copy_id}/status")
async def copy_status(
    copy_id: uuid.UUID,
    payload: CopyStatusIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> dict:
    book_id = await _copy_book(db, ctx, copy_id)
    await _call(
        db,
        "select private.library_set_copy_status(:c, :st, :n)",
        {"c": copy_id, "st": payload.status, "n": _clean(payload.note)},
    )
    await write_audit(
        db,
        request,
        action="library.copy_status",
        entity_type="library_copy",
        entity_id=str(copy_id),
        school_id=ctx.school_id,
        metadata={"status": payload.status, "note": payload.note},
    )
    await db.commit()
    return await _book_detail(db, ctx, book_id)


@router.delete("/copies/{copy_id}")
async def delete_copy(copy_id: uuid.UUID, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> dict:
    book_id = await _copy_book(db, ctx, copy_id)
    try:
        await db.execute(text("delete from public.library_copies where id = :id"), {"id": copy_id})
    except DBAPIError as exc:
        if pg_error(exc).sqlstate == "23503":
            await db.rollback()
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "This copy has been issued before, so it is kept for the history. Mark it withdrawn instead.",
            ) from None
        raise await http_error_from_db(db, exc) from None
    await db.commit()
    return await _book_detail(db, ctx, book_id)


@router.get("/copies/lookup")
async def lookup_copy(
    accession: str = Query(min_length=1, max_length=30), ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    """The issue/return desk: a copy by accession number, with its book and current loan."""
    r = (
        (
            await db.execute(
                text(
                    "select c.id, c.accession_number, c.status, c.price, b.id as book_id, b.title, b.is_active, "
                    "coalesce((select string_agg(a.name, ', ' order by ba.position) from "
                    "public.library_book_authors ba "
                    " join public.library_authors a on a.id = ba.author_id where ba.book_id = b.id), '') as authors, "
                    "l.id as loan_id "
                    "from public.library_copies c join public.library_books b on b.id = c.book_id "
                    "left join public.library_loans l on l.copy_id = c.id and l.returned_on is null "
                    "where c.school_id = :s and lower(c.accession_number) = lower(:a)"
                ),
                {"s": ctx.school_id, "a": accession.strip()},
            )
        )
        .mappings()
        .first()
    )
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No copy with accession number {accession.strip()}.")
    loan = await _loan(db, ctx, r["loan_id"]) if r["loan_id"] else None
    return {
        "id": str(r["id"]),
        "accession_number": r["accession_number"],
        "status": r["status"],
        "price": f"{r['price']:.2f}" if r["price"] is not None else None,
        "book_id": str(r["book_id"]),
        "title": r["title"],
        "authors": r["authors"],
        "book_active": r["is_active"],
        "loan": loan,
    }


# ------------------------------------------------------------------ borrowers
def _borrower(r: Any) -> dict:
    d = dict(r)
    d["id"] = str(d["id"])
    d["fines_due"] = f"{d['fines_due']:.2f}"
    return d


@router.get("/borrowers")
async def find_borrowers(
    q: str = Query(min_length=2, max_length=100), ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> list[dict]:
    rows = (
        await _call(db, "select * from private.library_find_borrowers(:s, :q)", {"s": ctx.school_id, "q": q})
    ).mappings()
    return [_borrower(r) for r in rows]


@router.get("/borrowers/{kind}/{borrower_id}")
async def borrower(
    kind: Literal["student", "staff"],
    borrower_id: uuid.UUID,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> dict:
    r = (
        (
            await _call(
                db,
                "select * from private.library_borrower(:s, :k, :id)",
                {"s": ctx.school_id, "k": kind, "id": borrower_id},
            )
        )
        .mappings()
        .first()
    )
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Borrower not found.")
    rules = await _settings(db, ctx.school_id)
    out = _borrower(r)
    blocks = []
    if not r["is_active"] or (kind == "student" and not r["detail"]):
        blocks.append("Not an active student of the current session." if kind == "student" else "Not active staff.")
    if r["open_loans"] >= r["max_books"]:
        blocks.append(f"Has {r['open_loans']} book(s) out; the limit is {r['max_books']}.")
    if rules["block_when_overdue"] and r["overdue"]:
        blocks.append("Has an overdue book.")
    col = "student_id" if kind == "student" else "teacher_id"
    unpaid = (
        await db.execute(
            text(f"select exists (select 1 from public.library_loans where {col} = :id and fine_status = 'unpaid')"),
            {"id": borrower_id},
        )
    ).scalar()
    if rules["block_when_fines_due"] and unpaid:
        blocks.append("Has an unpaid library fine.")
    out["blocked"] = blocks
    out["history"] = (await _loans(db, ctx, **{col: borrower_id}, page_size=100))["items"]
    return out


# ------------------------------------------------------------------ loans
LOAN_SELECT = """
select l.id, l.copy_id, c.accession_number, l.book_id, b.title, l.student_id, l.teacher_id, l.borrower_name,
       l.borrower_code,
       l.borrower_class, l.issued_on, l.due_date, l.returned_on, l.return_condition, l.renewals,
       l.fine_per_day, l.grace_days,
       l.max_fine, l.fine_amount, l.book_charge, l.fine_status, l.fine_paid_amount, l.fine_paid_at, l.fine_payment_mode,
       l.fine_reference, l.fine_receipt_number, l.fine_waived_at, l.fine_waive_reason, l.note,
       private.library_loan_due(l) as amount_due, private.ist_today() as today,
       pi.full_name as issued_by_name, pr.full_name as returned_by_name
from public.library_loans l
join public.library_copies c on c.id = l.copy_id
join public.library_books b on b.id = l.book_id
left join public.profiles pi on pi.id = l.issued_by
left join public.profiles pr on pr.id = l.returned_by
"""


def _loan_out(r: Any) -> dict:
    d = dict(r)
    today: date = d.pop("today")
    for k in ("id", "copy_id", "book_id", "student_id", "teacher_id"):
        d[k] = str(d[k]) if d[k] else None
    for k in ("issued_on", "due_date", "returned_on"):
        d[k] = d[k].isoformat() if d[k] else None
    for k in ("fine_paid_at", "fine_waived_at"):
        d[k] = d[k].isoformat() if d[k] else None
    for k in ("fine_per_day", "max_fine", "fine_amount", "book_charge", "fine_paid_amount", "amount_due"):
        d[k] = f"{d[k]:.2f}" if d[k] is not None else None
    due = date.fromisoformat(d["due_date"])
    d["is_open"] = d["returned_on"] is None
    d["days_overdue"] = (
        max(0, (today - due).days) if d["is_open"] else max(0, (date.fromisoformat(d["returned_on"]) - due).days)
    )
    d["is_overdue"] = d["is_open"] and today > due
    d["borrower_kind"] = "student" if d["student_id"] else "staff"
    return d


async def _loan(db: AsyncSession, ctx: SchoolContext, loan_id: uuid.UUID) -> dict:
    r = (
        (
            await db.execute(
                text(f"{LOAN_SELECT} where l.id = :id and l.school_id = :s"), {"id": loan_id, "s": ctx.school_id}
            )
        )
        .mappings()
        .first()
    )
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Loan not found.")
    return _loan_out(r)


LoanFilter = Literal["open", "overdue", "returned", "fines_unpaid", "fines_settled", "all"]


async def _loans(
    db: AsyncSession,
    ctx: SchoolContext,
    *,
    state: LoanFilter = "all",
    q: str | None = None,
    student_id: uuid.UUID | None = None,
    teacher_id: uuid.UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    page: int = 1,
    page_size: int = 25,
) -> dict:
    where = ["l.school_id = :s"]
    p: dict[str, Any] = {"s": ctx.school_id}
    where.append(
        {
            "open": "l.returned_on is null",
            "overdue": "l.returned_on is null and l.due_date < private.ist_today()",
            "returned": "l.returned_on is not null",
            "fines_unpaid": "l.fine_status = 'unpaid'",
            "fines_settled": "l.fine_status in ('paid', 'waived')",
            "all": "true",
        }[state]
    )
    if student_id:
        where.append("l.student_id = :st")
        p["st"] = student_id
    if teacher_id:
        where.append("l.teacher_id = :te")
        p["te"] = teacher_id
    if date_from:
        where.append("l.issued_on >= :df")
        p["df"] = date_from
    if date_to:
        where.append("l.issued_on <= :dt")
        p["dt"] = date_to
    if q and q.strip():
        p["q"] = q.strip().lower()
        where.append(
            "(lower(l.borrower_name) like '%' || :q || '%' or lower(coalesce(l.borrower_code, '')) = :q "
            "or lower(b.title) like '%' || :q || '%' or lower(c.accession_number) = :q "
            "or lower(coalesce(l.fine_receipt_number, '')) = :q)"
        )
    w = " and ".join(where)
    total = (
        await db.execute(
            text(
                "select count(*) from public.library_loans l join public.library_copies c on c.id = l.copy_id "
                f"join public.library_books b on b.id = l.book_id where {w}"
            ),
            p,
        )
    ).scalar_one()
    order = (
        "l.due_date, l.id"
        if state in ("open", "overdue")
        else "coalesce(l.returned_on, l.issued_on) desc, l.issued_on desc, l.id"
    )
    rows = (
        await db.execute(
            text(f"{LOAN_SELECT} where {w} order by {order} limit :lim offset :off"),
            {**p, "lim": page_size, "off": (page - 1) * page_size},
        )
    ).mappings()
    return {"items": [_loan_out(r) for r in rows], "total": total, "page": page, "page_size": page_size}


LOAN_CSV = [
    ("title", "Book", "text"),
    ("accession_number", "Accession no.", "text"),
    ("borrower_name", "Borrower", "text"),
    ("borrower_code", "ID", "text"),
    ("borrower_class", "Class", "text"),
    ("issued_on", "Issued", "date"),
    ("due_date", "Due", "date"),
    ("returned_on", "Returned", "date"),
    ("return_condition", "Condition", "text"),
    ("days_overdue", "Days late", "int"),
    ("fine_amount", "Fine", "money"),
    ("book_charge", "Book charge", "money"),
    ("amount_due", "Still to pay", "money"),
    ("fine_status", "Fine status", "text"),
    ("fine_receipt_number", "Fine receipt", "text"),
]


@router.get("/loans")
async def loans(
    ctx: SchoolContext = FINES,
    db: AsyncSession = Depends(get_db),
    state: LoanFilter = "open",
    q: str | None = Query(default=None, max_length=100),
    date_from: date | None = None,
    date_to: date | None = None,
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=25, ge=1, le=100),
    format: Literal["json", "csv"] = "json",
) -> Any:
    if format == "csv":
        data = await _loans(db, ctx, state=state, q=q, date_from=date_from, date_to=date_to, page_size=5000)
        return Response(
            to_csv(LOAN_CSV, data["items"]),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="library-loans-{state}.csv"'},
        )
    return await _loans(db, ctx, state=state, q=q, date_from=date_from, date_to=date_to, page=page, page_size=page_size)


@router.get("/loans/{loan_id}")
async def loan(loan_id: uuid.UUID, ctx: SchoolContext = FINES, db: AsyncSession = Depends(get_db)) -> dict:
    return await _loan(db, ctx, loan_id)


class IssueIn(BaseModel):
    model_config = {"extra": "forbid"}
    copy_id: uuid.UUID | None = None
    accession_number: str | None = Field(default=None, max_length=30)
    student_id: uuid.UUID | None = None
    teacher_id: uuid.UUID | None = None
    due_date: date | None = None

    @model_validator(mode="after")
    def _check(self) -> "IssueIn":
        if not (self.copy_id or (self.accession_number or "").strip()):
            raise ValueError("Choose the copy (accession number).")
        if (self.student_id is None) == (self.teacher_id is None):
            raise ValueError("Choose one borrower: a student or a staff member.")
        return self


@router.post("/loans", status_code=status.HTTP_201_CREATED)
async def issue(payload: IssueIn, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> dict:
    copy_id = payload.copy_id
    if copy_id is None:
        copy_id = (
            await db.execute(
                text(
                    "select id from public.library_copies where school_id = :s and lower(accession_number) = lower(:a)"
                ),
                {"s": ctx.school_id, "a": (payload.accession_number or "").strip()},
            )
        ).scalar()
        if copy_id is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"No copy with accession number {payload.accession_number}.")
    loan_id = (
        await _call(
            db,
            "select private.library_issue(:c, :st, :te, :due)",
            {"c": copy_id, "st": payload.student_id, "te": payload.teacher_id, "due": payload.due_date},
        )
    ).scalar_one()
    await db.commit()
    return await _loan(db, ctx, loan_id)


class ReturnIn(BaseModel):
    model_config = {"extra": "forbid"}
    condition: Literal["good", "damaged", "lost"] = "good"
    returned_on: date | None = None
    charge: Decimal | None = Field(default=None, ge=0, le=1000000, max_digits=9, decimal_places=2)
    note: str | None = Field(default=None, max_length=300)


@router.post("/loans/{loan_id}/return")
async def return_book(
    loan_id: uuid.UUID, payload: ReturnIn, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    await _loan(db, ctx, loan_id)
    await _call(
        db,
        "select 1 from private.library_return(:l, :c, :on, :ch, :n)",
        {
            "l": loan_id,
            "c": payload.condition,
            "on": payload.returned_on,
            "ch": payload.charge,
            "n": _clean(payload.note),
        },
    )
    await db.commit()
    return await _loan(db, ctx, loan_id)


@router.post("/loans/{loan_id}/renew")
async def renew(loan_id: uuid.UUID, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> dict:
    await _loan(db, ctx, loan_id)
    await _call(db, "select private.library_renew(:l)", {"l": loan_id})
    await db.commit()
    return await _loan(db, ctx, loan_id)


class CollectIn(BaseModel):
    model_config = {"extra": "forbid"}
    mode: PaymentMode
    reference: str | None = Field(default=None, max_length=60)
    _c = field_validator("reference", mode="before")(classmethod(lambda cls, v: _clean(v)))


@router.post("/loans/{loan_id}/collect")
async def collect_fine(
    loan_id: uuid.UUID,
    payload: CollectIn,
    request: Request,
    ctx: SchoolContext = FINES,
    db: AsyncSession = Depends(get_db),
) -> dict:
    before = await _loan(db, ctx, loan_id)
    receipt = (
        await _call(
            db,
            "select private.library_collect_fine(:l, :m, :r)",
            {"l": loan_id, "m": payload.mode, "r": payload.reference},
        )
    ).scalar_one()
    await write_audit(
        db,
        request,
        action="library.fine_collected",
        entity_type="library_loan",
        entity_id=str(loan_id),
        school_id=ctx.school_id,
        metadata={"amount": before["amount_due"], "mode": payload.mode, "receipt": receipt},
    )
    await db.commit()
    return await _loan(db, ctx, loan_id)


class WaiveIn(BaseModel):
    model_config = {"extra": "forbid"}
    reason: str = Field(min_length=3, max_length=300)
    _c = field_validator("reason", mode="before")(classmethod(lambda cls, v: _clean(v)))


@router.post("/loans/{loan_id}/waive")
async def waive_fine(
    loan_id: uuid.UUID,
    payload: WaiveIn,
    request: Request,
    ctx: SchoolContext = FINES,
    db: AsyncSession = Depends(get_db),
) -> dict:
    before = await _loan(db, ctx, loan_id)
    await _call(db, "select private.library_waive_fine(:l, :r)", {"l": loan_id, "r": payload.reason})
    await write_audit(
        db,
        request,
        action="library.fine_waived",
        entity_type="library_loan",
        entity_id=str(loan_id),
        school_id=ctx.school_id,
        metadata={"amount": before["amount_due"], "reason": payload.reason},
    )
    await db.commit()
    return await _loan(db, ctx, loan_id)


# ------------------------------------------------------------------ own loans (staff)
@router.get("/my-loans")
async def my_loans(ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> dict:
    """A staff member's own books (RLS: a teacher sees only loans to their own staff record)."""
    teacher = (await db.execute(text("select private.current_teacher_id(:s)"), {"s": ctx.school_id})).scalar()
    if teacher is None:
        return {"items": [], "total": 0, "page": 1, "page_size": 100, "has_record": False}
    return {**(await _loans(db, ctx, teacher_id=teacher, page_size=100)), "has_record": True}


# ------------------------------------------------------------------ families (parent and student portals)
async def student_library(db: AsyncSession, ctx: SchoolContext, student_id: uuid.UUID) -> dict:
    """Called after the portal has checked the parent/student link; RLS limits it again."""
    data = await _loans(db, ctx, student_id=student_id, page_size=100)
    items = data["items"]
    rules = await _settings(db, ctx.school_id)
    return {
        "current": [i for i in items if i["is_open"]],
        "history": [i for i in items if not i["is_open"]],
        "amount_due": f"{sum(Decimal(i['amount_due']) for i in items):.2f}",
        "rules": {
            k: (f"{rules[k]:.2f}" if isinstance(rules[k], Decimal) else rules[k])
            for k in ("loan_days_student", "max_books_student", "fine_per_day", "grace_days", "max_fine")
        },
    }
