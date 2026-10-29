# PDF fonts

**ErpSans-Regular.ttf / ErpSans-Bold.ttf** — used for every PDF (receipts, certificates, ID cards,
report cards, payslips, invoices, timetables, exports). Built by `python -m scripts.build_pdf_fonts`
from:

- DejaVu Sans (regular and bold, the two `DejaVuSans*.ttf` files here): Latin, the Indian rupee
  sign (₹) and symbols. Bitstream Vera / DejaVu licence: https://dejavu-fonts.github.io/License.html
- Noto Sans Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada and Malayalam
  (regular and bold, https://github.com/notofonts): SIL Open Font License 1.1,
  https://openfontlicense.org — Copyright 2022 The Noto Project Authors.

Both licences allow embedding in documents and redistribution. The merged font keeps Latin text
exactly as DejaVu draws it (its ligatures and kerning are switched off, so text copied from a PDF
is what was typed); the Indian scripts are shaped with HarfBuzz (see `app/services/pdf_fonts.py`).
