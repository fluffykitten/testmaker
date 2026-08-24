# 🐱 fluffykitten's test maker

An intelligent, AI-powered exam assessment and past paper authoring studio. Upload past paper PDFs, extract questions, options, and diagrams automatically with Google Gemini multimodal AI, and build customized, publication-grade exam papers with drag-and-drop ease.

Created with 🐾 by [**fluffykitten**](https://github.com/fluffykitten).

---

## ✨ Key Features

### 🧠 1. Multimodal AI Extraction & Fault-Tolerant Parsing
- **Gemini Multimodal AI**: Automatically parses past paper PDFs and mark schemes into structured questions, sub-questions, MCQ options, topics, difficulty ratings, and official marking criteria.
- **Robust JSON Repair Engine**: Multi-pass repair and balanced-brace fallback algorithms that smoothly recover questions even during network anomalies or long token generations.
- **LaTeX Math & Chemistry Normalization**: Automatic formatting and KaTeX rendering for nuclide/isotope symbols (`^{40}_{20}\text{Ca}`), chemical sub/superscripts, escaped percentages, temperatures (`°C`), and arrows.

### 🏛️ 2. Publication-Quality Cambridge & School Exam Export
- **Authentic Cambridge IGCSE Cover Pages**:
  - Dual Header Logos (School Crest on top left, Cambridge Assessment on top right).
  - Dynamic instructions adapting for Paper 1/2 (Multiple Choice) vs. Paper 3/4 (Theory & Structured).
  - Accurate bold page counts and centered headers.
- **🧪 Cambridge IGCSE Chemistry Periodic Table**:
  - Official 118-element periodic table including Lanthanoid and Actinoid series, key legend, and gas volume constant ($24\text{ dm}^3$ at r.t.p.).
  - Rotated 270° in full landscape orientation to utilize the whole page width.
  - Stripped clean of barcodes, copyright text, margin warning labels, and crop marks.
  - Automatically available when the assessment subject is Chemistry.
- **🗺️ Social Science & Humanities Insert Booklets**:
  - Standalone Resource Insert generation for Geography, History, Sociology, Economics, and Business Studies.
  - Extracts figures, maps, data tables, and case studies into a clean insert.
- **⭕ Multiple Choice Bubble Answer Sheets**:
  - Standard bubble answer grid for MCQ papers with candidate info boxes and examiner score boxes.
- **📐 Spacious Handwriting Answer Lines**:
  - Standard handwriting height (~8mm / 26px gap) in PDF and native 360-spacing in Word (`.docx`).

### 🛠️ 3. Question Bank & Interactive Studio
- **Dynamic Search & Filters**: Filter by subject, paper number, year, topic, sub-topic, difficulty, and custom teacher tags (`#tag`).
- **High-Resolution Diagram Cropper**: Automatic canvas-based rendering with intelligent multi-pass boundary expansion and WebP compression.
- **AI Question Variant Generator**: Re-synthesize alternative numerical parameters and scientific contexts while preserving exam difficulty.
- **Smart Test Assembler**: Build balanced tests automatically based on target mark totals, topics, and difficulty distribution.
- **Interactive Student Quiz Runner**: Live in-browser student testing mode with instant grading and LMS QTI/Moodle export.

---

## 🛠️ Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Vanilla CSS Design System
- **Math & Chemistry**: KaTeX, Rehype/Remark
- **PDF Engine**: PDF.js (v4+) with high-resolution offscreen canvas rendering
- **AI Backend**: Google Gemini Multimodal APIs (Flash & Pro with dynamic discovery)
- **Database & Storage**: Supabase (PostgreSQL + Supabase Storage for diagrams)
- **Export Engine**: `docx` (Word), HTML5 Print Window (PDF)

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
2. `supabase/migrations/002_storage_setup.sql` — Storage buckets for diagrams and raw PDFs
3. `supabase/migrations/003_storage_public_fix.sql` — Public read policies for diagrams
4. `supabase/migrations/004_app_config.sql` — PIN configuration
5. `supabase/migrations/005_add_options_column.sql` — Multiple choice options support

### 5. Run Locally
```bash
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## 📄 License
MIT License. Created with 🐾 by [fluffykitten](https://github.com/fluffykitten).
