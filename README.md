# 🏛️ ICM Exam Platform • Cambridge International School

An intelligent, AI-powered examination authoring studio and interactive student assessment platform for **Insan Cendekia Madani (ICM)** in partnership with **Cambridge Assessment International Education**. Upload past paper PDFs, extract questions, options, and diagrams automatically with Google Gemini multimodal AI, build customized Cambridge-grade exam papers, host live gamified quiz arenas, conduct proctored assessments, evaluate offline paper exams with automated Excel grading, and generate printable student diagnostic reports.


---

## ✨ Key Features

### 🧠 1. Multimodal AI Extraction & Fault-Tolerant Parsing
- **Gemini Multimodal AI**: Automatically parses past paper PDFs and mark schemes into structured question stems, sub-questions ((a)(i), (b)), MCQ options, topics, difficulty ratings, and official marking criteria.
- **IELTS & Cambridge Cloze / Gap-Fill Parsing**: Automatically converts dotted/underlined blanks in listening forms, sentence completion, and notes completion into structured `[1]`, `[2]` inline gap tokens with per-blank mark scheme criteria.
- **High-Resolution Diagram Cropper**: Automatic canvas-based diagram detection with interactive bounding-box cropping, multi-pass boundary expansion, and WebP compression.
- **Robust JSON Repair Engine**: Multi-pass repair and balanced-brace fallback algorithms that smoothly recover questions even during network anomalies or long token generations.
- **LaTeX Math & Chemistry Normalization**: Automatic formatting and KaTeX rendering for nuclide/isotope symbols (`^{40}_{20}\text{Ca}`), chemical ions/formulas (`Ca^{2+}`, `SO_4^{2-}`), escaped percentages, temperatures (`°C`), and reaction arrows.

### 🎧 2. IELTS & Cambridge Audio Listening Suite
- **Persistent Top Listening Bar**:
  - Persistent audio player positioned below the exam navigation bar that stays active and plays uninterrupted across related question ranges.
  - **🔒 Strict Exam Security**: In Formal Exam Mode, rewind, fast-forward, and seeking are completely disabled with a real-time read-only progress meter. Speed is locked strictly at $1.0\times$ and transcript access is gated.
  - **⏱️ Play Limit Enforcement**: Supports 1 Play (Strict Exam), 2 Plays (Cambridge standard), 3 Plays, or Unlimited Practice with real-time remaining play counters.
- **Multi-Section Audio Timeline & Mapping Manager**:
  - Visual segmented coverage meter showing all questions with color-coded listening sections.
  - **`🪄 4 IELTS Sections` Auto-Divider**: Instantly partitions assessments into 4 equal quarters (e.g. Q1–10, Q11–20, Q21–30, Q31–40).
  - Configure multiple audio tracks simultaneously with customizable start/end question ranges.
- **Central Audio Library & Gallery**:
  - Cloud-stored audio repository for reusing listening tracks across quizzes with automatic canonical key deduplication.
  - Supports browser file uploads (compressed via Opus audio), direct microphone voice recording, and AI Text-to-Speech (TTS).

### ✍️ 3. IELTS-Style Inline Gap Fill (Cloze & Form Completion)
- **In-Place Interactive Inputs**:
  - Gaps defined in question stems or sub-questions (e.g. `Customer Name: [1]`, `Address: 42 [2] Avenue`) are rendered as focused input fields embedded directly in the flow of the sentence, form, or table.
  - **Keyboard Navigation**: Pressing `Tab` or `Enter` seamlessly cycles to the next numbered blank.
- **Deterministic Multi-Gap Grading Engine**:
  - Evaluates each gap individually against mark scheme alternative keys (e.g. `[1] John Smith / J. Smith`).
  - Casing-tolerant, whitespace-normalized, punctuation-stripped, and handles numeric vs number word equivalence (`15` $\leftrightarrow$ `fifteen`).
  - Proportional mark scoring accurately awards partial credit per correct blank.
- **Solutions & Review Feedback**:
  - Renders student responses inline with green checkmarks and expected answer hints during solution review and PDF diagnostic exports.

### 🏛️ 4. Publication-Quality Cambridge & School Exam Export
- **Authentic Cambridge IGCSE Cover Pages**:
  - Dual Header Logos (School Crest on top left, Cambridge Assessment on top right).
  - Dynamic instructions adapting for Paper 1/2 (Multiple Choice) vs. Paper 3/4 (Theory & Structured).
  - Accurate bold page counts and centered examination headers.
- **🧪 Cambridge IGCSE Chemistry Periodic Table Drawer**:
  - Official 118-element periodic table including Lanthanoid and Actinoid series, key legend, and gas volume constant ($24\text{ dm}^3$ at r.t.p.).
  - Available as an upright landscape reference drawer with interactive zoom and pan during digital exams, as well as an exportable print sheet.
