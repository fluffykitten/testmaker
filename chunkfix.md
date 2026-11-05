# PDF Buffer Detachment Diagnosis & Fix Implementation Plan (`chunkfix.md`)

## 1. Overview & Problem Statement

During exam paper uploads in TestMaker, the browser console intermittently outputs the following warning:

```text
[paperOutline] outline unavailable, falling back to vision extraction: TypeError: Cannot perform %TypedArray%.prototype.slice on a detached or out-of-bounds ArrayBuffer
    at Uint8Array.slice (<anonymous>)
    at readPdfTextLayout (paperOutline.ts:25:56)
    at buildPaperOutline (paperOutline.ts:62:23)
    at tryBuildPaperOutline (paperOutline.ts:69:18)
    at splitPdfForParallelExtraction (pdfChunker.ts:229:27)
    at async runExtractionPipeline (pdfProcessor.ts:710:16)
    at async UploadPage.tsx:164:66
```

While uploads do not crash completely (falling back to standard multimodal Gemini extraction), this error causes **silent feature degradation**:
1. **Practical Papers (0620 / 0625 Paper 5 / 51 / 52 / 53)** fail to execute their single-pass extraction (`practicalSinglePass`), causing them to be artificially split into chunks with page overlaps. This risks cutting multi-page practical questions across chunks and producing duplicate or mis-stitched sub-questions.
2. **Deterministic Structure Guidance** is bypassed for standard theory papers, depriving Gemini of pre-calculated question boundaries, Roman numerals, and mark allocations.
3. **Latent Data Corruption Risk**: In single-pass scenarios, `uint8ArrayToBase64(rawBytes)` attempts to read from the detached buffer, risking sending an empty payload `""` to Gemini.

---

## 2. Root Cause Analysis

### A. TypedArray Views vs. Independent Buffers
In JavaScript, constructing a `Uint8Array` with an existing `ArrayBuffer`:
```ts
new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength)
```
does **not** clone or copy memory. It merely creates an alternate view pointing directly to `rawBytes.buffer`.

### B. Web Worker Transferable Objects
`pdfjs-dist` executes in a browser Web Worker. When a TypedArray or ArrayBuffer is supplied to `pdfjsLib.getDocument({ data: ... })`, PDF.js passes the underlying `ArrayBuffer` in the `postMessage` transfer list to avoid an IPC memory copy.

Under the ECMAScript and HTML Structured Clone specifications:
- Any `ArrayBuffer` transferred in a worker message is immediately **detached** on the sending thread.
- The sender's `ArrayBuffer.byteLength` drops to `0`.
- All `TypedArray` views attached to that buffer become detached / out-of-bounds.

