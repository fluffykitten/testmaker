# Past Paper Source PDF Subject Isolation Remediation

**Status:** COMPLETED  
**Execution Date:** 2026-11-04  
**Workspace File:** `sourcefix.md`

---

## 1. Executive Summary & Root Cause

### The Problem
When filtering by exam series (e.g. `October/November`) in the Question Bank without selecting a subject, questions from all subjects appeared. However, questions in **Biology** and **Geography** were incorrectly displaying the **Chemistry (0620)** Question Paper PDF.

### Root Cause
1. **Unrestricted Batch Linking Query:** In `src/services/questionBankService.ts`, `batchAttachPastPaperPdf` had an optional `syllabusId?: string`. When missing or undefined, the query updated questions matching `year + series + paper_number` across all syllabuses.
2. **Missing Subject Filter in Modal:** `PastPaperPdfManagerModal` listed all papers across all subjects in one flat list without subject filtering, and `QuestionBankPage.tsx` did not pass the active `syllabusId`.
3. **Database Schema Gap:** `questions` lacked native `source_pdf_url` and `page_number` columns, causing writes to fall back to `mark_scheme JSONB` (`_source_pdf_url`), bypassing schema-level checks.

---

## 2. Actions Executed & Completed

### Phase 1: Database Cleanup (COMPLETED)
- Created and ran `scripts/repair_cross_subject_pdfs.cjs`.
- Cleaned exactly **59 contaminated questions**:
  - **Biology (0610):** 52 questions decoupled from Chemistry 0620 PDF.
  - **Biology (0970):** 5 questions decoupled from Chemistry 0620 PDF.
  - **Geography (0460):** 2 questions decoupled from Chemistry 0620 PDF.
- Preserved all **666 valid Chemistry (0620)** PDF links.
- Database audit verification: **0 mismatched questions remain**.

### Phase 2: Schema Migration Created (COMPLETED)
- Created `supabase/migrations/016_add_source_pdf_url_columns.sql`.
- Adds native columns:
  - `source_pdf_url TEXT DEFAULT NULL`
  - `page_number INT DEFAULT NULL`
- Migrates existing valid embedded `mark_scheme->_source_pdf_url` values to native columns.
- Creates composite index `idx_questions_paper_composite (syllabus_id, year, series, paper_number)`.

> **How to run in Supabase:**  
> Copy the contents of `supabase/migrations/016_add_source_pdf_url_columns.sql` into the Supabase Dashboard SQL Editor and execute. The app gracefully falls back to `mark_scheme JSONB` until the SQL is run.

### Phase 3: Backend Service Hardening (COMPLETED)
- **`src/services/questionBankService.ts`**:
  - `batchAttachPastPaperPdf`: `syllabusId: string` is now **strictly mandatory**. Throws an error immediately if missing or empty.
  - Added **Subject-Code Cross-Check**: If the PDF URL contains a recognized subject code (e.g., `0620`), the function asserts that it matches the target syllabus code. Mismatches are rejected with an explicit error.
  - Added **`batchDetachPastPaperPdf`**: Supports unlinking PDFs from a paper group with mandatory `syllabusId`.
  - Updated `fetchDistinctPastPapersSummary` to query the native column with resilient schema fallback.
- **`scripts/upload_igcse_past_papers.cjs`**:
  - Enforced strict subject code matching (`Boolean(qCode) && Boolean(qp.code) && qCode.toLowerCase() === qp.code.toLowerCase()`).

### Phase 4: UI & Modal Enhancements (COMPLETED)
- **`src/pages/QuestionBankPage.tsx`**:
  - Passes `initialSyllabusId={filters.syllabusId}` to `PastPaperPdfManagerModal`.
- **`src/components/PastPaperPdfManagerModal.tsx`**:
  - Added a **Subject Filter Dropdown** at the top (`All Subjects`, `Chemistry (0620)`, `Biology (0610)`, `Geography (0460)`, etc.).
  - Added an **"Unlink"** button to allow teachers to remove an incorrect PDF link from any paper.
  - Added subject code badges (e.g., `Chemistry 0620`, `Biology 0610`) on every row to prevent teacher misclicks.
- **`src/components/PastPaperPdfManagerModal.css`**:
  - Added styling for `.past-paper-filter-bar`, `.past-paper-select`, and `.past-paper-btn-danger`.

---

## 3. Verification Summary

| Check | Result |
| :--- | :--- |
| **Contaminated Questions in DB** | **0** (All 59 rows cleaned) |
| **Chemistry (0620) Valid PDFs** | **666** (Intact and verified) |
| **TypeScript Compilation (`tsc`)** | **0 errors** |
| **Vite Production Build** | **Success (3.8s)** |
