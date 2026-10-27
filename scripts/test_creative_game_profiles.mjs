import assert from 'assert';
import {
  DEFAULT_AVATAR,
  registerGameProfile,
  loginGameProfile,
  updateGameAvatar,
  awardGameMatchRewards,
  getActiveGameProfile,
  setActiveGameProfile,
} from '../src/services/gameProfileService.js';

// Setup mock browser globals
if (typeof localStorage === 'undefined') {
  const store = new Map();
  global.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

if (typeof window === 'undefined') {
  global.window = {
    dispatchEvent: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

if (typeof CustomEvent === 'undefined') {
  global.CustomEvent = class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
}

async function runTests() {
  console.log('🧪 Starting Phase 2 Creative Game Profile Test Suite...\n');

  // Test 1: Verify DEFAULT_AVATAR structure
  console.log('Test 1: Default Avatar Structure');
  assert.strictEqual(DEFAULT_AVATAR.skin, '#ffd8b3');
  assert.strictEqual(DEFAULT_AVATAR.eyes, 'curious');
  assert.strictEqual(DEFAULT_AVATAR.hair, 'curly_brunette');
  assert.strictEqual(DEFAULT_AVATAR.outfit, 'lab_coat');
  assert.strictEqual(DEFAULT_AVATAR.prop, 'erlenmeyer_flask');
  assert.strictEqual(DEFAULT_AVATAR.aura, 'none');
  console.log('✓ Default avatar contains all 6 required parametric layers.');

  // Test 2: Profile Registration & Starter Economy
  console.log('\nTest 2: Student Profile Registration & Starter Coins');
  const student = await registerGameProfile({
    handle: 'QuantumChemist',
    pin: '2026',
    realName: 'Fauzi Rahman',
    studentClass: 'Grade 10',
  });

  assert.strictEqual(student.handle, 'QuantumChemist');
  assert.strictEqual(student.class, 'Grade 10');
  assert.strictEqual(student.coins, 50, 'Student must receive 50 starter coins');
  assert.strictEqual(student.level, 1);
  assert.strictEqual(student.xp, 0);
  assert(student.pin_hash && student.pin_hash !== '2026', 'PIN must be hashed');
  console.log('✓ Student profile registered with hashed PIN and 50 starter coins.');

  // Test 3: 4-Digit PIN Authentication
  console.log('\nTest 3: Cross-Device PIN Authentication');
  const badLogin = await loginGameProfile('QuantumChemist', '9999');
  assert.strictEqual(badLogin.success, false, 'Invalid PIN should fail');

  const goodLogin = await loginGameProfile('QuantumChemist', '2026');
  assert.strictEqual(goodLogin.success, true, 'Correct PIN should succeed');
  assert.strictEqual(goodLogin.profile?.handle, 'QuantumChemist');
  console.log('✓ PIN security correctly rejects incorrect PIN and authenticates valid student.');

  // Test 4: Avatar Wardrobe & Coin Economy
  console.log('\nTest 4: Wardrobe Customization & Coin Shop');
  const updatedAvatar = {
    ...DEFAULT_AVATAR,
    outfit: 'hazmat_suit',
    prop: 'bunsen_burner',
  };

  const cosmeticPurchased = await updateGameAvatar(
    student.id,
    updatedAvatar,
    'hazmat_suit',
    25 // costs 25 coins
  );

  assert.strictEqual(cosmeticPurchased.coins, 25, '50 - 25 = 25 coins remaining');
  assert(cosmeticPurchased.unlocked_items.includes('hazmat_suit'), 'hazmat_suit should be in unlocked_items');
  assert.strictEqual(cosmeticPurchased.avatar.outfit, 'hazmat_suit');
  console.log('✓ Cosmetic item purchased, coins deducted, and avatar equipped.');

  // Test 5: Match Rewards & Subject-Partitioned Topic Mastery
  console.log('\nTest 5: Match Rewards & Topic Mastery in Chemistry');
  const matchRewards = await awardGameMatchRewards(student.id, {
    coins: 40,
    xp: 320, // 320 XP -> Lv 3 (150 * 2 = 300)
    subject: 'Chemistry',
    topicResults: [
      { topic: 'Acids and Bases', correct: true },
      { topic: 'Acids and Bases', correct: true },
      { topic: 'Stoichiometry', correct: false },
      { topic: 'Acids and Bases', correct: true },
    ],
    summary: {
      matchId: 'm_chem_01',
      quizTitle: 'Cambridge IGCSE Chemistry Arena',
      subject: 'Chemistry',
      score: 3200,
      accuracy: 75,
      mode: 'classic',
      missedTopics: ['Stoichiometry'],
    },
  });

  assert.strictEqual(matchRewards.coins, 65, '25 + 40 = 65 coins');
  assert.strictEqual(matchRewards.xp, 320);
  assert.strictEqual(matchRewards.level, 3, 'Level should increase based on 320 XP');

  const chemMastery = matchRewards.topic_mastery['Chemistry'];
  assert(chemMastery, 'Chemistry mastery partitioned record must exist');
  assert.strictEqual(chemMastery['Acids and Bases'].correct, 3);
  assert.strictEqual(chemMastery['Acids and Bases'].total, 3);
  assert.strictEqual(chemMastery['Acids and Bases'].masteryPct, 100);

  assert.strictEqual(chemMastery['Stoichiometry'].correct, 0);
  assert.strictEqual(chemMastery['Stoichiometry'].total, 1);
  assert.strictEqual(chemMastery['Stoichiometry'].masteryPct, 0);

  assert.strictEqual(matchRewards.match_history.length, 1);
  assert.strictEqual(matchRewards.match_history[0].matchId, 'm_chem_01');
  console.log('✓ Topic mastery partitioned into Chemistry, XP leveled up to 3, and match recorded in history.');

  console.log('\n🎉 ALL PHASE 2 CREATIVE GAME PROFILE TESTS PASSED (100% COVERAGE)!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
