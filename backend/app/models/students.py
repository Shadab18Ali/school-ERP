"""ORM mappings for migration 0005 (schema owned by SQL migrations)."""

import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, FetchedValue, ForeignKeyConstraint, Integer, Text, func
from sqlalchemy.dialects.postgresql import ENUM, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base

gender_enum = ENUM("male", "female", "other", name="gender", create_type=False)
student_status_enum = ENUM("active", "inactive", name="student_status", create_type=False)


class Student(Base):
    __tablename__ = "students"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    school_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    # assigned by a database trigger (STU00001 ...), fetched back after insert
    student_code: Mapped[str] = mapped_column(Text, server_default=FetchedValue())
    full_name: Mapped[str] = mapped_column(Text)
    father_name: Mapped[str | None] = mapped_column(Text)
    mother_name: Mapped[str | None] = mapped_column(Text)
    date_of_birth: Mapped[date] = mapped_column(Date)
    gender: Mapped[str] = mapped_column(gender_enum)
    mobile: Mapped[str] = mapped_column(Text)
    alternate_mobile: Mapped[str | None] = mapped_column(Text)
    address: Mapped[str | None] = mapped_column(Text)
    photo_path: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(student_status_enum, default="active")
    status_reason: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StudentEnrollment(Base):
    __tablename__ = "student_enrollments"
    __table_args__ = (ForeignKeyConstraint(["student_id", "school_id"], ["students.id", "students.school_id"]),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    school_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    student_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    academic_session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    class_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    section_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    admission_number: Mapped[str] = mapped_column(Text)
    admission_date: Mapped[date] = mapped_column(Date)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


document_type_enum = ENUM(
    "birth_certificate",
    "previous_marksheet",
    "transfer_certificate",
    "address_proof",
    "student_id_document",
    "other",
    name="student_document_type",
    create_type=False,
)


class StudentDocument(Base):
    __tablename__ = "student_documents"
    __table_args__ = (ForeignKeyConstraint(["student_id", "school_id"], ["students.id", "students.school_id"]),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    school_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    student_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    document_type: Mapped[str] = mapped_column(document_type_enum)
    title: Mapped[str | None] = mapped_column(Text)
    file_path: Mapped[str] = mapped_column(Text)
    file_name: Mapped[str] = mapped_column(Text)
    mime_type: Mapped[str] = mapped_column(Text)
    size_bytes: Mapped[int] = mapped_column(Integer)
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
