"""Filling in templates: {{name}} is replaced by the value; nothing else is interpreted.

No template language (no code, loops or attribute access), so a template typed by a
school admin can't run anything or read data it wasn't given.
"""

import html
import re

from app.services.notify.catalog import COMMON_SAMPLE, EVENTS, TEST, Event

PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z0-9_]+)\s*\}\}")
GSM7 = set(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
)


class TemplateError(ValueError):
    pass


def event(key: str) -> Event:
    return TEST if key == "test" else EVENTS[key]


def placeholders(text: str | None) -> list[str]:
    return PLACEHOLDER.findall(text or "")


def validate(ev: Event, *texts: str | None) -> None:
    """Every {{name}} must be one of the event's variables; braces must be well formed."""
    for t in texts:
        if not t:
            continue
        unknown = sorted({p for p in placeholders(t) if p not in ev.variables})
        if unknown:
            allowed = ", ".join("{{" + v + "}}" for v in ev.variables)
            raise TemplateError(f"Unknown placeholder {{{{{unknown[0]}}}}}. Use one of: {allowed}.")
        leftover = PLACEHOLDER.sub("", t)
        if "{{" in leftover or "}}" in leftover:
            raise TemplateError("A placeholder isn't closed properly: write it as {{name}}.")


def render(text: str | None, values: dict[str, object]) -> str:
    """Fill in placeholders; unknown or empty values become empty text (never the raw {{name}})."""
    return PLACEHOLDER.sub(
        lambda m: str(values.get(m.group(1)) if values.get(m.group(1)) is not None else ""), text or ""
    ).strip()


def sample_values(ev: Event) -> dict[str, str]:
    return {**COMMON_SAMPLE, **ev.sample}


GSM7_EXT = set("^{}\\[~]|€\f")  # allowed, but each takes two characters' room


def sms_info(text: str) -> dict[str, object]:
    """Characters and SMS parts (GSM-7: 160/153 per part; anything else is Unicode: 70/67)."""
    unicode = any(ch not in GSM7 and ch not in GSM7_EXT for ch in text)
    single, multi = (70, 67) if unicode else (160, 153)
    n = len(text) if unicode else len(text) + sum(ch in GSM7_EXT for ch in text)
    parts = 1 if n <= single else -(-n // multi)
    return {"characters": n, "parts": parts, "unicode": unicode}


def email_html(body: str, school_name: str) -> str:
    """A plain, readable HTML version of the text body (escaped; links made clickable)."""
    esc = html.escape(body)
    esc = re.sub(r"(https?://[^\s<]+)", r'<a href="\1">\1</a>', esc)
    paras = "".join(f"<p style='margin:0 0 12px'>{p.replace(chr(10), '<br>')}</p>" for p in esc.split("\n\n"))
    return (
        "<!doctype html><html><body style='font-family:Arial,sans-serif;font-size:14px;color:#1b2b26;line-height:1.5'>"
        f"<div style='max-width:560px;margin:0 auto;padding:16px'>{paras}"
        "<p style='margin-top:24px;font-size:12px;color:#5d6b67'>"
        f"Sent by {html.escape(school_name)} through the school's ERP. "
        "You can change which messages you receive in your profile.</p></div></body></html>"
    )