### C. The Cascade
1. [`splitPdfForParallelExtraction`](file:///c:/testmaker/src/lib/pdfChunker.ts#L215) creates `rawBytes`.
2. It passes `rawBytes` into [`detectEffectiveQuestionPageCount`](file:///c:/testmaker/src/lib/pdfChunker.ts#L171).
3. `detectEffectiveQuestionPageCount` passes `new Uint8Array(rawBytes.buffer, ...)` to `pdfjsLib.getDocument`. The worker detaches `rawBytes.buffer`.
4. Right after, `splitPdfForParallelExtraction` calls `tryBuildPaperOutline(rawBytes)`.
5. Inside [`readPdfTextLayout`](file:///c:/testmaker/src/lib/paperOutline.ts#L23), calling `bytes.slice()` throws `TypeError: Cannot perform %TypedArray%.prototype.slice on a detached or out-of-bounds ArrayBuffer`.

---

## 3. Forensic Findings Across the Codebase

Three locations in [`src/lib/pdfChunker.ts`](file:///c:/testmaker/src/lib/pdfChunker.ts) exhibit this identical flaw:

| Location in `src/lib/pdfChunker.ts` | Code Pattern | Impact when Detached |
| :--- | :--- | :--- |
| **Line 174** (`detectEffectiveQuestionPageCount`) | `data: new Uint8Array(rawBytes.buffer, ...)` | Detaches `rawBytes`. Breaks subsequent `tryBuildPaperOutline(rawBytes)` and `uint8ArrayToBase64(rawBytes)`. |
| **Line 68** (`detectAndSplitInDocumentAnswerKey`) | `data: new Uint8Array(rawBytes.buffer, ...)` | Detaches `rawBytes`. Breaks subsequent `PDFDocument.load(rawBytes)` on line 105 and corrupts `qpDocBytes: rawBytes` on line 74. |
| **Line 366** (`detectSaveMyExamsMetadata`) | `data: new Uint8Array(rawBytes.buffer, ...)` | Detaches `rawBytes`. Breaks subsequent `splitPdfForParallelExtraction(rawBytes)` on line 553 and `PDFDocument.load(rawBytes)` on line 557. |

### Architectural Inconsistency
In contrast, [`src/lib/paperOutline.ts` (line 25)](file:///c:/testmaker/src/lib/paperOutline.ts#L25) and [`src/lib/markSchemeTrim.ts` (line 32)](file:///c:/testmaker/src/lib/markSchemeTrim.ts#L32) already use `data: bytes.slice()`. Only `pdfChunker.ts` was using the shared buffer constructor view.

### Missing Worker Cleanup
None of the three inspection functions in `pdfChunker.ts` were invoking `await pdfJsDoc.destroy()`. Consequently, parsed page trees and font caches remained trapped in the PDF.js worker thread indefinitely.

---

## 4. Risk & Side-Effect Evaluation

1. **Memory & Performance**:
   - Calling `rawBytes.slice()` allocates a transient clone of the PDF (typically 1–4 MB).
   - In modern V8/Chromium, copying 3 MB takes under 0.5 ms.
   - Once transferred to the worker, the main thread reference is immediately released for garbage collection.
   - Zero risk of memory leaks or out-of-memory errors.
2. **Offset Safety**:
   - `rawBytes.slice()` copies from `byteOffset` to `byteOffset + byteLength`, producing a new buffer with `byteOffset === 0`. This is strictly safer than accessing `.buffer` directly, which could unintentionally expose outer buffer memory if the typed array was a sub-slice.
3. **Downstream Safety**:
   - Preserves `rawBytes` so downstream callers (`paperOutline`, `PDFDocument.load`, `uint8ArrayToBase64`) receive complete, intact data.

---

## 5. Fix Implementation Plan

### Step 1: Update `detectEffectiveQuestionPageCount`
In `src/lib/pdfChunker.ts`:
- Change `data: new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength)` to `data: rawBytes.slice()`.
- Wrap the page loop in a `try ... finally` block that invokes `await pdfJsDoc.destroy()` to ensure worker resources are cleanly recycled.

### Step 2: Update `detectAndSplitInDocumentAnswerKey`
In `src/lib/pdfChunker.ts`:
- Change `data: new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength)` to `data: rawBytes.slice()`.
- Wrap inspection in a `try ... finally` block invoking `await pdfJsDoc.destroy()`.

### Step 3: Update `detectSaveMyExamsMetadata`
In `src/lib/pdfChunker.ts`:
- Change `data: new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength)` to `data: rawBytes.slice()`.
- Wrap inspection in a `try ... finally` block invoking `await pdfJsDoc.destroy()`.

### Step 4: Verification & Build Validation
- Run TypeScript compiler checks (`npx tsc -b`) to verify strict typing and async cleanup syntax.
- Run project build (`npm run build`) to ensure bundle integrity.
- Verify that paper uploads (including Cambridge Practical papers and standard papers) parse outlines cleanly without console warnings.

---

## 6. Implementation Record (2026-11-05)

**Applied — Steps 1–3**, all in `src/lib/pdfChunker.ts`:

- The three `new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength)` views are now `rawBytes.slice()`.
- Each inspection function is split into a thin exported wrapper plus an inner function whose document is destroyed in `finally`. This was done by extracting the body rather than nesting a second `try`, so the diff is 57 insertions / 21 deletions with **no re-indentation of existing logic**.
- **API correction to the plan:** `destroy()` does not exist on `PDFDocumentProxy` in pdfjs-dist v6 (it exposes `cleanup()`); it lives on the loading task. The code therefore keeps `pdfjsLib.getDocument(...)` in a `loadingTask` const and calls `await loadingTask.destroy()`. The plan's `pdfJsDoc.destroy()` would not compile.
- Extra hardening (same bug class): the `detectAndSplitInDocumentAnswerKey` failure fallback now uses `fileOrBytes.slice().buffer` instead of `fileOrBytes.buffer`, so a typed-array sub-view can no longer expose or re-detach the outer buffer.

**Verification**

| Check | Result |
|---|---|
| `tsc -b` (full project) | exit 0 |
| `vite build` | exit 0, built in 2.88s (only pre-existing chunking warnings) |
| Remaining `new Uint8Array(x.buffer, …)` in `src/lib` | none — `pdfChunker.ts` clean |
| All three `getDocument` calls in `pdfChunker.ts` | `data: rawBytes.slice()` |
| Detachment semantics (`scratch/check-detached-buffer.mjs`) | reproduces the report's exact `TypeError: Cannot perform %TypedArray%.prototype.slice on a detached ArrayBuffer` for a shared view; a pre-made copy survives the transfer |
| Browser confirmation | **outstanding** — needs a real upload |

**Out of scope, checked and safe:** `passageExtractor.ts:33` and `diagramCropper.ts:702,709` hand their bytes straight to pdf.js, but every one of those buffers is used once and never read afterwards, so detachment cannot corrupt them. They also never call `destroy()` — the same worker-cache leak in different functions; not changed here.


