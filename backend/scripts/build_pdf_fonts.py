"""Builds the PDF fonts (app/assets/fonts/ErpSans-*.ttf): DejaVu Sans (Latin, ₹, symbols) with the
Noto Sans fonts for India's scripts merged in — Devanagari (Hindi, Marathi, Sanskrit, Nepali),
Bengali/Assamese, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada and Malayalam — so a name or
address in any of them prints instead of empty boxes. Run once when the source fonts change:

    python -m scripts.build_pdf_fonts /path/to/noto-ttfs

The source folder holds DejaVu (from app/assets/fonts) and NotoSans<Script>-Regular/Bold.ttf from
https://github.com/notofonts (SIL Open Font License; see app/assets/fonts/README.md).
"""

import sys
from pathlib import Path

from fontTools import merge
from fontTools.ttLib import TTFont
from fontTools.ttLib.scaleUpem import scale_upem

OUT = Path(__file__).resolve().parent.parent / "app" / "assets" / "fonts"
SCRIPTS = ["Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam"]


def _prepare(path: Path, upem: int, tmp: Path, *, latin: bool = False) -> Path:
    f = TTFont(path)
    if latin:
        # Latin text is now shaped too (it shares paragraphs with the Indian scripts): keep it drawn exactly
        # as before — no "ﬁ"/"ﬆ" ligatures or kerning, which also break copying and searching the PDF's text
        for tag, features in (("GSUB", ("liga", "dlig", "clig", "hlig")), ("GPOS", ("kern",))):
            if tag in f:
                for fr in f[tag].table.FeatureList.FeatureRecord:
                    if fr.FeatureTag in features:
                        fr.Feature.LookupListIndex = []
                        fr.Feature.LookupCount = 0
    for t in ("fpgm", "prep", "cvt ", "gasp", "hdmx", "LTSH", "VDMX", "kern", "FFTM", "MATH", "DSIG"):
        if t in f:
            del f[t]
    for g in f["glyf"].glyphs.values():  # hinting instructions can't be merged across fonts
        if hasattr(g, "program"):
            g.program = None  # type: ignore[attr-defined]
    if not latin:
        # an Indian-script font's rules apply to its own script only; left on DFLT/latn they would change
        # how Latin letters, digits and punctuation are drawn (and copied) everywhere
        for tag in ("GSUB", "GPOS"):
            if tag in f and f[tag].table.ScriptList:
                sl = f[tag].table.ScriptList
                sl.ScriptRecord = [r for r in sl.ScriptRecord if r.ScriptTag not in ("DFLT", "latn", "cyrl", "grek")]
                sl.ScriptCount = len(sl.ScriptRecord)
    for tag in ("GSUB", "GPOS"):  # the merger can't combine "required" features: list them as ordinary ones
        if tag in f and f[tag].table.ScriptList:
            for sr in f[tag].table.ScriptList.ScriptRecord:
                langs = ([sr.Script.DefaultLangSys] if sr.Script.DefaultLangSys else []) + [
                    r.LangSys for r in sr.Script.LangSysRecord
                ]
                for ls in langs:
                    if ls.ReqFeatureIndex != 0xFFFF:
                        if ls.ReqFeatureIndex not in ls.FeatureIndex:
                            ls.FeatureIndex.insert(0, ls.ReqFeatureIndex)
                            ls.FeatureCount = len(ls.FeatureIndex)
                        ls.ReqFeatureIndex = 0xFFFF
    if f["head"].unitsPerEm != upem:
        scale_upem(f, upem)
    out = tmp / path.name
    f.save(out)
    return out


def build(src: Path, weight: str) -> None:
    tmp = OUT / ".build"
    tmp.mkdir(exist_ok=True)
    base = _prepare(OUT / ("DejaVuSans.ttf" if weight == "Regular" else "DejaVuSans-Bold.ttf"), 2048, tmp, latin=True)
    parts = [base] + [_prepare(src / f"NotoSans{s}-{weight}.ttf", 2048, tmp) for s in SCRIPTS]
    m = merge.Merger(options=merge.Options(drop_tables=["vmtx", "vhea", "STAT", "meta"]))
    font = m.merge([str(p) for p in parts])
    name = font["name"]
    fam = "ErpSans"
    for rec in list(name.names):
        if rec.nameID in (1, 4, 6, 16):
            rec.string = {1: fam, 4: f"{fam} {weight}", 6: f"{fam}-{weight}", 16: fam}[rec.nameID]
    font.save(OUT / f"ErpSans-{weight}.ttf")
    for p in parts:
        p.unlink()
    tmp.rmdir()


if __name__ == "__main__":
    src = Path(sys.argv[1])
    for w in ("Regular", "Bold"):
        build(src, w)
        print("built", OUT / f"ErpSans-{w}.ttf")
