# 🐱 fluffykitten's test maker

An intelligent, AI-powered exam assessment and past paper authoring studio. Upload past paper PDFs, extract questions and diagrams automatically with Google Gemini multimodal AI, and build customized exam papers with drag-and-drop ease.

Created with 🐾 by [**fluffykitten**](https://github.com/fluffykitten).

---

## ✨ Features

- **🧠 AI Past Paper Extraction**: Sends past paper PDFs & mark schemes to Google's Gemini multimodal AI to extract questions, sub-questions, options, topics, difficulty ratings, and official marking criteria.
- **📐 High-Resolution Diagram Cropper**: Automatic canvas-based rendering with intelligent multi-pass boundary expansion and WebP compression for crystal-clear scientific apparatus, biological diagrams, and mathematical graphs.
- **📚 Question Bank & Catalog**: Search, filter by syllabus/topic/difficulty/marks, and preview with full KaTeX mathematical and chemical notation rendering.
- **🗑️ Question Bank Management**: Permanently delete single or bulk-selected questions directly from the question bank with confirmation safeguards.
- **🛠️ Drag-and-Drop Test Builder**: Assemble custom tests, reorder questions, calculate mark distributions, and view live topic coverage analytics.
- **📄 One-Click Export Engine**:
  - **Microsoft Word (.docx)**: Clean layout with LaTeX-to-Word conversions, sub-question indentation, mark totals, and teacher answer keys.
  - **PDF Export**: Print-ready exam sheets.
- **🎨 Appearance & Customization Settings**:
  - `☀️ Light`, `🌙 Dark`, and `💻 System` color themes.
  - 6 Accent Palettes (*Indigo*, *Emerald*, *Violet*, *Rose*, *Amber*, *Sky*).
  - Adjustable text sizes (*Small*, *Default*, *Medium*, *Large*).
  - Cozy & Compact layout density.
- **🔒 PIN Access Gate**: Full-screen PIN security powered by Supabase remote configuration (no hardcoded credentials).
- **💡 First-Time Guided Tour**: Interactive spotlight onboarding for new users.

---

## 🛠️ Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Vanilla CSS Design System
- **Math & Chemistry**: KaTeX, Rehype/Remark
- **PDF Engine**: PDF.js (v4+) with high-resolution offscreen canvas rendering
- **AI Backend**: Google Gemini Multimodal APIs (Flash & Pro with dynamic discovery)
- **Database & Storage**: Supabase (PostgreSQL + Supabase Storage for diagrams)
- **Export**: Docx.js, jsPDF

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
4. `supabase/migrations/004_app_config.sql` — PIN configuration (`404354`)

### 5. Run Locally
```bash
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## 🌐 Deployment

### Vercel
1. Import the repository into [Vercel](https://vercel.com).
2. Set the environment variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_GEMINI_API_KEY`).
3. Deploy!

### Netlify
1. Import into [Netlify](https://app.netlify.com).
2. Build command: `npm run build`, Output directory: `dist`.
3. Add your environment variables in Site configuration.

### Cloudflare Pages
1. Connect repository in [Cloudflare Pages](https://pages.cloudflare.com).
2. Build preset: `Vite`, Build command: `npm run build`, Output directory: `dist`.
3. Add environment variables and deploy.

---

## 📄 License
MIT License. Created by [fluffykitten](https://github.com/fluffykitten).
