# Table of Specifications (ToS) Dual Citation Links Implementation Plan
## Official Cambridge Support Hub Hyperlinks (QP & Mark Scheme) & School Server PDF Access

---

## 1. Executive Summary & Objectives

The school assessment policy requires Table of Specifications (ToS) citations to reference official resources on the **Cambridge School Support Hub** (e.g. `https://schoolsupporthub.cambridge.org/item/90bdc4c3-16ac-4ee1-9e89-07e6fd472c9a`) for both **Question Papers (QP)** and **Mark Schemes (MS)**. However, because access to the Cambridge Hub requires an authorized educator login, offline or external evaluators cannot view questions directly through it.

To provide the ideal assessment blueprint:
1. **Triple-Link Citation Model in Table of Specifications**:
   - **Cambridge QP Hub Link**: Hyperlinked directly onto the paper title (e.g. `[IGCSE Level: Paper 22 February/March 2023 Q1 (p. 2)](https://schoolsupporthub.cambridge.org/item/qp-id)`).
   - **School Server PDF Link**: Printed as a raw, clickable deep-link below the title with a clean `Server Copy:` prefix (e.g. `Server Copy: https://.../papers/0620_m23_qp_22.pdf#page=2`), allowing immediate, login-free page access.
   - **Insert Booklet Link**: Preserved as `Insert Copy: https://.../papers/0620_m23_in_22.pdf#page=3` if the question uses resource inserts.
   - **Cambridge Mark Scheme (MS) Hub Link**: Rendered in the Citation cell as a concise hyperlink line `Official Mark Scheme (Hub) ↗` pointing to the official Cambridge Hub mark scheme item URL to save vertical space while keeping the table clean and readable.
2. **Access Instruction Banner**:
   - An elegant callout box placed right above the **Item Specifications & Citations Table** explaining how assessors and reviewers should use the links for Question Papers, Mark Schemes, and School Server copies.
3. **Teacher Management Workflows**:
   - **Batch Management**: In `PastPaperPdfManagerModal`, teachers can view and attach/edit both Cambridge QP Hub links and Cambridge MS Hub links for all questions in a past paper at once.
   - **Per-Question Override**: In `QuestionEditorModal`, teachers can view and edit both Cambridge QP and MS Hub links for individual questions.
4. **Resilient Data Architecture**:
   - Stored in `questions.cambridge_hub_url` and `questions.cambridge_ms_hub_url` with automatic fallback to `mark_scheme._cambridge_hub_url` and `mark_scheme._cambridge_ms_hub_url` JSONB, guaranteeing 100% functionality without requiring immediate database migration scripts.

---

## 2. Technical Design & Architecture

```
                                  +---------------------------------------+
                                  |   PastPaperPdfManagerModal.tsx        |
                                  |   - Server PDF (Upload/Paste URL)     |
                                  |   - Cambridge QP Hub URL              |
                                  |   - Cambridge MS Hub URL              |
                                  +-------------------+-------------------+
                                                      |
                                                      v
                                  +---------------------------------------+
                                  |   questionBankService.ts              |
                                  |   - batchAttachCambridgeHubUrl        |
                                  |   - batchDetachCambridgeHubUrl        |
                                  |   - batchAttachCambridgeMsHubUrl      |
                                  |   - batchDetachCambridgeMsHubUrl      |
                                  +-------------------+-------------------+
                                                      |
                        +-----------------------------+-----------------------------+
                        |                                                           |
                        v                                                           v
+-----------------------------------------------+   +-----------------------------------------------+
| questions.cambridge_hub_url                   |   | questions.mark_scheme._cambridge_hub_url      |
| questions.cambridge_ms_hub_url                |   | questions.mark_scheme._cambridge_ms_hub_url   |
| (Native Columns if present)                   |   | (JSONB Resilience Fallback)                   |
+-----------------------------------------------+   +-----------------------------------------------+
                        |                                                           |
                        +-----------------------------+-----------------------------+
                                                      |
                                                      v
                                  +---------------------------------------+
                                  |   tosExportService.ts                 |
                                  |   - buildCitationInfo (resolves URLs) |
                                  |   - Access Guide Callout Box          |
                                  |   - Paper Title ExternalHyperlink(QP) |
                                  |   - Labeled Raw Server PDF Link       |
                                  |   - Concise "Official MS (Hub) ↗" Link|
                                  +-------------------+-------------------+
                                                      |
                                                      v
                                  +---------------------------------------+
                                  |   Exported Cambridge ToS .docx        |
                                  +---------------------------------------+
```

---

## 3. Detailed Component & Service Specifications

