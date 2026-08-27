# 🐱 fluffykitten's test maker

An intelligent, AI-powered examination authoring studio and interactive student assessment platform. Upload past paper PDFs, extract questions, options, and diagrams automatically with Google Gemini multimodal AI, build customized Cambridge-grade exam papers, host live gamified quiz arenas, conduct proctored assessments, and generate printable cohort diagnostic reports.

Created with 🐾 by [**fluffykitten**](https://github.com/fluffykitten).

---

## ✨ Key Features

### 🧠 1. Multimodal AI Extraction & Fault-Tolerant Parsing
- **Gemini Multimodal AI**: Automatically parses past paper PDFs and mark schemes into structured question stems, sub-questions ((a)(i), (b)), MCQ options, topics, difficulty ratings, and official marking criteria.
- **High-Resolution Diagram Cropper**: Automatic canvas-based diagram detection with interactive bounding-box cropping, multi-pass boundary expansion, and WebP compression.
- **Robust JSON Repair Engine**: Multi-pass repair and balanced-brace fallback algorithms that smoothly recover questions even during network anomalies or long token generations.
- **LaTeX Math & Chemistry Normalization**: Automatic formatting and KaTeX rendering for nuclide/isotope symbols (`^{40}_{20}\text{Ca}`), chemical ions/formulas (`Ca^{2+}`, `SO_4^{2-}`), escaped percentages, temperatures (`°C`), and reaction arrows.

### 🏛️ 2. Publication-Quality Cambridge & School Exam Export
- **Authentic Cambridge IGCSE Cover Pages**:
  - Dual Header Logos (School Crest on top left, Cambridge Assessment on top right).
  - Dynamic instructions adapting for Paper 1/2 (Multiple Choice) vs. Paper 3/4 (Theory & Structured).
  - Accurate bold page counts and centered examination headers.
- **🧪 Cambridge IGCSE Chemistry Periodic Table Drawer**:
  - Official 118-element periodic table including Lanthanoid and Actinoid series, key legend, and gas volume constant ($24\text{ dm}^3$ at r.t.p.).
  - Available as an upright landscape reference drawer with interactive zoom and pan during digital exams, as well as an exportable print sheet.
- **🗺️ Social Science & Humanities Insert Booklets**:
  - Standalone Resource Insert generation for Geography, History, Sociology, Economics, and Business Studies.
  - Extracts case studies, figures, maps, and data tables into a dedicated reference drawer and printable insert.
- **📄 Multi-Format High-Fidelity Exports**:
  - **Microsoft Word (`.docx`)**: Native mathematical formulas, sub/superscripts, Cambridge headers, and mark scheme tables.
  - **Camera-Ready PDF**: Printable student test papers, mark schemes, and MCQ bubble answer sheets with ~8mm handwriting lines.
  - **Standalone Offline HTML Quizzes**: Completely self-contained interactive quizzes that run in any web browser without an internet connection or server.

### 🎮 3. Interactive Student Assessment & Gamified Arenas
- **Dual Assessment Modes**:
  - **🚀 Quizizz-Inspired Gamified Sprint Arena**: Synthesized Web Audio engine (`gameSoundEngine.ts`) with custom chords, thuds, streak fanfares, countdown ticks, and finish jingles. Features streak multipliers, speed bonuses, and interactive celebration confetti.
  - **🛡️ Formal Proctored Exam Mode**: Fullscreen exam lockdown with automatic re-entry, tab-switch and blur detection, proctor strike logging, 5-minute and 1-minute audio-visual time alerts, and invigilator PIN unlock gates.
- **🧑‍🏫 Live Multiplayer Game Host Controller**:
  - Teachers can launch live multiplayer quiz sessions with real-time student leaderboards, live answer monitoring, and podium celebrations.
- **In-App Student Tooling**:
  - Integrated Cambridge Periodic Table drawer, on-screen Scientific Calculator (trig, roots, powers, parentheses), and Resource Booklet drawers.

### 📊 4. Intelligent Grading, AI Examiner & Cohort Analytics
- **Deterministic MCQ & Formula Grading**: Automatic scoring for multiple choice and normalized chemical/mathematical equations.
- **AI Examiner Review**: Detailed step-by-step model answer breakdown cards with criteria fulfillment, misconception feedback, and automated KaTeX formula formatting.
- **Teacher Remarking & Custom Feedback**: Teachers can adjust scores, override grading, and write personalized feedback for each question or sub-question.
- **Print-Optimized PDF Reports**:
  - **Class Cohort Analytics PDF**: Score distributions, average completion duration, question difficulty rankings, and topic mastery heatmaps.
  - **Individual Student Diagnostic Reports**: Sub-question breakdowns, earned vs max marks, student responses, and structured model answers.
- **Digital Confirmation Receipts**: Students receive instant exam receipts with unique 3-digit access PINs for secure, private paper retrieval.

### 🚪 5. Streamlined Portal Landing Page & Security
- **Top-Aligned Portal Layout**: Students and teachers can jump directly into their respective portals right above the fold without unnecessary scrolling.
- **Hardware-Accelerated Smooth Scrolling**: Zero-friction document scrolling with GPU-optimized ambient gradients.
- **Masked Administrator PIN Gate**: Clean 6-digit access PIN entry with automatic masking and an optional show/hide toggle for privacy.
- **Subject & Topic Question Bank**: Browse, organize, search, and assemble customized tests across subjects and topics in seconds.

---

## 🛠️ Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS / Vanilla CSS Design System
- **Math & Chemistry**: KaTeX, Custom Formula & Ion Parser
- **PDF Engine**: PDF.js with high-resolution offscreen canvas rendering & `pdf-lib`
- **Audio Engine**: Web Audio API Synthesizer (`gameSoundEngine.ts`)
- **AI Backend**: Google Gemini Multimodal APIs (Flash & Pro with dynamic discovery)
- **Database & Storage**: Supabase (PostgreSQL + Supabase Storage for diagrams)
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

---

## 📄 License
MIT License. Created with 🐾 by [fluffykitten](https://github.com/fluffykitten).
