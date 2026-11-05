# Review — `uploadbug1.md` (Paper 53 Q1(a) truncation)

**Status: reviewed and empirically verified against `0620/53/O/N/24` and the live model.**
Every claim below is backed by either a code read or a recorded run; the runs are reproducible with
the probe scripts named in §7.

---

## 1. Verdict

| Aspect | Assessment |
| :--- | :--- |
| Symptom description | Plausible, but **not reproducible** — 0 occurrences in 5 runs (see §3) |
| Line-level citations | **Accurate** — every quoted line number is correct |
| Prompt-conflict analysis (`practicalPrompt.ts:45`) | **Correct and worth fixing** — the file genuinely contradicts itself |
| Attribution to `practicalPrompt.ts` | **Validated** — the outline is usable, so that prompt is the one that runs |
| `data_tables` schema gap (§2.3) | **Real, but mis-ranked** — not causal; and not the table bug that actually bites |
| Page-number claim ("Page 2") | **Correct** — verified; Q1 really does start on PDF page 2 |
| Proposed fix | **Addresses the wrong defect**, and would expose a second one |
| Verification plan | **Inadequate** — a manual re-run cannot catch an intermittent defect |

The report diagnoses a *once-observed* failure and proposes a *prompt rewrite*. The evidence says
otherwise: the prompt+model combo returns correct Q1(a) content on demand, while a **separate,
100%-reproducible table defect** sits underneath — the one the report would walk straight past.

---

## 2. Verified facts about the paper

`node scripts/debug-outline.mjs "<paper>"` and `scratch/dump-pages.mjs`:

```
profile 0620/53 · family practical-5x · totalMarks 40 · usable true · reasons []
pages: 1:cover 2:question 3:question 4:question 5:question 6:question 7:question
       8:blank 9:blank 10:blank 11:notes 12:notes

Q1 starts p2  (a)[5] p2  (b)[4] p3  (c)[1] p3  (d)[2] p3  (e)[2] p4  (f)[2] p4  (g)[4] p4  => 20
Q2 starts p5  9 sub-parts => 14
Q3 starts p7  no sub-parts => 6
```

This settles the report's open questions and one of this reviewer's:

- **The outline is usable**, so `gemini.ts:2692–2711` selects `getCambridgePracticalExtractionPrompt`.
  The report's attribution to `practicalPrompt.ts` is correct; the generic-prompt branch
  (`gemini.ts:143–160`) is **not** involved.
- **`(a)` carries `[5]`** — the mark was attributed to the sub-part, not lost as an unattributed `*`
  artefact. The report's reading of the layout is right.
- **Q1(a) is on PDF page 2** — the report's "Page 2" claim is correct. *(An earlier draft of this
  review doubted it against `paper5update.md:14`; that guess was wrong and is withdrawn — the
  "questions live on pages 3–9" note is not universal, this paper starts on 2.)*
- Active pages = 7 ≤ 9, so `practicalSinglePass` holds and the paper is extracted in **one chunk**.
  Cross-chunk stitching is exonerated.

---

## 3. The reproduction

The app's extraction request is fully specified: prompt builder + QP + MS + `temperature: 0.0`,
`maxOutputTokens: 16384` (`gemini.ts:2527–2531`), model `gemini-3.5-flash-lite`.
`scratch/probe-q1.mjs` and `scratch/probe-repeat.mjs` replay exactly that request.

### 3.1 Result: the reported failure does not reproduce

| Run | `(a)` length | `Experiment 1` | `Experiment 2` | Markdown tables | Tables parent / `(a)` | Table keys |
| :--- | ---: | :--- | :--- | :--- | :--- | :--- |
| probe #1 | 1426 | yes | yes | yes | 2 / 0 | `title, columns, rows` |
| repeat #1 | — | — | — | — | — | **malformed JSON** |
| repeat #2 | 1394 | yes | yes | yes | 2 / 0 | `title, columns, rows` |
| repeat #3 | 1526 | yes | yes | yes | 2 / 0 | `title, columns, rows` |
| repeat #4 | 1396 | yes | yes | yes | 2 / 0 | `title, columns, rows` |

