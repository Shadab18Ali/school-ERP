"""Image uploads (school logos, student photos).

Every upload is decoded and re-encoded: this strips metadata (camera GPS, device
details), defeats files disguised as images, and bounds the size, so we never
store or serve exactly what someone uploaded.
"""

import io
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_UPLOAD_BYTES = 2 * 1024 * 1024
MAX_OUTPUT_BYTES = 1024 * 1024
MAX_PIXELS = 25_000_000
ALLOWED_FORMATS = {"PNG", "JPEG", "WEBP"}


class LogoError(ValueError):
    pass


PhotoError = LogoError  # same failure modes, clearer name at call sites


def _decode(data: bytes, min_side: int, max_bytes: int = MAX_UPLOAD_BYTES) -> Image.Image:
    if not data:
        raise LogoError("The file is empty.")
    if len(data) > max_bytes:
        raise LogoError(f"The image must be {max_bytes // (1024 * 1024)} MB or smaller.")
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        try:
            probe = Image.open(io.BytesIO(data))
            fmt = probe.format
            probe.verify()
            img = Image.open(io.BytesIO(data))
            img.load()
        except (Image.DecompressionBombError, Image.DecompressionBombWarning):
            raise LogoError("The image dimensions are too large.") from None
        except (UnidentifiedImageError, OSError, SyntaxError, ValueError):
            raise LogoError("That file isn't a valid PNG, JPEG or WebP image.") from None
    if fmt not in ALLOWED_FORMATS:
        raise LogoError("Use a PNG, JPEG or WebP image.")
    if min(img.size) < min_side:
        raise LogoError(f"The image must be at least {min_side}×{min_side} pixels.")
    return ImageOps.exif_transpose(img)


def process_logo(data: bytes) -> bytes:
    """Logo → transparent PNG, at most 512×512."""
    img = _decode(data, 32).convert("RGBA")
    img.thumbnail((512, 512), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    img.save(out, "PNG", optimize=True)
    result = out.getvalue()
    if len(result) > MAX_OUTPUT_BYTES:  # pathological noise images
        img.thumbnail((256, 256), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        img.save(out, "PNG", optimize=True)
        result = out.getvalue()
    return result


def process_photo(data: bytes) -> bytes:
    """Student photo → JPEG, at most 600×600, no metadata."""
    img = _decode(data, 64)
    if img.mode in ("RGBA", "LA", "P"):  # flatten transparency onto white
        img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[-1])
        img = bg
    else:
        img = img.convert("RGB")
    img.thumbnail((600, 600), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    img.save(out, "JPEG", quality=85, optimize=True, progressive=True)
    return out.getvalue()


def process_signature(data: bytes) -> bytes:
    """Signature scan/photo → PNG at most 600×200 (transparency kept), no metadata."""
    img = _decode(data, 20).convert("RGBA")
    img.thumbnail((600, 200), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    img.save(out, "PNG", optimize=True)
    return out.getvalue()
