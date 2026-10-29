"""Student documents. School admins only; files never leave through URLs.

Every read goes through this API: it checks the caller's token, their
permission in the active school, and that the document belongs to that
school's student, then streams the bytes from the private bucket.
"""

import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.models.core import Profile
from app.models.students import Student, StudentDocument
from app.schemas.documents import DocumentOut, DocumentType, DocumentUpdate, clean_title
from app.services import storage
from app.services.audit import write_audit
from app.services.documents import MAX_DOCUMENT_BYTES, DocumentError, clean_document, content_disposition, safe_filename

router = APIRouter(prefix="/students/{student_id}/documents", tags=["student-documents"])
VIEW = Depends(require_permission(Permission.DOCUMENTS_VIEW))
MANAGE = Depends(require_permission(Permission.DOCUMENTS_MANAGE))
MAX_PER_STUDENT = 50


async def _student(db: AsyncSession, ctx: SchoolContext, student_id: uuid.UUID) -> Student:
    s = await db.scalar(select(Student).where(Student.id == student_id, Student.school_id == ctx.school_id))
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Student not found.")
    return s


async def _document(db: AsyncSession, ctx: SchoolContext, student_id: uuid.UUID, doc_id: uuid.UUID) -> StudentDocument:
    d = await db.scalar(
        select(StudentDocument).where(
            StudentDocument.id == doc_id,
            StudentDocument.student_id == student_id,
            StudentDocument.school_id == ctx.school_id,
        )
    )
    if d is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found.")
    return d


def _out(d: StudentDocument, uploader: str | None) -> DocumentOut:
    return DocumentOut(
        id=d.id,
        document_type=d.document_type,
        title=d.title,
        file_name=d.file_name,
        mime_type=d.mime_type,
        size_bytes=d.size_bytes,
        uploaded_at=d.created_at,
        uploaded_by_name=uploader,
    )


async def _uploader_name(db: AsyncSession, user_id: uuid.UUID | None) -> str | None:
    if user_id is None:
        return None
    return await db.scalar(select(Profile.full_name).where(Profile.id == user_id)) or None


@router.get("", response_model=list[DocumentOut])
async def list_documents(
    student_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)
) -> list[DocumentOut]:
    await _student(db, ctx, student_id)
    rows = await db.execute(
        select(StudentDocument, Profile.full_name)
        .outerjoin(Profile, Profile.id == StudentDocument.uploaded_by)
        .where(StudentDocument.student_id == student_id, StudentDocument.school_id == ctx.school_id)
        .order_by(StudentDocument.created_at.desc())
    )
    return [_out(d, name or None) for d, name in rows.all()]


@router.post("", response_model=DocumentOut, status_code=status.HTTP_201_CREATED)
async def upload_document(
    student_id: uuid.UUID,
    request: Request,
    file: UploadFile = File(...),
    document_type: DocumentType = Form(...),
    title: str | None = Form(default=None, max_length=120),
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DocumentOut:
    await _student(db, ctx, student_id)
    title = clean_title(title)  # type: ignore[assignment]
    if document_type == "other" and not title:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Describe the document (e.g. Medical certificate).")
    existing = await db.scalar(
        select(func.count())
        .select_from(StudentDocument)
        .where(StudentDocument.student_id == student_id, StudentDocument.school_id == ctx.school_id)
    )
    if (existing or 0) >= MAX_PER_STUDENT:
        raise HTTPException(status.HTTP_409_CONFLICT, f"A student can have at most {MAX_PER_STUDENT} documents.")

    data = await file.read(MAX_DOCUMENT_BYTES + 1)
    try:
        clean = await run_in_threadpool(clean_document, data)
    except DocumentError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from None

    doc_id = uuid.uuid4()
    path = f"{ctx.school_id}/{student_id}/{doc_id.hex}.{clean.extension}"
    try:
        await storage.upload(storage.DOCUMENT_BUCKET, path, clean.data, clean.mime_type)
    except storage.StorageError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None

    d = StudentDocument(
        id=doc_id,
        school_id=ctx.school_id,
        student_id=student_id,
        document_type=document_type,
        title=title,
        file_path=path,
        file_name=safe_filename(file.filename, clean.extension),
        mime_type=clean.mime_type,
        size_bytes=len(clean.data),
        uploaded_by=user.id,
    )
    db.add(d)
    try:
        await db.flush()
        await write_audit(
            db,
            request,
            action="document.uploaded",
            entity_type="student_document",
            entity_id=str(d.id),
            school_id=ctx.school_id,
            metadata={
                "student_id": str(student_id),
                "type": document_type,
                "file_name": d.file_name,
                "bytes": d.size_bytes,
            },
        )
        await db.commit()
    except DBAPIError as exc:
        await storage.delete(storage.DOCUMENT_BUCKET, path)
        raise await http_error_from_db(db, exc) from None
    await db.refresh(d)
    return _out(d, await _uploader_name(db, user.id))


@router.get("/{doc_id}/file")
async def get_document_file(
    student_id: uuid.UUID,
    doc_id: uuid.UUID,
    request: Request,
    download: bool = Query(default=False, description="true = save as file; false = show in the browser"),
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    d = await _document(db, ctx, student_id, doc_id)
    try:
        body = await storage.open_stream(storage.DOCUMENT_BUCKET, d.file_path)
    except storage.StorageError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None
    # Who opened which document, and when: sensitive records deserve an access trail.
    await write_audit(
        db,
        request,
        action="document.downloaded" if download else "document.viewed",
        entity_type="student_document",
        entity_id=str(d.id),
        school_id=ctx.school_id,
        metadata={"student_id": str(student_id)},
    )
    await db.commit()
    return StreamingResponse(
        body,
        media_type=d.mime_type,
        headers={
            "Content-Length": str(d.size_bytes),
            "Content-Disposition": content_disposition("attachment" if download else "inline", d.file_name),
            "Cache-Control": "private, no-store, max-age=0",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
            "Cross-Origin-Resource-Policy": "same-site",
        },
    )


@router.patch("/{doc_id}", response_model=DocumentOut)
async def update_document(
    student_id: uuid.UUID,
    doc_id: uuid.UUID,
    payload: DocumentUpdate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> DocumentOut:
    d = await _document(db, ctx, student_id, doc_id)
    changes = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if getattr(d, k) != v}
    if changes.get("document_type", d.document_type) == "other" and not changes.get("title", d.title):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Describe the document (e.g. Medical certificate).")
    if changes:
        before = {k: getattr(d, k) for k in changes}
        for k, v in changes.items():
            setattr(d, k, v)
        try:
            await db.flush()
            await write_audit(
                db,
                request,
                action="document.updated",
                entity_type="student_document",
                entity_id=str(d.id),
                school_id=ctx.school_id,
                metadata={"before": before, "after": changes},
            )
            await db.commit()
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc) from None
        await db.refresh(d)
    return _out(d, await _uploader_name(db, d.uploaded_by))


@router.delete("/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(
    student_id: uuid.UUID,
    doc_id: uuid.UUID,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Removes the record and the stored file. The audit log keeps what was deleted, by whom and when."""
    d = await _document(db, ctx, student_id, doc_id)
    path, meta = d.file_path, {"student_id": str(student_id), "type": d.document_type, "file_name": d.file_name}
    try:
        await db.delete(d)
        await db.flush()
        await write_audit(
            db,
            request,
            action="document.deleted",
            entity_type="student_document",
            entity_id=str(doc_id),
            school_id=ctx.school_id,
            metadata=meta,
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    await storage.delete(storage.DOCUMENT_BUCKET, path)