- **🗺️ Social Science & Humanities Insert Booklets**:
  - Standalone Resource Insert generation for Geography, History, Sociology, Economics, and Business Studies.
  - Automatic figure and table renumbering across assembled multi-question exam papers.
  - Export Resource Booklets to both **Microsoft Word (`.docx`)** and printable **PDF** formats with authentic Cambridge layouts.
- **📄 Multi-Format High-Fidelity Exports**:
  - **Microsoft Word (`.docx`)**: Native mathematical formulas, sub/superscripts, Cambridge headers, and mark scheme tables.
  - **Camera-Ready PDF**: Printable student test papers, mark schemes, and MCQ bubble answer sheets with ~8mm handwriting lines.
  - **Standalone Offline HTML Quizzes**: Completely self-contained interactive quizzes that run in any web browser without an internet connection or server.

### 🎮 5. Interactive Student Assessment & Gamified Arenas
- **Dual Assessment Modes**:
  - **🚀 Quizizz-Inspired Gamified Sprint Arena**: Synthesized Web Audio engine (`gameSoundEngine.ts`) with custom chords, thuds, streak fanfares, countdown ticks, and finish jingles. Features streak multipliers, speed bonuses, and interactive celebration confetti.
  - **🛡️ Formal Proctored Exam Mode**: Fullscreen exam lockdown with automatic re-entry, tab-switch and blur detection, proctor strike logging, 5-minute and 1-minute audio-visual time alerts, and invigilator PIN unlock gates.
- **🧑‍🏫 Live Multiplayer Game Host Controller**:
  - Teachers can launch live multiplayer quiz sessions with real-time student leaderboards, live answer monitoring, and podium celebrations.
- **In-App Student Tooling**:
  - Integrated Cambridge Periodic Table drawer, on-screen Scientific Calculator (trig, roots, powers, parentheses), and Resource Booklet drawers.

### 📝 6. Offline Exam Grading & Batch Excel Workflow
- **Custom Excel Mark-Entry Templates**:
  - Generates bespoke multi-sheet Excel templates matching the exact questions, sub-questions, and official mark schemes of any assembled exam.
- **Deterministic Auto-Grading & Header Mapping**:
  - Robust column mapping with word-boundary matching and duplicate collision prevention.
  - Automatic MCQ answer normalization (handles `D`, `Option D`, `(D)`, or option text) evaluated against official Cambridge mark keys.
- **Central Gradebook Integration**:
  - Saves offline scored exam results directly into the assessment hub for permanent record-keeping, item analysis, and report generation.

### 📊 7. 3-Tier Diagnostic Reports & Personalized Feedback
- **🎓 1-Page Student Performance & Improvement Report**:
  - Compact, single A4 page printable report designed to give directly to students.
  - Displays total score, percentage, question-by-question candidate response vs official mark scheme, and topic mastery bars.
  - **Personalized Diagnostic & Improvement Plan**: Highlights *What Went Well*, *Priority Focus Areas*, *Targeted Next Steps*, and encouraging teacher guidance.
  - **Ink-Saving Clean Design**: High-contrast, ink-friendly layout with no heavy background fills.
  - **Review Signatures**: Designated signature areas for **Subject Teacher** and **Parent / Guardian** acknowledgment.
- **🌟 Prestige Grade Tier-List Color Hierarchy**:
  - Distinct rarity color scheme: **A\*** (Legendary Gold), **A** (Epic Emerald), **B** (Rare Sapphire), **C** (Uncommon Amethyst), **D** (Bronze), **E** (Ruby Coral), **U** (Shadow Slate).
- **🏫 Class-by-Class & Cohort Summary Reports**:
  - Filterable by class/section (`10-A`, `10-B`, or All Classes).
  - Cohort KPI ribbons (class average, highest/lowest scores, pass rates), grade band distributions, topic mastery bars, and student rankings.
- **📥 Master Excel Gradebook**:
  - Multi-tab workbook with student rosters, question-level item analysis, accuracy percentages, and average earned marks.

---

## 🛠️ Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Vanilla CSS Design System
- **Math & Chemistry**: KaTeX, Custom Formula & Chemical Ion Parser
- **PDF Engine**: PDF.js with high-resolution offscreen canvas rendering & `pdf-lib`
- **Audio Engine**: Web Audio API Synthesizer (`gameSoundEngine.ts`), Opus WebP Audio Compression
- **AI Backend**: Google Gemini Multimodal APIs (Flash & Pro with dynamic discovery)
- **Database & Storage**: Supabase (PostgreSQL + Supabase Storage for diagrams and audio)
- **Export Engines**: `docx` (Word), `pdf-lib` / HTML5 Print Engine (PDF), `xlsx` (Excel)

---

## 🚀 Getting Started

