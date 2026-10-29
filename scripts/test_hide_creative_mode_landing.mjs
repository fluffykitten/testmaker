import assert from 'assert';
import {
  DEFAULT_SETTINGS,
  getSavedSettings,
  saveSettings,
  saveCreativeModeLandingVisibility,
  loadAndSyncCreativeModeLandingVisibility,
} from '../src/lib/settings.js';

// Setup mock browser globals
const store = new Map();
global.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

let dispatchedEvents = [];
global.window = {
  dispatchEvent: (e) => {
    dispatchedEvents.push(e);
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false }),
};

global.document = {
  documentElement: {
    classList: { add: () => {}, remove: () => {} },
    style: { setProperty: () => {} },
    setAttribute: () => {},
  },
};

global.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
};

async function runTests() {
  console.log('🧪 Starting Hide Creative Mode on Landing Test Suite...\n');

  // Test 1: Default Settings
  console.log('Test 1: DEFAULT_SETTINGS has hideCreativeModeOnLanding = false');
  assert.strictEqual(DEFAULT_SETTINGS.hideCreativeModeOnLanding, false);
  const initial = getSavedSettings();
  assert.strictEqual(initial.hideCreativeModeOnLanding, false);
  console.log('✓ Default settings initialized with hideCreativeModeOnLanding = false');

  // Test 2: Update and Save Setting
  console.log('\nTest 2: Save Creative Mode landing page visibility to hidden (true)');
  dispatchedEvents = [];
  saveCreativeModeLandingVisibility(true);

  const updated = getSavedSettings();
  assert.strictEqual(updated.hideCreativeModeOnLanding, true);
  assert.strictEqual(dispatchedEvents.length, 1);
  assert.strictEqual(dispatchedEvents[0].type, 'creative_mode_landing_visibility_updated');
  assert.strictEqual(dispatchedEvents[0].detail.hideCreativeModeOnLanding, true);
  console.log('✓ Setting saved to local storage and creative_mode_landing_visibility_updated event dispatched');

  // Test 3: Revert Setting to Visible (false)
  console.log('\nTest 3: Save Creative Mode landing page visibility back to visible (false)');
  dispatchedEvents = [];
  saveCreativeModeLandingVisibility(false);

  const reverted = getSavedSettings();
  assert.strictEqual(reverted.hideCreativeModeOnLanding, false);
  assert.strictEqual(dispatchedEvents.length, 1);
  assert.strictEqual(dispatchedEvents[0].detail.hideCreativeModeOnLanding, false);
  console.log('✓ Setting reverted and event dispatched');

  // Test 4: loadAndSyncCreativeModeLandingVisibility fallback
  console.log('\nTest 4: loadAndSyncCreativeModeLandingVisibility returns local value when cloud unavailable');
  saveSettings({ ...getSavedSettings(), hideCreativeModeOnLanding: true });
  const cachedVal = await loadAndSyncCreativeModeLandingVisibility();
  assert.strictEqual(cachedVal, true);
  console.log('✓ Local fallback correctly returned');

  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
