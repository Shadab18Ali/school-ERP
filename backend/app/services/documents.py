"""Validation for uploaded student documents.

* The type is decided by the file's bytes, never its name or browser-declared type.
* Images are decoded and re-encoded: hidden metadata (camera GPS, device) is
  removed and anything that isn't really an image is rejected.
* PDFs are parsed. Encrypted PDFs and PDFs with active content (scripts,
  launch actions, embedded files, forms that submit data) are rejected.
  Combined with serving files only through the API, with `Content-Security-Policy:
  sandbox` and `nosniff`, this keeps uploaded files from running code.
"""

import io
import re
import unicodedata
from dataclasses import dataclass
from urllib.parse import quote

from PIL import Image
from pypdf import PdfReader
from pypdf.errors import PdfReadError
from pypdf.generic import DictionaryObject, NameObject

from app.services.images import LogoError, _decode

MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
MAX_IMAGE_SIDE = 4000
MAX_PDF_OBJECTS = 50_000

ACTIVE_PDF_KEYS = {"/JS", "/JavaScript", "/Launch", "/EmbeddedFile", "/EmbeddedFiles", "/RichMedia", "/XFA"}
ACTIVE_PDF_ACTIONS = {"/JavaScript", "/Launch", "/SubmitForm", "/ImportData", "/RichMediaExecute", "/GoToE"}
ACTIVE_CONTENT = (
    "This PDF contains scripts or embedded files, which aren't allowed. Save it as a plain PDF and try again."
)
RAW_ACTIVE = re.compile(rb"/(JavaScript|JS|Launch|EmbeddedFiles?|RichMedia|XFA|SubmitForm|ImportData)(?![A-Za-z])")


class DocumentError(ValueError):
    pass


@dataclass(frozen=True)
class CleanFile:
    data: bytes
    mime_type: str
    extension: str


def sniff(data: bytes) -> str | None:
    if data.startswith(b"%PDF-"):
        return "application/pdf"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _unescape_names(data: bytes) -> bytes:
    # PDF names may hide letters as #xx escapes (/J#61vaScript); undo that before scanning.
    return re.sub(rb"#([0-9A-Fa-f]{2})", lambda m: bytes([int(m.group(1), 16)]), data)


def _check_pdf(data: bytes) -> None:
    if RAW_ACTIVE.search(_unescape_names(data)):
        raise DocumentError(ACTIVE_CONTENT)
    try:
        reader = PdfReader(io.BytesIO(data), strict=False)
        if reader.is_encrypted:
            raise DocumentError("Password-protected PDFs can't be uploaded. Remove the password and try again.")
        if len(reader.pages) == 0:
            raise DocumentError("This PDF has no pages.")
        # Walk every object, including those packed inside compressed object streams.
        size = int(reader.trailer.get("/Size", 0))
        for num in range(1, min(size, MAX_PDF_OBJECTS)):
            try:
                obj = reader.get_object(num)
            except Exception:  # noqa: BLE001 - damaged/free entries are skipped
                continue
            if isinstance(obj, DictionaryObject):
                if ACTIVE_PDF_KEYS & set(obj.keys()):
                    raise DocumentError(ACTIVE_CONTENT)
                action = obj.get("/S")
                if isinstance(action, NameObject) and str(action) in ACTIVE_PDF_ACTIONS:
                    raise DocumentError(ACTIVE_CONTENT)
    except DocumentError:
        raise
    except (PdfReadError, ValueError, KeyError, TypeError, OSError) as exc:
        raise DocumentError("This PDF is damaged or incomplete and can't be uploaded.") from exc


def _clean_image(data: bytes, mime: str) -> CleanFile:
    try:
        img = _decode(data, min_side=100, max_bytes=MAX_DOCUMENT_BYTES)
    except LogoError as exc:
        raise DocumentError(str(exc).replace("The image", "The file")) from None
    img.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    if mime == "image/png":  # keep PNG for crisp text in screenshots/scans
        img.convert("RGBA" if img.mode in ("RGBA", "LA", "P") else "RGB").save(out, "PNG", optimize=True)
        result = CleanFile(out.getvalue(), "image/png", "png")
    else:
        if img.mode in ("RGBA", "LA", "P"):
            rgba = img.convert("RGBA")
            bg = Image.new("RGB", rgba.size, (255, 255, 255))
            bg.paste(rgba, mask=rgba.split()[-1])
            img = bg
        img.convert("RGB").save(out, "JPEG", quality=90, optimize=True)
        result = CleanFile(out.getvalue(), "image/jpeg", "jpg")
    if len(result.data) > MAX_DOCUMENT_BYTES:
        raise DocumentError("The file is too large after processing. Scan it at a lower resolution.")
    return result