### 1. Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher)
- A free [Supabase](https://supabase.com) account
- A free [Google AI Studio](https://aistudio.google.com/apikey) API key

### 2. Clone & Install
```bash
git clone https://github.com/fluffykitten/testmaker.git
cd testmaker
npm install
```

### 3. Environment Variables
Create a `.env.local` file in the project root:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
VITE_GEMINI_API_KEY=your-gemini-api-key
```

### 4. Database Setup
Run the SQL migrations in order in your **Supabase SQL Editor**:
1. `supabase/migrations/001_initial_schema.sql` — Tables for syllabuses, questions, custom tests
2. `supabase/migrations/002_fix_custom_tests_rls.sql` — RLS policies for custom tests
3. `supabase/migrations/003_fix_all_rls_policies.sql` — Public read and modification policies
4. `supabase/migrations/004_app_config.sql` — PIN configuration
5. `supabase/migrations/005_add_options_column.sql` — Multiple choice options support
6. `supabase/migrations/006_add_insert_diagram_columns.sql` — Resource insert and diagram reference columns
7. `supabase/migrations/007_quiz_submissions.sql` — Student submissions, scores, and proctoring logs

### 5. Run Locally
```bash
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

### 6. Build for Production
```bash
npm run build
```

### 7. Native Mobile Apps (Android & iOS)
This project is packaged with **Capacitor** for **1:1 feature parity** across Web, Android, and iOS.

```bash
# Build web assets and sync to native Android and iOS folders
npm run mobile:build

# Open the project in Android Studio (Windows, Mac, Linux)
npm run mobile:android

# Open the project in Xcode (macOS)
npm run mobile:ios
```
- **Android APK**: In Android Studio, go to `Build > Build Bundle(s) / APK(s) > Build APK(s)`.
- **Google Play Store**: Generate a signed `.aab` bundle using `Build > Generate Signed Bundle / APK`.
- **iOS App**: Open in Xcode, select your signing team, and archive for TestFlight / App Store Connect.

---

## 📜 Changelog

### [v.2.3.5] — Cambridge IGCSE Geography, IGCSE Economics & Proctor/Submission Hardening
- **Cambridge IGCSE Geography (`0460`) Support**:
  - Registered syllabus `0460` profile in `subjectClassifier.ts` with insert booklet by default, optional-choice paper rules, and standard total marks (Paper 1: 75 marks, Paper 2: 60 marks).
  - Enhanced column clustering in `paperOutlineParse.ts` to inspect second tokens (`line.items[1]`) on packed question lines (`1 (a) Study Fig. 1.1...`), ensuring part letter column ($X=72$) correctly wins over roman numeral column ($X=96$) and eliminating false duplicate/unattributed sub-question rejections.
  - Added 3-tier section option group recognition for Paper 1 ("one from each section"), cleanly partitioning Section A (Q1–Q2), Section B (Q3–Q4), and Section C (Q5–Q6) while preserving 100% compulsory rules for Paper 2.
  - Added offline verification suite `scripts/verify-igcse-geography.mjs` (7/7 passing across QP, MS, and Insert documents) and multimodal extraction simulation `scripts/simulate-igcse-geography-extraction.mjs` ($150\text{ printed marks}$ sum for Paper 1, $60\text{ printed marks}$ sum for Paper 2).
- **Cambridge IGCSE Economics (`0455`) Support**:
  - Full support for Paper 1 30-MCQ papers and Paper 2 structured papers with compulsory Section A (30 marks) and two-tier Section B option groups (`Section B: choose 3 of 4 (Q2–Q5)`).
  - Added `scripts/verify-economics.mjs` test suite (20/20 passing across 2022–2026 series) and live multimodal simulation.
- **Exam Mode Submission & Live Proctoring Resilience**:
  - Unwrapped boolean return on student draft resume (`alreadySubmitted.submitted`), unblocking students from resuming active exam drafts after reload/crash.
  - Preserved AI and teacher-assigned marks on structured/essay questions during deterministic re-grading (`det.isHandled` check).
  - Enforced strict deadline preservation on draft resume and candidate-scoped session storage isolation on shared school laptops.
  - Added offline outbox retry with exponential backoff for failed submissions and isolated student result lookup.
  - Added proctoring audit log persistence (`018_proctor_audit_events.sql`), host channel cleanup, command deduplication, and presence sweep based on receipt timestamps.

### [v.2.3.4] — Cambridge AS & A Level Geography & Multimodal Timeout Resilience
- **Cambridge International AS & A Level Geography (`9696`) Support**:
  - Registered syllabus `9696` profile with automatic insert booklet configuration, two-tier optional-choice paper rules, and 60-mark standard total calculation.
  - Fixed Section B packed question line parsing in `paperOutlineParse.ts` (`4 (a) (i) Define... [4]` now cleanly captures both the question container and the inline sub-part).
  - Added section-aware option groups (`Section B: choose 1 of 3 (Q4–Q6)`), preventing mutually exclusive questions from being combined into the same test paper.
- **Adaptive Gemini Timeout & Output Capacity**:
  - Raised client-side API timeout from 35s to **150s (2.5 minutes)** for multi-document payloads (Question Paper + Insert Booklet + trimmed Mark Scheme), resolving `AbortError: signal is aborted without reason` when running `gemini-3.8-flash`.
  - Increased `maxOutputTokens` from 16,384 to **32,768** to prevent truncation of detailed mark scheme rubrics on extended humanities papers.
- **Verification Suites**:
  - Added `scripts/verify-as-geography.mjs` verifying outline totals (`10/10/10/30/30/30`), section option groups, rubric-safe trimming, and insert resources across May/June 2025 and Oct/Nov 2024 series (6/6 passing).
  - Added `scripts/simulate-geography-extraction.mjs` for benchmarking multimodal extraction across Gemini models.

### [v.2.3.3] — Cambridge IGCSE Sociology & Safe Rubric Trimming
- **Cambridge IGCSE Sociology (`0495`) Pipeline**:
  - Full support for in-paper stimulus `"Source A"`, shared lead-in definition prompts, and 8–14 mark Level 1–4 response grids.
  - Safe mark scheme preamble trimmer (`detectMarkSchemeTableStart`) with dual boundary detection, preserving Tables A–D criteria while stripping administrative boilerplate.
  - Added deterministic subject classification engine (`subjectClassifier.ts`).
  - Added `scripts/verify-sociology.mjs` test suite (24/24 passing across June and November series).
- **Client Deployment Resilience**:
  - Intelligent chunk-reload error boundary handling stale production bundles and lazy-loaded assets.
  - Paginated `fetchDistinctPastPapersSummary` to eliminate truncation in the Source PDF Manager.

### [v.2.3.2] — Google Forms Export & Touchscreen Security Shield
- **Google Forms Integration**:
  - Export custom assessments directly to auto-graded Google Forms quizzes with custom answer keys, point values, and Apps Script generation.
- **Touchscreen & Tablet Exam Lockdown**:
  - Enhanced student exam runner with pinch-to-zoom controls, touch gesture guards, and focus-loss event logging for iPad and Android tablet proctoring.

### [v.2.3.1] — Configurable AI Models & Architecture Plans
- **Dynamic Model Selection**:
  - Configurable Gemini extraction model in Admin Settings (`gemini-3.5-flash-lite`, `gemini-3.8-flash`, `gemini-2.5-pro`) with real-time model discovery and cloud sync.
- **Standardized Architecture Planning**:
  - Enforced repository standard for feature blueprints and architectural plans in `Plan/`.

### [v.2.3.0] — Cambridge Science Practical Papers & Cloudflare R2 Storage
- **Science Practical Examination Pipeline**:
  - Dedicated parser for Cambridge IGCSE Paper 5 & Paper 6 Practical and Alternative to Practical papers.
  - Automated qualitative analysis notes extraction, apparatus diagrams, and chemical test reagents catalog.
- **Cloudflare R2 Storage Bridge**:
  - High-speed CDN hosting for insert booklet PDFs, high-resolution maps, and Table of Specifications source citations.

### [v.2.2.0] — Multi-Class Live Proctoring & Heartbeat Scalability
- **Unified School-Wide & Multi-Class Proctoring Cockpit**:
  - Live proctor dashboard allowing invigilators to monitor multiple concurrent classes with active student progress, time warnings, and violation strike counters.
- **Heartbeat Jitter & Micro-Batching**:
  - 300ms heartbeat micro-batching and randomized jitter protection to eliminate server load spikes during high-concurrency school exam sessions.
  - Dynamic roster reconciliation with automated attendance tracking.

### [v.2.1.0] — Bloom's Taxonomy & Table of Specifications (ToS)
- **Cognitive Level Tagging**:
  - Automatic classification of questions into Bloom's Taxonomy levels (C1 Knowledge to C6 Evaluation).
- **Curriculum Table of Specifications (ToS)**:
  - One-click export to landscape Microsoft Word (`.docx`) containing question types, cognitive weightings, mark distributions, and Cambridge citation links.
- **Configurable Grade Thresholds**:
  - Interactive curve tuner with $A^*$ to $U$ percentage thresholds and exportable diagnostic grade distributions.

### [v.2.0.0] — Platform Redesign & Save My Exams Pack Ingestion
- Major UI/UX redesign for Insan Cendekia Madani (ICM) Cambridge International School.
- Ingestion support for Save My Exams structured theory and revision packs.
- Integrated Web Audio synthesizers (`gameSoundEngine.ts`) for gamified quiz arenas.

---

## 📄 License
MIT License. Created with 🐾 by [fluffykitten](https://github.com/fluffykitten).