The report's failing output was:

```
Q1(a): "Record results in Table 1.1 and Table 1.2 and calculate temperature decreases. [5]"
```

That sentence appeared **0 times in 5 runs**. Four of five runs returned the full ~1.4k-character
procedure — all six Experiment 1 bullets, both Experiment 2 bullets, the temperature-decrease formula,
and both tables as Markdown. The parent stem was 208 characters (the four intro lines) in every run,
which is *correct* for this layout, not a truncation.

> **Conclusion:** the failure is **intermittent**, not deterministic. A prompt rewrite cannot be
> justified by it, and a single manual re-extraction cannot prove it fixed.

### 3.2 The one reproducible defect

Every parseable run (4 of 4) returned tables shaped:

```json
{ "title": "Table 1.1", "columns": ["time/s", "0", "20", ...], "rows": [["temperature/°C", "", ...]] }
```

`practicalPrompt.ts:55` and `:97` ask for **`columns`**. The `ExamDataTable` contract requires
**`headers`** (`database.ts:149`), and every consumer drops tables that lack it:

| Consumer | Code | Result with `columns` |
| :--- | :--- | :--- |
| Question card (UI) | `ExamDataTable.tsx:29` filters on `Array.isArray(t.headers)` | table silently **invisible** |
| PDF export | `pdfExportService.ts:384` | `''` |
| Table image renderer | `tableImageRenderer.ts:342` | `null` |
| Google Forms | `extractStructuredTable` → same renderer | `null` |

Nothing in `src` maps `columns` → `headers` (verified: no `.columns` read on any `data_tables` path).
Only `practicalPrompt.ts` uses `columns`; the generic prompt (`gemini.ts:377, 456, 566`) and the
variant generator (`gemini.ts:3290`) both correctly say `headers`.

So the paper **passes the harness** (`RESULT: PASS`, `data_tables=3`) while every extracted table is
unrenderable in the product. The tables exist in JSON and vanish at the last mile.

### 3.3 The second defect the fix would expose

All four runs put both tables on the **parent** while `(a)` keeps its own Markdown copies. That is
latent duplication, currently masked by §3.2:

- `pdfExportService.ts:768–772` — the stem has no Markdown table → `renderDataTablesToHtml(q.data_tables)`
  is appended **to the stem**, after the four intro lines and *before* `(a)`; and `(a)`'s own Markdown
  tables render again at `:815–819`.
- `QuestionCard.tsx:269–271` renders parent `data_tables` under the stem, while `ExamMathText`
  renders `(a)`'s Markdown tables inside `(a)` (its markdown-table parser is `ExamMathText.tsx:495+`).

Fix only the key name and this paper renders **Table 1.1 and Table 1.2 twice, once in the wrong
place**. The report's proposal to add `data_tables` to `sub_questions` makes it worse by giving the
model a second legal home for the same table. Key rename and an explicit ownership rule must land
**together**.

### 3.4 A reliability signal worth instrumenting

Repeat #1 returned syntactically invalid JSON — `\u00frac{temperature decrease}{time}` instead of
`\\frac`. `parseRobustJson` (`gemini.ts:2331`) has seven repair attempts, including
`extractQuestionsArrayFallback` (attempt 6), which reconstructs questions item by item. That path is
the most plausible remaining explanation for a one-off summarized `(a)`: a malformed first response,
salvaged partially, persisted without anyone noticing.

It is a hypothesis, not a finding — but it is testable by logging when `parseRobustJson` only succeeds
at attempts 2–6, and it explains why the failure is rare and paper-specific. Instrument it rather than
rewriting the prompt.

---

## 4. Where the report is wrong

1. **§1 treats a one-off as deterministic.** It was observed once and does not reproduce. Present it
   as "observed on one upload, not reproducible in 5 attempts", with the request config recorded.
