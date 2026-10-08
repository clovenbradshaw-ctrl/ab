# DocAI corpus sources

Real TN DCS / Family Case File scans are confidential (statutorily), so DocAI is
trained by **transfer from adjacent document domains**. Each source below is
mapped to what it teaches the reader. `corpus/fetch.mjs` pulls a chosen subset
into `corpus/data/` and writes a manifest DocAI can learn from.

## Form understanding / field extraction (the CS-#### forms — core)
- FUNSD — 199 noisy scanned forms, question/answer + links. `guillaumejaume.github.io/FUNSD`
- XFUND — FUNSD extended to 7 languages. `github.com/doc-analysis/XFUND`
- NAF (National Archives Forms) — US National Archives + FamilySearch forms, field boxes, handwriting. `github.com/herobd/NAF_dataset`
- NIST SD2 — 5,590 synthesized IRS-1040 forms. `nist.gov/srd/nist-special-database-2`
- NIST SD6 — 5,595 synthesized tax forms. `nist.gov/srd/nist-special-database-6`
- HGAF — 291 handwritten German admin forms, field GT. Zenodo `10.5281/zenodo.22934701`
- handwritten-form-ocr-ie-json-dataset — FUNSD+IAM+CVL+RIMES+cheques with OCR+JSON. `github.com/bernardadhitya/handwritten-form-ocr-ie-json-dataset`

## Handwriting (notations, signatures, handwritten intake)
- IAM Handwriting — 1,539 pages / 115k words. `fki.tic.heia-fr.ch`
- CVL — multi-writer handwritten English. `fki.tic.heia-fr.ch`
- RIMES — French handwritten correspondence. ICDAR / Mines-Télécom.
- NIST SD19 — full-page handprinted forms + 800k chars. `nist.gov/srd/nist-special-database-19`

## Layout analysis & document triage (sorting a case file)
- RVL-CDIP — 400k images, 16 classes. `cs.cmu.edu/~aharley/rvl-cdip`
- Tobacco3482 — 3,482 docs, 10 classes. UCSF / HF.
- DocLayNet — 80,863 pages, 11 layout classes (legal/tender/finance). HF `docling-project/DocLayNet`
- PubLayNet — 364k pages, 5 classes. `github.com/ibm-aur-nlp/PubLayNet`
- DocBank — 500k pages, token-level layout. `github.com/doc-analysis/DocBank`

## Government scans & hard OCR (typewriter, redactions, degraded)
- govdocs1 — ~1M `.gov` files (~220k PDFs). `digitalcorpora.org`; HF `BEE-spoke-data/govdocs1-pdf-source`
- GovScape — 10M federal PDFs / 71M pages. `govscape.net`
- NIST SD25 — 1994 Federal Register, 4,711 page scans + SGML. NIST/govinfo.
- UFOCR — declassified FBI/DoW archives, typewriter/redaction/handwriting. HF `reducto/ufocr`
- ABBYY JFK OCR — full-text OCR of the JFK Records Collection. `github.com/abbyy/jfk-ocr`
- 1970s EIS scans — 250 degraded typewriter EIS. HF `Windsao/eis-subset50`, `eis-text250`

## Domain records inside a DCS file
- SROIE — scanned receipts (pay stubs/financial). ICDAR-2019; also CORD.
- CourtListener RECAP / Caselaw Access Project — PACER filings (petitions, orders). `courtlistener.com`, `case.law`
- NDACAN (AFCARS/NCANDS) — child-welfare case-level schema + codebooks (labels, not scans). `ndacan.acf.hhs.gov`

## Run-offs
MIDV-500 (IDs/passports) · PubTables-1M (tables) · Lukaszl/pl-government-docs-mix-ocr
(forms+stamps+signatures) · Taiwan / Korean gazettes (dense official scans).

## Mapping to the reader
- **Form-field extraction** → FUNSD/XFUND/NAF/NIST SD2/6 drive `extractFormFields`
  layout priors and the label lexicon.
- **Handwriting/notation** → IAM/CVL/RIMES/SD19 set expectations for the
  low-confidence ink and unsigned/handwritten regions DocAI flags as unresolved.
- **Triage / kind** → RVL-CDIP/Tobacco3482/DocLayNet train `doc_kind` clusters.
- **Hard OCR** → govdocs1/UFOCR/NIST SD25/JFK harden the eyes on typewriter,
  redaction and degradation.
- **Domain records** → SROIE/`CourtListener` teach receipts and court orders;
  NDACAN supplies the label schema DCS reports into.