def clean_document(data: bytes) -> CleanFile:
    if not data:
        raise DocumentError("The file is empty.")
    if len(data) > MAX_DOCUMENT_BYTES:
        raise DocumentError("Documents must be 10 MB or smaller.")
    mime = sniff(data)
    if mime is None:
        raise DocumentError("Upload a PDF, JPEG, PNG or WebP file.")
    if mime == "application/pdf":
        _check_pdf(data)
        return CleanFile(data, mime, "pdf")
    return _clean_image(data, mime)


_UNSAFE = re.compile(r'[\x00-\x1f\x7f<>:"/\\|?*]+')


def safe_filename(name: str | None, extension: str) -> str:
    """Display/download name: no paths, control or reserved characters, correct extension."""
    name = unicodedata.normalize("NFC", (name or "").replace("\\", "/").split("/")[-1])
    stem = name.rsplit(".", 1)[0] if "." in name else name
    stem = " ".join(_UNSAFE.sub(" ", stem).split()).strip(" .")[:140] or "document"
    return f"{stem}.{extension}"


def content_disposition(kind: str, filename: str) -> str:
    """RFC 6266 header with an ASCII fallback and a UTF-8 name (e.g. Hindi file names)."""
    stem, _, ext = filename.rpartition(".")
    ascii_stem = unicodedata.normalize("NFKD", stem).encode("ascii", "ignore").decode()
    ascii_stem = " ".join(ascii_stem.replace('"', "").replace("\\", "").split()) or "document"
    ascii_name = f"{ascii_stem}.{ext}" if ext else ascii_stem
    return f"{kind}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


# ---------------------------------------------------------------- homework files
# Homework also takes Office documents and plain text. Office files are zip
# packages: only the ordinary Word / Excel / PowerPoint formats are accepted,
# never macro-enabled ones or packages carrying ActiveX controls or embedded
# programs, and the package is checked for "zip bombs" before anything else.
OOXML_TYPES = {
    "word/document.xml": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"),
    "xl/workbook.xml": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"),
    "ppt/presentation.xml": ("application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"),
}
MAX_ZIP_ENTRIES = 3000
MAX_ZIP_UNPACKED = 100 * 1024 * 1024
HOMEWORK_TYPES = "Upload a PDF, photo (JPEG, PNG, WebP), Word, Excel, PowerPoint or text file."


def _check_ooxml(data: bytes) -> CleanFile:
    import zipfile

    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            infos = z.infolist()
            if len(infos) > MAX_ZIP_ENTRIES or sum(i.file_size for i in infos) > MAX_ZIP_UNPACKED:
                raise DocumentError("This file is too large when unpacked.")
            names = {i.filename for i in infos}
            if "[Content_Types].xml" not in names:
                raise DocumentError(HOMEWORK_TYPES)
            types = z.read("[Content_Types].xml").decode("utf-8", "replace").lower()
    except DocumentError:
        raise
    except (zipfile.BadZipFile, zipfile.LargeZipFile, KeyError, OSError, ValueError) as exc:
        raise DocumentError("This file is damaged or isn't a Word, Excel or PowerPoint file.") from exc
    lower = {n.lower() for n in names}
    if (
        "macroenabled" in types
        or "vbaproject" in types
        or any(n.endswith("vbaproject.bin") or "/activex/" in n or "/embeddings/" in n for n in lower)
    ):
        raise DocumentError(
            "This file contains macros, controls or embedded objects, which aren't allowed. "
            "Save it as a normal .docx / .xlsx / .pptx and try again."
        )
    for part, (mime, ext) in OOXML_TYPES.items():
        if part in names:
            return CleanFile(data, mime, ext)
    raise DocumentError(HOMEWORK_TYPES)


def _check_text(data: bytes) -> CleanFile | None:
    if b"\x00" in data:
        return None
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    return CleanFile(data, "text/plain", "txt")


def clean_homework_file(data: bytes, filename: str | None) -> CleanFile:
    """Type decided by the bytes (the name only distinguishes text from other plain data)."""
    if not data:
        raise DocumentError("The file is empty.")
    if len(data) > MAX_DOCUMENT_BYTES:
        raise DocumentError("Files must be 10 MB or smaller.")
    if sniff(data) is not None:
        return clean_document(data)
    if data.startswith(b"PK\x03\x04"):
        return _check_ooxml(data)
    if (filename or "").lower().endswith(".txt"):
        text_file = _check_text(data)
        if text_file:
            return text_file
    raise DocumentError(HOMEWORK_TYPES)
