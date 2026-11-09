// Verification suite for Plan/gemini_api_key_cloudflare_proxy.md
//
//   node scripts/test-gemini-key-tier-proxy.mjs
//
// Verifies:
//   Test 1: Cloudflare Worker (worker/index.js) routes 'paid', 'free', and 'auto' key tiers accurately
//   Test 2: Client key resolution (src/lib/gemini.ts) isolates Paid vs Free vs Auto-Failover keys from .env.local
//   Test 3: Settings persistence & cloud sync (src/lib/settings.ts) for gemini_api_key_tier
//   Test 4: Admin Settings UI (src/pages/AdvancedSettingsPage.tsx) wiring & zero raw-key exposure

import fs from 'node:fs';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Load .env.local into process.env for Node testing
const envLocal = fs.readFileSync('.env.local', 'utf8');
for (const line of envLocal.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx > 0) {
    const k = trimmed.slice(0, eqIdx).trim();
    const v = trimmed.slice(eqIdx + 1).trim();
    process.env[k] = v;
  }
}

// Read keys dynamically from local environment (.env.local is in .gitignore)
const EXPECTED_PAID_KEY = process.env.VITE_GEMINI_PAID_API_KEY || 'mock_paid_key_test_12345';
const EXPECTED_FREE_KEY = process.env.VITE_GEMINI_FREE_API_KEY || 'mock_free_key_test_67890';

// ─── Test 1: Cloudflare Worker Key Tier Resolution ───────────────────────────
{
  const workerSource = fs.readFileSync('worker/index.js', 'utf8');
  check(
    'Test 1a: worker/index.js exports resolveWorkerGeminiKeys and supports /api/gemini/ping + /api/gemini/generate',
    workerSource.includes('export function resolveWorkerGeminiKeys') &&
      workerSource.includes('url.pathname === "/api/gemini/ping"') &&
      workerSource.includes('url.pathname === "/api/gemini/generate"')
  );

  // Extract and evaluate resolveWorkerGeminiKeys pure logic against mock env
  const mockEnv = {
    GEMINI_PAID_KEY: EXPECTED_PAID_KEY,
    GEMINI_FREE_KEY: EXPECTED_FREE_KEY,
  };
  const fnMatch = workerSource.match(/export function resolveWorkerGeminiKeys\([\s\S]*?\n\}/);
  const resolveFn = new Function(
    'env',
    'request',
    'bodyTier',
    fnMatch[0].replace(/^export function resolveWorkerGeminiKeys\([^)]*\)\s*\{/, '').replace(/\}$/, '')
  );

  const paidRes = resolveFn(mockEnv, { headers: new Map() }, 'paid');
  const freeRes = resolveFn(mockEnv, { headers: new Map() }, 'free');
  const autoRes = resolveFn(mockEnv, { headers: new Map() }, 'auto');

  check(
    'Test 1b: Worker paid tier selects only GEMINI_PAID_KEY',
    paidRes.keyTier === 'paid' && paidRes.keys.length === 1 && paidRes.keys[0] === EXPECTED_PAID_KEY
  );
  check(
    'Test 1c: Worker free tier selects only GEMINI_FREE_KEY',
    freeRes.keyTier === 'free' && freeRes.keys.length === 1 && freeRes.keys[0] === EXPECTED_FREE_KEY
  );
  check(
    'Test 1d: Worker auto tier selects [GEMINI_PAID_KEY, GEMINI_FREE_KEY] for failover',
    autoRes.keyTier === 'auto' &&
      autoRes.keys.length === 2 &&
      autoRes.keys[0] === EXPECTED_PAID_KEY &&
      autoRes.keys[1] === EXPECTED_FREE_KEY
  );
}

// ─── Test 2: Client Environment Key Resolution (.env.local + src/lib/gemini.ts) ──
{
  check(
    'Test 2a: .env.local configures both Paid and Free Gemini API keys',
    process.env.VITE_GEMINI_PAID_API_KEY === EXPECTED_PAID_KEY &&
      process.env.VITE_GEMINI_FREE_API_KEY === EXPECTED_FREE_KEY
  );

  const geminiSource = fs.readFileSync('src/lib/gemini.ts', 'utf8');
  check(
    'Test 2b: src/lib/gemini.ts exports getGeminiPaidApiKey, getGeminiFreeApiKey, and getConfiguredApiKeyStatus',
    geminiSource.includes('export function getGeminiPaidApiKey()') &&
      geminiSource.includes('export function getGeminiFreeApiKey()') &&
      geminiSource.includes('export function getConfiguredApiKeyStatus(')
  );
  check(
    'Test 2c: getGeminiApiKeys and getApiKeyForChunk filter strictly by tier (paid vs free vs auto)',
    geminiSource.includes("if (tier === 'paid')") &&
      geminiSource.includes("if (tier === 'free')") &&
      geminiSource.includes('export function getApiKeyForChunk(chunkIndex: number = 0, tierOverride?: GeminiApiKeyTier)')
  );
}

// ─── Test 3: Settings Persistence & Cloud Sync (src/lib/settings.ts) ─────────
{
  const settingsSource = fs.readFileSync('src/lib/settings.ts', 'utf8');
  check(
    'Test 3a: src/lib/settings.ts defines GeminiApiKeyTier and syncs gemini_api_key_tier to Supabase app_config',
    settingsSource.includes("export type GeminiApiKeyTier = 'auto' | 'paid' | 'free'") &&
      settingsSource.includes("key: 'gemini_api_key_tier'") &&
      settingsSource.includes('export async function loadAndSyncGeminiApiKeyTier()')
  );
}

// ─── Test 4: Admin Settings UI Wiring & Zero Key Exposure ────────────────────
{
  const adminSource = fs.readFileSync('src/pages/AdvancedSettingsPage.tsx', 'utf8');
  check(
    'Test 4a: AdvancedSettingsPage.tsx renders Paid, Free, and Auto-Failover key tier selectors',
    adminSource.includes("setGeminiKeyTier('paid')") &&
      adminSource.includes("setGeminiKeyTier('free')") &&
      adminSource.includes("setGeminiKeyTier('auto')")
  );
  check(
    'Test 4b: AdvancedSettingsPage.tsx passes geminiKeyTier to testGeminiModelConnectivity and syncs to cloud',
    adminSource.includes('testGeminiModelConnectivity(targetModel, undefined, geminiKeyTier)') &&
      adminSource.includes('syncGeminiApiKeyTierToCloud(geminiKeyTier)')
  );
  check(
    'Test 4c: No raw API keys are hardcoded in AdvancedSettingsPage.tsx',
    !adminSource.includes(EXPECTED_PAID_KEY) && !adminSource.includes(EXPECTED_FREE_KEY)
  );
}

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);