### 3.1 Type Definitions (`src/types/database.ts`)
- Update `Question` interface:
  ```ts
  export interface Question {
    // ...
    source_pdf_url?: string | null;         // Permanent public URL of the source Question Paper PDF (School Server)
    cambridge_hub_url?: string | null;      // Official Cambridge School Support Hub QP resource item URL
    cambridge_ms_hub_url?: string | null;   // Official Cambridge School Support Hub Mark Scheme resource item URL
    insert_pdf_url?: string | null;
    // ...
  }
  ```

### 3.2 Question Bank Service Layer (`src/services/questionBankService.ts`)
- **Extend `PastPaperGroupSummary`**:
  ```ts
  export interface PastPaperGroupSummary {
    // ... existing fields ...
    linkedPdfCount: number;
    hasPdfUrl: boolean;
    samplePdfUrl: string | null;
    linkedHubCount: number;        // Number of questions linked to Cambridge QP Hub
    hasHubUrl: boolean;           // True if at least one question has QP Hub URL
    sampleHubUrl: string | null;  // Sample QP Hub URL for preview / editing
    linkedMsHubCount: number;      // Number of questions linked to Cambridge MS Hub
    hasMsHubUrl: boolean;         // True if at least one question has MS Hub URL
    sampleMsHubUrl: string | null;// Sample MS Hub URL for preview / editing
  }
  ```
- **Update `fetchDistinctPastPapersSummary`**:
  - Select `cambridge_hub_url` and `cambridge_ms_hub_url` with fallback if columns are not present.
  - Aggregate `linkedHubCount`, `hasHubUrl`, `sampleHubUrl`, `linkedMsHubCount`, `hasMsHubUrl`, and `sampleMsHubUrl`.
- **Add Batch Methods**:
  - `batchAttachCambridgeHubUrl(filter, url: string)`
  - `batchDetachCambridgeHubUrl(filter)`
  - `batchAttachCambridgeMsHubUrl(filter, url: string)`
  - `batchDetachCambridgeMsHubUrl(filter)`
  - Both update native columns (if present) and sync into `mark_scheme._cambridge_hub_url` and `mark_scheme._cambridge_ms_hub_url` for complete schema safety.
- **Update Single-Question Methods**:
  - `updateQuestion`, `createQuestion`, and `normalizeQuestionRecord` to cleanly persist and extract both `cambridge_hub_url` and `cambridge_ms_hub_url`.

### 3.3 Past Paper Manager Modal (`src/components/PastPaperPdfManagerModal.tsx`)
- **UI Expansion**:
  - In each paper row, present dedicated status badges and actions for:
    1. **Server PDF**: Linked / Missing + Upload PDF / Paste URL / Unlink / View PDF ↗
    2. **Cambridge QP Hub**: Hub Linked (x/y) / Missing + Link QP Hub / Edit / Open ↗ / Clear
    3. **Cambridge MS Hub**: MS Linked (x/y) / Missing + Link MS Hub / Edit / Open ↗ / Clear
  - **Inline Editing Action**:
    - Dedicated input with inline **Save** and **Cancel**.
    - Non-blocking domain check: accepts any valid `http/https` URL, with gentle helper tip when pasting non-`schoolsupporthub.cambridge.org` links.

### 3.4 Question Editor Modal (`src/components/QuestionEditorModal.tsx`)
- Add two input fields in the Question Metadata / Past Paper Source section:
  1. **"Cambridge QP Hub URL"**: powers the paper title hyperlink in the ToS export.
  2. **"Cambridge Mark Scheme Hub URL"**: powers the concise `Official Mark Scheme (Hub) ↗` link in the ToS export.
- On Save: updates both top-level fields and `mark_scheme._cambridge_hub_url` / `mark_scheme._cambridge_ms_hub_url`.

### 3.5 Table of Specifications Word Export (`src/services/tosExportService.ts`)

#### A. Citation Info Builder (`buildCitationInfo`)
```ts
function buildCitationInfo(
  q: Question,
  sq?: SubQuestion,
  subPart?: string
): {
  citationPrefix: string;
  citationBody: string;
  citationText: string;
  citationUrl?: string;
  cambridgeHubUrl?: string;
  cambridgeMsHubUrl?: string; // NEW
  insertCitationUrl?: string;
  pageNumber?: number | null;
  insertPageNumber?: number | null;
  resourceRef?: string | null;
  isInsertResource: boolean;
}
```
- Resolves `cambridgeHubUrl` and `cambridgeMsHubUrl` from `q` or `mark_scheme` JSONB fallback.

