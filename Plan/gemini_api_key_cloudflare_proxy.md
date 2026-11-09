# Blueprint & Implementation Plan: Gemini API Key Selection via Cloudflare Worker Proxy

## 1. Overview & Problem Statement
Currently, TestMaker allows the administrator to configure the **Gemini Model for Paper Extraction** in Admin Settings (`gemini-3.5-flash-lite`, `gemini-3.8-flash`, or custom). However, all requests make calls either directly using client-side environment keys or attempt round-robin pooling across whatever keys are compiled in the client bundle. 

The user states:
> *"I now want the option to pick which API key to use, cause I have a paid api key and free api key. The keys aren't exposed in the web, but i configure the api keys in cloudflare."*

### Key Requirements
1. **Zero Key Exposure in Web**: The browser client should never receive or bundle secret API keys directly. Secret keys reside securely in Cloudflare Worker environment secrets (`GEMINI_PAID_KEY` / `GEMINI_API_KEY`, `GEMINI_FREE_KEY` / `GEMINI_API_KEY_2`).
2. **Admin Setting Selection**: In **Admin Settings** (under **Exam Security & Feature Controls** or dedicated AI configuration), provide a setting to pick the active API Key profile:
   - **`paid` (Paid Tier / High Quota)**: Routes specifically to the paid Gemini API key on Cloudflare.
   - **`free` (Free Tier)**: Routes to the free/personal Gemini API key on Cloudflare.
   - **`auto` (Smart Failover - Recommended)**: Attempts Paid first, falling back to Free if rate-limited (429) or vice versa.
3. **Cloudflare Worker Proxy Support (`worker/index.js`)**:
   - Update `/api/gemini/generate` to accept a `keyTier: 'paid' | 'free' | 'auto'` header or body parameter.
   - Map `keyTier` to Cloudflare secrets (e.g. `GEMINI_PAID_KEY` / `GEMINI_API_KEY` for paid, and `GEMINI_FREE_KEY` / `GEMINI_API_KEY_2` for free).
   - Support `/api/gemini/ping` / test endpoint so the Admin Settings "Test Connection" button can verify connectivity to Cloudflare and the selected key tier without leaking the key string.
4. **App Client Integration**:
   - Persist key tier preference in `AppSettings` (`geminiApiKeyTier?: 'auto' | 'paid' | 'free'`) and sync across school devices via Supabase `app_config` (`gemini_api_key_tier`).
   - Route multimodal PDF extraction (`extractQuestionsFromPdf`), marking guidance generation, and AI grading calls via the Cloudflare Worker `/api/gemini/generate` endpoint, transmitting the requested model and `keyTier`.
   - Maintain client-side `.env.local` fallback for offline / local-development instances.

---

## 2. Cloudflare Worker Architecture (`worker/index.js`)

### Secret Environment Variables in Cloudflare
Cloudflare Worker will support the following bindings in `env`:
- `GEMINI_PAID_KEY` (or legacy `GEMINI_API_KEY`): The paid quota key.
- `GEMINI_FREE_KEY` (or legacy `GEMINI_API_KEY_2`): The free tier key.

### Key Resolution Strategy
```mermaid
flowchart TD
    Client[TestMaker Web Client] -->|POST /api/gemini/generate\n{ model, contents, keyTier }| CF[Cloudflare Worker]
    CF --> CheckTier{keyTier param}
    CheckTier -->|paid| PaidPool["[ GEMINI_PAID_KEY ]"]
    CheckTier -->|free| FreePool["[ GEMINI_FREE_KEY ]"]
    CheckTier -->|auto| AutoPool["[ GEMINI_PAID_KEY, GEMINI_FREE_KEY ]"]
    PaidPool --> CallGoogle[Google AI Studio API /v1beta/models/...]
    FreePool --> CallGoogle
    AutoPool --> CallGoogle
    CallGoogle -->|200 OK| ReturnSuccess[Return Response to Client]
    CallGoogle -->|429 Rate Limit on Primary| Fallback[Failover to Secondary Key in Auto Mode]
```

