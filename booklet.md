# Architectural Plan: Cloudflare Storage Migration & Booklet TOS Citations

> **Status:** Proposal / Draft (Awaiting User Review)  
> **Created:** 2026-11-05  
> **Target Version:** v.2.3  
> **Scope:** Cloudflare R2 Cloud Storage Migration + Enhanced Table of Specifications (TOS) Citations with Insert Booklet Metadata

---

## 1. Executive Summary & Objectives

This document establishes the end-to-end plan to:
1. **Migrate Cloud Storage to Cloudflare R2** from Supabase Storage for all exam media assets (Question Paper PDFs, Insert / Resource Booklet PDFs, cropped diagrams, audio tracks, and quiz attachments).
2. **Add Insert / Resource Booklet Metadata to TOS Citations** in [`src/services/tosExportService.ts`](file:///c:/testmaker/src/services/tosExportService.ts), ensuring the exported Word Table of Specifications explicitly identifies both the Question Paper page and the Insert Booklet figure/page with clickable deep links.

---

## Part 1: Moving Storage to Cloudflare R2

### 1.1 Why Move from Supabase Storage to Cloudflare R2?

| Dimension | Supabase Storage (Current Fallback) | Cloudflare R2 (Target Primary) |
| :--- | :--- | :--- |
| **Storage Quota** | 1 GB Free Tier limit (fast burnout with PDF past papers & high-res maps) | **10 GB Free Tier** per month forever |
| **Egress Bandwidth Fees** | \$0.09 / GB after 2 GB/month; throttles / locks project when exceeded | **\$0.00 Egress Fees** (Unlimited free download bandwidth) |
| **Latency in Indonesia** | US / Singapore routing; periodic ISP DNS filtering or throttling | Global Anycast network with native **Edge Data Centers in Jakarta & Southeast Asia** |
| **Asset Centralization** | Assets split between Supabase storage buckets and R2 proxy | **Single unified media repository** across web, mobile, and print export pipelines |

---

### 1.2 Asset Scope & Deterministic Key Structure

All exam assets will reside under organized key prefixes within the Cloudflare R2 bucket:

```text
r2-bucket/
├── papers/          # Full Source Past Paper PDFs
│   ├── 0620_2026_s_qp_11.pdf       # Question Paper
│   └── 0620_2026_s_insert_11.pdf   # Insert / Resource Booklet (NEW)
├── diagrams/        # Cropped Technical Vector & Raster Diagrams
│   └── 0620_2026_p11_Q1_a_173000000.webp
├── audio/           # Cambridge English / Foreign Language Listening Tracks
│   └── audio_173000000_abcde.mp3
└── attachments/     # Interactive Quiz Reference Docs & Formula Sheets
    └── att_quiz123_periodic_table.pdf
```

---

### 1.3 Changes Required for Cloudflare Storage Migration

#### A. Add Booklet PDF Upload Support in [`src/services/storageService.ts`](file:///c:/testmaker/src/services/storageService.ts)
Currently, `storageService.ts` only has `uploadPastPaperPdf` which formats `...qp_...pdf`. We will add:
```typescript
export async function uploadInsertBookletPdf(
  file: File | Blob,
  metadata: {
    subject_code: string;
    year: number;
    series: string;
    paper_number: string | number;
  }
): Promise<string | null> {
  const cleanSubject = String(metadata.subject_code || 'paper').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  const cleanSeries = String(metadata.series || 'series').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  const cleanPaper = String(metadata.paper_number || '1').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  const pathKey = `papers/${cleanSubject}_${metadata.year}_${cleanSeries}_insert_${cleanPaper}.pdf`;

  if (isR2StorageEnabled()) {
    const r2Url = await uploadToR2Proxy(file, pathKey);
    if (r2Url) return r2Url;
  }
  return uploadPdfToSupabaseFallback(file, pathKey);
}
```

#### B. Upload Booklet File During Paper Ingestion in [`src/lib/pdfProcessor.ts`](file:///c:/testmaker/src/lib/pdfProcessor.ts)
- In `saveExtractedQuestionsToDatabase`:
  - Along with `_qpFile`, accept `_insertFile: File | null`.
  - When `_insertFile` is present, call `uploadInsertBookletPdf(_insertFile, ...)`.
  - Save `insert_pdf_url` onto the question records and inside `mark_scheme._insert_pdf_url`.

#### C. Database Schema Update in [`src/types/database.ts`](file:///c:/testmaker/src/types/database.ts)
- Add optional `insert_pdf_url?: string | null` to `Question` and `ExtractedQuestion` interfaces.
- The upload pipeline will preserve this in `mark_scheme` JSONB as a non-breaking fallback even if the Supabase SQL column hasn't been migrated yet.

#### D. Batch Migration Script for Existing Papers & Diagrams
- Create a script (`scripts/migrate_supabase_storage_to_r2.mjs`) that:
  1. Queries all rows in `questions` where `diagram_url` or `source_pdf_url` contains `supabase.co`.
  2. Downloads the asset and uploads it to Cloudflare R2.
  3. Updates the Supabase row to point to the new Cloudflare R2 URL.

---

## Part 2: Adding Booklet Details to TOS Citations

### 2.1 Current Problem & Behavior

In [`src/services/tosExportService.ts`](file:///c:/testmaker/src/services/tosExportService.ts#L320-L354):
- The `buildCitationInfo(q, subPart)` function only inspects `q.paper_number`, `q.series`, `q.year`, `q.question_number`, and `q.page_number`.
- Output:
  ```text
  IGCSE Level: Paper 11 May/June 2026 Q1(a) (p. 3)
  Link: https://r2-endpoint/papers/0620_2026_s_qp_11.pdf#page=3
  ```
- **The Blindspot**:
  - Questions relying on an Insert figure (e.g. Geography Paper 1/2, History, Economics, Science photo inserts) have `diagram_source === 'insert'`, `resource_ref: "Fig. 1.1"`, and `insert_page_number: 2`.
  - The TOS Citation currently ignores all three fields, leaving examiners and teachers unaware of which booklet figure or booklet page is needed.

---

### 2.2 Target Citation Format

#### Case 1: Standard Question Paper Question (No Insert)
```text
IGCSE Level: Paper 11 May/June 2026 Q1(a) (p. 3)
[QP PDF (p. 3)]
```

#### Case 2: Question with Insert / Resource Booklet Figure
```text
IGCSE Level: Paper 21 May/June 2026 Q2(b) (QP p. 4) • [Insert: Fig. 2.1, p. 2]
[QP PDF (p. 4)] | [Insert Booklet (p. 2)]
```

If the Question Paper and Insert Booklet PDFs are both uploaded:
- Both links are rendered in the Citation column as clickable hyperlinks with page deep-linking (`#page=X`).
- If only one is available or pending, the text remains accurate while linking whichever PDF is present.

---

### 2.3 Code Implementation Plan for TOS Citations

#### A. Extend `buildCitationInfo` in [`src/services/tosExportService.ts`](file:///c:/testmaker/src/services/tosExportService.ts)
Update signature to accept the sub-question object (`sq?: SubQuestion`):

```typescript
interface CitationDetails {
  citationPrefix: string;
  citationBody: string;
  citationText: string;
  qpCitationUrl?: string;
  insertCitationUrl?: string;
  qpPageNumber?: number | null;
  insertPageNumber?: number | null;
  resourceRef?: string | null;
  isInsertResource: boolean;
}

function buildCitationInfo(
  q: Question,
  sq?: SubQuestion,
  subPart?: string
): CitationDetails {
  const parts: string[] = [];

  const paper = q.paper_number !== null && q.paper_number !== undefined ? `Paper ${q.paper_number}` : '';
  const season = q.series || '';
  const year = q.year ? String(q.year) : '';
  const qNum = q.question_number ? `Q${q.question_number}${subPart ? `(${subPart})` : ''}` : '';

  if (paper) parts.push(paper);
  if (season || year) parts.push([season, year].filter(Boolean).join(' '));
  if (qNum) parts.push(qNum);

  const citationPrefix = 'IGCSE Level:';
  let citationBody = parts.length > 0 ? parts.join(' ') : 'Past Paper Reference';

  // 1. Question Paper Page & Deep Link
  const qpPageNum = (sq?.page_number ?? q.page_number) ?? (q.mark_scheme as any)?._page_number ?? null;
  let qpUrl = q.source_pdf_url || (q.mark_scheme as any)?._source_pdf_url || undefined;
  if (qpUrl && qpPageNum && !qpUrl.includes('#page=')) {
    qpUrl = `${qpUrl}#page=${qpPageNum}`;
  }

  // 2. Insert Booklet Metadata Resolution
  const diagramSource = sq?.diagram_source || q.diagram_source || null;
  const resourceRef = sq?.resource_ref || q.resource_ref || null;
  const insertPageNum = sq?.insert_page_number || q.insert_page_number || (q.mark_scheme as any)?._insert_page_number || null;
  const isInsert = diagramSource === 'insert' || Boolean(resourceRef) || Boolean(insertPageNum);

  let insertUrl = (q as any).insert_pdf_url || (q.mark_scheme as any)?._insert_pdf_url || undefined;
  if (insertUrl && insertPageNum && !insertUrl.includes('#page=')) {
    insertUrl = `${insertUrl}#page=${insertPageNum}`;
  }

  // 3. Composite Citation Body Formatting
  if (isInsert) {
    const insertTagParts: string[] = [];
    if (resourceRef) insertTagParts.push(resourceRef);
    if (insertPageNum) insertTagParts.push(`p. ${insertPageNum}`);
    const insertLabel = insertTagParts.length > 0 ? `[Insert: ${insertTagParts.join(', ')}]` : '[Insert Booklet]';

    if (qpPageNum) {
      citationBody += ` (QP p. ${qpPageNum}) • ${insertLabel}`;
    } else {
      citationBody += ` • ${insertLabel}`;
    }
  } else if (qpPageNum) {
    citationBody += ` (p. ${qpPageNum})`;
  }

  return {
    citationPrefix,
    citationBody,
    citationText: `${citationPrefix} ${citationBody}`,
    qpCitationUrl: qpUrl,
    insertCitationUrl: insertUrl,
    qpPageNumber: qpPageNum,
    insertPageNumber: insertPageNum,
    resourceRef,
    isInsertResource: isInsert,
  };
}
```

#### B. Update Row Rendering in [`tosExportService.ts`](file:///c:/testmaker/src/services/tosExportService.ts#L1140-L1180)
In the table row generator:
1. Render the bold citation header: `${row.citationPrefix} ${row.citationBody}`.
2. Render hyperlinked action pills:
   - If `qpCitationUrl`: `[📄 QP Paper (p. X)]`
   - If `insertCitationUrl`: `[🗺️ Insert Booklet (p. Y)]`
   - If neither URL is present yet: `(PDF citation link pending)` in muted italics.

---

## 3. Step-by-Step Execution Sequence

1. **Phase 1: Cloudflare R2 Upload Extensions**
   - Add `uploadInsertBookletPdf` in [`src/services/storageService.ts`](file:///c:/testmaker/src/services/storageService.ts).
   - Hook `_insertFile` into `saveExtractedQuestionsToDatabase` in [`src/lib/pdfProcessor.ts`](file:///c:/testmaker/src/lib/pdfProcessor.ts).
2. **Phase 2: TOS Citation Enrichment**
   - Refactor `buildCitationInfo` in [`src/services/tosExportService.ts`](file:///c:/testmaker/src/services/tosExportService.ts) to accept sub-question context and parse booklet metadata.
   - Update Table of Specifications DOCX cell rendering for dual links.
3. **Phase 3: Automated Testing & Verification**
   - Run type checks (`npx tsc -b`) and build verification (`npm run build`).
   - Run test export with a Geography / Science paper featuring both QP questions and Insert maps.
4. **Phase 4: Optional Storage Migration Script**
   - Provide `scripts/migrate_supabase_storage_to_r2.mjs` to copy existing diagrams from Supabase to R2.

---

## 4. User Review & Decision Gate

Please review this plan. Upon your confirmation, we can begin implementing Phase 1 and Phase 2.

