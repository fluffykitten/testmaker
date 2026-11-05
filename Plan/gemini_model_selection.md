# Blueprint: Configurable Gemini Extraction Model in Admin Settings (`Plan/gemini_model_selection.md`)

## 1. Problem Statement & Current State

Currently, the Gemini AI model used for exam paper extraction is determined statically via:
1. Environment variable: `VITE_GEMINI_MODEL` (set in `.env.local` for local development, or Cloudflare Pages / Netlify dashboard environment variables for production).
2. If `VITE_GEMINI_MODEL` is absent or unset, it falls back to an internal discovery list in [`src/lib/gemini.ts`](file:///c:/testmaker/src/lib/gemini.ts):
   `['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.5-flash']`.

### Limitation
If a teacher or school administrator wants to switch models (e.g., from `gemini-3.1-flash-lite` to `gemini-2.5-flash` or `gemini-2.5-pro` for higher reasoning fidelity on complex calculation papers, or back to a faster Flash model), they cannot do so without modifying code or redeploying environment variables on Cloudflare.

---

## 2. Proposed Architecture

### A. Settings Hierarchy (Precedence Order)
1. **Admin Configured Model (Highest Priority)**:
   - Configured in the PIN-protected **Advanced Settings** (`/settings/advanced`).
   - Persisted in browser `localStorage` (`app_settings.geminiExtractionModel`).
   - Synced across all teachers via the Supabase cloud table `app_config` (`key: 'gemini_extraction_model'`).
2. **Environment Variable (Fallback)**:
   - `VITE_GEMINI_MODEL` from `.env.local` or Cloudflare Pages environment.
3. **Dynamic Discovery / Verified Fast Models (Default)**:
   - If set to `'auto'` or left empty, the engine automatically probes Google AI Studio and selects the verified fastest available model with fallback failover.

---

### B. Supported Model Options in Admin UI

| Option Key | UI Label | Ideal Use Case |
| :--- | :--- | :--- |
| `gemini-3.5-flash-lite` | **Gemini 3.5 Flash Lite** *(Preset)* | Lightweight, high-efficiency, fast token streaming for rapid extraction. |
| `gemini-3.8-flash` | **Gemini 3.8 Flash** *(Preset)* | Balanced flagship Flash model with superior multimodal visual reasoning. |
| `custom` | **Custom Model** | Allows entering any custom model ID (e.g. fine-tuned model or specific preview ID). |

---

## 3. Implementation Plan

### Step 1: Update Settings Types & Sync Logic ([`src/lib/settings.ts`](file:///c:/testmaker/src/lib/settings.ts))
1. Extend `AppSettings` interface:
   ```ts
   export interface AppSettings {
     // ... existing fields ...
     geminiExtractionModel?: string; // 'auto' | model identifier
   }
   ```
2. Add cloud sync helpers mirroring `school_classes` and `school_subjects`:
   - `getGeminiExtractionModel(): string`
   - `saveGeminiExtractionModel(model: string): void`
   - `syncGeminiExtractionModelToCloud(model: string): Promise<boolean>`
   - `loadAndSyncGeminiExtractionModel(): Promise<string>`

### Step 2: Update Model Resolver in Gemini Service ([`src/lib/gemini.ts`](file:///c:/testmaker/src/lib/gemini.ts))
1. Create a centralized resolver `getConfiguredGeminiModel()`:
   ```ts
   export function getConfiguredGeminiModel(): string | undefined {
     const adminModel = getSavedSettings().geminiExtractionModel?.trim();
     if (adminModel && adminModel !== 'auto') {
       return adminModel.startsWith('gemini-') ? adminModel : `gemini-${adminModel}`;
     }
     const envModel = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GEMINI_MODEL) || 
                      (typeof process !== 'undefined' && process.env?.VITE_GEMINI_MODEL);
     if (envModel?.trim() && envModel.trim() !== 'auto') {
       const m = envModel.trim();
       return m.startsWith('gemini-') ? m : `gemini-${m}`;
     }
     return undefined;
   }
   ```
2. Wire `getConfiguredGeminiModel()` into `extractQuestionsFromPdf`, `generateGuidanceAndMisconceptions`, and `generateQuestionVariant`.
3. Add a lightweight test utility `testGeminiModelConnectivity(modelName: string, apiKey?: string): Promise<{ ok: boolean; message: string; details?: any }>` so admins can test their chosen model before saving.

### Step 3: Add Model Selector UI to Admin Settings ([`src/pages/AdvancedSettingsPage.tsx`](file:///c:/testmaker/src/pages/AdvancedSettingsPage.tsx))
1. Inside **Exam Security & Feature Controls** (or a dedicated AI section):
   - Add a setting card: **"AI Model for Paper Extraction & Generation"**.
   - Dropdown with presets + custom input field.
   - Live **"Test Model Availability"** button that pings the Google AI Studio endpoint and reports latency / token capabilities.
   - Save button that persists locally and syncs to Supabase `app_config` so all teachers share the active model.

### Step 4: Verification & Testing
1. Run `npx tsc -b` and `npm run build` to verify clean compilation.
2. Verify model switching:
   - Select `gemini-2.5-pro` in Admin Settings -> initiate extraction -> verify console contacts `gemini-2.5-pro`.
   - Select `auto` -> verify fallback / discovery list is used.
   - Verify cloud sync: check that `app_config` in Supabase updates with `key: 'gemini_extraction_model'`.