#### B. Access Instruction Callout Box
Placed immediately above the `tosTable` (under the `Item Specifications & Citations Table` section heading):
- **Visual Style**:
  - Background Shading: Soft pale slate (`F8FAFC`).
  - Left Border: Thick Cambridge navy accent line (`002D62`, size 24 dxa).
  - Padding: top/bottom 100 dxa, left/right 140 dxa.
- **Wording**:
  > **ℹ️ Past Paper Citation & Verification Guide**  
  > **Official Cambridge Hub Links**: Paper titles link directly to official Cambridge School Support Hub Question Papers, and `Official Mark Scheme (Hub) ↗` links to the official Mark Scheme (*authorized school login required*).  
  > **School Server Copies**: The `Server Copy` links below provide direct, login-free page access to archived PDF copies on the school server.

#### C. Citation Cell Rendering
1. **Paper Title**:
   - If `row.cambridgeHubUrl` is present:
     - Wrapped inside `new ExternalHyperlink({ link: row.cambridgeHubUrl, children: [...] })`.
     - Styled with `bold: true`, font size 16, color `0563C1` (hyperlink blue) with `underline: { type: UnderlineType.SINGLE }`.
   - If `row.cambridgeHubUrl` is not present:
     - Rendered as bold text in `111827` (charcoal).
2. **Server PDF Copy**:
   - If `row.citationUrl` is present:
     - Paragraph with label: `Server Copy: ` (bold, font size 12, color `6B7280`).
     - Wrapped clickable URL: `row.citationUrl` (font size 12, color `0563C1`, underlined).
3. **Insert Booklet Copy**:
   - If `row.insertCitationUrl` is present:
     - Paragraph with label: `Insert Copy: ` (bold, font size 12, color `0D9488`).
     - Wrapped clickable URL: `row.insertCitationUrl` (font size 12, color `0D9488`, underlined).
4. **Official Mark Scheme Hub Link**:
   - If `row.cambridgeMsHubUrl` is present:
     - Rendered as a concise hyperlink line:
       ```ts
       new Paragraph({
         alignment: AlignmentType.LEFT,
         spacing: { before: 20, after: 20, line: 220 },
         children: [
           new ExternalHyperlink({
             children: [
               new TextRun({
                 text: 'Official Mark Scheme (Hub) ↗',
                 bold: true,
                 size: 13,
                 font: fontName,
                 color: '7C3AED', // Distinct purple/indigo accent for Mark Scheme
                 underline: { type: UnderlineType.SINGLE },
               }),
             ],
             link: row.cambridgeMsHubUrl,
           }),
         ],
       })
       ```
5. **Footnote 4 Update**:
   - Documents the dual QP + MS Cambridge Hub link integration and Server PDF access.

---

## 4. Verification & Testing Strategy

### 4.1 Automated Test Suite (`scripts/test-tos-citations-dual-links.mjs`)
1. **Schema & URL Resolution Tests**:
   - Verify `cambridge_hub_url` and `cambridge_ms_hub_url` extraction from top-level question and `mark_scheme` fallback.
   - Verify `buildCitationInfo` returns both `cambridgeHubUrl` and `cambridgeMsHubUrl`.
2. **Triple-Link Generation Tests**:
   - Verify paper title hyperlinked to QP Hub link.
   - Verify raw link labeled with `Server Copy:`.
   - Verify concise `Official Mark Scheme (Hub) ↗` link generated with target URL.
   - Verify insert booklet citation compatibility.
3. **Instruction Callout Verification**:
   - Verify document structure contains the callout banner before the main table.
4. **Batch Operation Tests**:
   - Verify `batchAttachCambridgeHubUrl` and `batchAttachCambridgeMsHubUrl` update both native columns and mark scheme JSONB.
   - Verify detachment methods cleanly clear both links.

### 4.2 Full Regression Suite
- Run all project test suites: `test:emergency`, `test:sorting`, `test:blooms`, `test:gforms`.
- TypeScript build check: `npm run build`.
- Linter check: `npm run lint`.

---

## 5. Execution Steps

1. **Step 1**: Update `types/database.ts` with `cambridge_hub_url` and `cambridge_ms_hub_url`.
2. **Step 2**: Enhance `questionBankService.ts` with batch attach/detach and summary aggregation for both QP and MS Hub links.
3. **Step 3**: Upgrade `PastPaperPdfManagerModal.tsx` and `QuestionEditorModal.tsx` to support managing both Cambridge QP and MS Hub URLs.
4. **Step 4**: Upgrade `tosExportService.ts` with callout note box, hyperlinked title, labeled server link, and concise Mark Scheme Hub link.
5. **Step 5**: Write and execute `scripts/test-tos-citations-dual-links.mjs` to ensure 100% pass rate.
6. **Step 6**: Run complete build and lint checks, then verify in browser.