### Endpoints in `worker/index.js`
1. **`POST /api/gemini/generate`**:
   - Accepts `{ prompt, contents, generationConfig, targetModel, keyTier }` or `x-gemini-key-tier: paid | free | auto`.
   - Resolves target keys based on requested `keyTier`.
   - Executes multimodal generation against Google Generative Language API (`https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={selectedKey}`).
   - Returns sanitized payload (zero key leakage).
2. **`POST /api/gemini/ping`**:
   - Diagnostic endpoint accepting `{ targetModel, keyTier }`.
   - Verifies whether the selected key on Cloudflare can access the target model without sending huge payloads.
   - Returns `{ ok: true, model: ..., tier: 'paid' | 'free', quotaStatus: 'active', latencyMs: 120 }`.

---

## 3. Client-Side Implementation Details

### A. Settings Definition (`src/lib/settings.ts`)
```typescript
export type GeminiApiKeyTier = 'auto' | 'paid' | 'free';

export interface AppSettings {
  // ... existing settings
  geminiExtractionModel?: string;
  geminiApiKeyTier?: GeminiApiKeyTier; // 'auto' (default) | 'paid' | 'free'
}
```
- Provide `getGeminiApiKeyTier()`, `saveGeminiApiKeyTier(tier)`, and `syncGeminiApiKeyTierToCloud(tier)` syncing to Supabase `app_config` key `gemini_api_key_tier`.

### B. Admin Settings UI (`src/pages/AdvancedSettingsPage.tsx`)
In the **Gemini AI Configuration** card:
1. **Model Selector**: Retain current `3.5 Flash Lite`, `3.8 Flash`, and `Custom Model`.
2. **API Key Tier Selector**:
   - Add segmented pills / selector:
     - 💳 **Paid Key (High Quota)**: Explicitly route through `GEMINI_PAID_KEY`. Ideal for bulk paper extraction and whole-class batch AI marking.
     - 🆓 **Free Key**: Explicitly route through `GEMINI_FREE_KEY`. Conserves paid budget for routine tests.
     - 🔄 **Auto-Failover (Recommended)**: Cloudflare Worker tries Paid Key first and falls back to Free Key if quotas or rate limits occur.
3. **Status Badge**:
   - Displays: *"Keys secured in Cloudflare Worker Proxy (No client exposure)"*.
4. **"Test Connection" Button**:
   - Pings Cloudflare Worker `/api/gemini/ping` with both the selected model and selected API key tier, displaying live latency and quota connectivity.

### C. Proxy Client Routing (`src/lib/gemini.ts`)
1. Create / update `callGeminiApi()` to check if `getR2MediaEndpoint()` or `VITE_CLOUDFLARE_WORKER_URL` is available.
2. If Cloudflare Worker URL is available:
   - Send requests to `${workerUrl}/api/gemini/generate` with `keyTier` from `getGeminiApiKeyTier()`.
3. If Cloudflare Worker is offline or in local development with `.env.local` direct keys:
   - Fall back transparently to direct `generativelanguage.googleapis.com` browser calls using local env keys.

---

## 4. Verification & Testing Plan

### Automated Test Suite (`scripts/test-gemini-key-tier-proxy.mjs`)
1. **Test 1**: Verify `worker/index.js` routes `keyTier: 'paid'`, `'free'`, and `'auto'` to the expected secret slots.
2. **Test 2**: Verify `worker/index.js` handles rate-limiting failover when in `auto` mode.
3. **Test 3**: Verify client settings (`src/lib/settings.ts`) defaults to `'auto'` and properly serializes / syncs to `app_config`.
4. **Test 4**: Verify `testGeminiModelConnectivity` correctly dispatches the `keyTier` header to Cloudflare Worker.

### Regression Checks
- Run `node scripts/test-exam-submission-fixes.mjs` (ensure existing guards pass).
- Run `node scripts/test-mcq-grading-flow.mjs` (ensure deterministic grading passes).
- Run `npm run build` (`tsc -b && vite build`) to confirm clean TypeScript build.