2. **§2.2 overstates §45 as sole cause.** The rule is contradictory and should be fixed, but the model
   resolved it correctly in 4/4 parseable runs. Rank it as a latent risk, below §3.2.
3. **§2.3 is mis-ranked and mis-aimed.** Tables can legally live on the parent, so the missing
   sub-level property did not *force* an empty result. More importantly, "tables are missing" is true
   right now for a different reason: the tables exist and are discarded by the renderers (§3.2). The
   report proposes a second home for tables while the first home is broken.
4. **§4.4 is not a gate.** One manual re-extraction cannot detect an intermittent regression, and it
   would not catch §3.2 — the harness already reports PASS on it.
5. **The "parent stem only captured 4 lines" framing is wrong.** The intro *is* the whole stem; any
   "fix" that copies the procedure into the stem duplicates it, which `gemini.ts:167` forbids.

---

## 5. Corrected fix plan

**Fix 1 — `practicalPrompt.ts:55, 97`: `columns` → `headers`.** Both occurrences. Highest value per
character in the whole report. Verify by asserting `data_tables[0]` has a `headers` array.

**Fix 2 — `practicalPrompt.ts:55`: one owner per table.**
> A table belongs to the innermost printed container that holds it. A table printed after a sub-part
> label goes on that sub-part only, and the parent's `data_tables` stays empty. Never store the same
> table at both levels.

This is what makes Fix 1 safe (§3.3), and it is what the report's §4.3 should have said instead of
"sub-question level or parent level as appropriate".

**Fix 3 — `practicalPrompt.ts:45`: make the layout rule conditional, not assumed.** Keep the
"verbatim, never summarise" intent; drop the claim that the stem *always* holds `Experiment 1…n`:
> - The parent `question_text` is the printed stem before the first sub-part label. Stop there.
> - A sub-part's `question_text` runs from its label to the next label. If a sub-part label is
>   followed by `Experiment 1`…`Experiment n`, those blocks belong to that sub-part and must be
>   transcribed in full — every bullet, volume, mass and formula.
> - Never replace printed content with a description of what the candidate should do.

**Fix 4 — `scripts/extract-paper5.mjs`: make the harness able to fail.** `findProblems` (`:100–144`)
checks ids, order, marks and reference-page leakage only; `:248` merely *counts* tables. Add:
- every `data_tables` entry has `Array.isArray(entry.headers)` — catches §3.2 immediately;
- every `Table \d\.\d` appears in exactly one `data_tables` array across parent + subs — catches §3.3;
- a question whose printed text holds `Experiment n` must have those blocks in its owning text;
- a sub-part text-length floor, so a 60-character `(a)` against a full-page part fails loudly.

**Fix 5 — instrument the repair path.** Log when `parseRobustJson` only succeeds at attempts 2–6,
with paper and question, so a lossy salvage becomes visible instead of silent.

**Fix 6 — regression sweep, not one paper.** After Fixes 1–3, re-run the 24-paper sweep. Fix 1 changes
table output on every practical paper; a single-paper check cannot see that.

---

## 6. What to tell the reporter

The Q1(a) text they lost was most likely a one-off model or repair-path event, not a stable prompt
defect — the same upload now returns the full procedure. What *is* reliably broken is that results
tables never display anywhere, which looks smaller but is permanent. Both deserve a fix; only one of
them was in the report.

---

## 7. Reproducing this review

```powershell
node scripts/debug-outline.mjs "…\0620 Chemistry November 2024 Question paper  53.pdf"
node scratch/dump-pages.mjs   "…\0620 Chemistry November 2024 Question paper  53.pdf"
node scratch/probe-q1.mjs     "<qp.pdf>" "<ms.pdf>" 16384      # full Q1 dump
node scratch/probe-repeat.mjs "<qp.pdf>" "<ms.pdf>" 4          # repeatability
```

`scratch/probe-*.mjs` read `GEMINI_API_KEY` / `GEMINI_MODEL` from the environment. Observed cost per
run: ~7.9k input, ~3.9k output tokens, 10–20 s.
