// ─── Game Score Engine ──────────────────────────────────────────────────────────
// Pure scoring logic for the Quizizz-style gamified quiz mode.
// No side effects — all functions are deterministic.

import type { AnswerFeedback, GamePlayer, LeaderboardEntry, PowerUpType } from '../types/gameTypes';
import { getReactionForAnswer } from '../lib/gameMemes';

// ─── Constants ──────────────────────────────────────────────────────────────────

const TIME_BONUS_MAX = 500;          // max bonus points for fastest answer
const STREAK_THRESHOLDS = [
  { min: 2, multiplier: 1.5 },
  { min: 3, multiplier: 2.0 },
  { min: 5, multiplier: 3.0 },
];

// ─── Core Scoring ───────────────────────────────────────────────────────────────

/**
 * Calculate points earned for a single question answer.
 */
export function calculatePoints(
  timeLeftMs: number,
  totalTimeMs: number,
  basePoints: number,
  streakCount: number,
  isDoublePoints: boolean
): { total: number; base: number; timeBonus: number; streakMultiplier: number } {
  // Time bonus: linear decay from TIME_BONUS_MAX to 0
  const timeRatio = Math.max(0, Math.min(1, timeLeftMs / totalTimeMs));
  const timeBonus = Math.round(TIME_BONUS_MAX * timeRatio);

  // Streak multiplier
  let streakMultiplier = 1.0;
  for (const threshold of STREAK_THRESHOLDS) {
    if (streakCount >= threshold.min) {
      streakMultiplier = threshold.multiplier;
    }
  }

  let total = Math.round((basePoints + timeBonus) * streakMultiplier);

  // Double points power-up
  if (isDoublePoints) {
    total *= 2;
  }

  return { total, base: basePoints, timeBonus, streakMultiplier };
}

/**
 * Process a player's answer and return full feedback.
 */
export function processAnswer(
  player: GamePlayer,
  isCorrect: boolean,
  timeLeftMs: number,
  totalTimeMs: number,
  basePoints: number,
  activePowerUp: PowerUpType | null,
  enableStreaks: boolean,
  enableMemes: boolean
): AnswerFeedback {
  const isDoublePoints = activePowerUp === 'double_points';
  const newStreak = isCorrect ? (enableStreaks ? player.streak + 1 : 1) : 0;

  let pointsEarned = 0;
  let base = 0;
  let timeBonus = 0;
  let streakMultiplier = 1;

  if (isCorrect) {
    const result = calculatePoints(timeLeftMs, totalTimeMs, basePoints, newStreak, isDoublePoints);
    pointsEarned = result.total;
    base = result.base;
    timeBonus = result.timeBonus;
    streakMultiplier = result.streakMultiplier;
  }

  const newTotalScore = player.score + pointsEarned;
  const timeLeftPercent = totalTimeMs > 0 ? (timeLeftMs / totalTimeMs) * 100 : 0;
  const reaction = enableMemes
    ? getReactionForAnswer(isCorrect, newStreak, timeLeftPercent)
    : { emoji: isCorrect ? '✅' : '❌', message: isCorrect ? 'Correct!' : 'Incorrect' };

  return {
    isCorrect,
    correctOptionIndex: -1, // set externally
    pointsEarned,
    basePoints: base,
    timeBonus,
    streakMultiplier,
    newStreak,
    newTotalScore,
    reaction,
    usedDoublePoints: isDoublePoints,
  };
}

// ─── Leaderboard ────────────────────────────────────────────────────────────────

/**
 * Build sorted leaderboard from player map.
 */
export function buildLeaderboard(
  players: Map<string, GamePlayer>,
  previousLeaderboard?: LeaderboardEntry[]
): LeaderboardEntry[] {
  const prevRankMap = new Map<string, number>();
  if (previousLeaderboard) {
    previousLeaderboard.forEach((e) => prevRankMap.set(e.playerId, e.rank));
  }

  const entries: LeaderboardEntry[] = [];
  players.forEach((player) => {
    if (player.isHost) return; // don't show host on leaderboard
    entries.push({
      playerId: player.id,
      nickname: player.nickname,
      avatarEmoji: player.avatarEmoji,
      score: player.score,
      rank: 0,
      previousRank: prevRankMap.get(player.id) ?? 999,
      streak: player.streak,
      lastAnswerCorrect: false, // set externally
      correctCount: player.correctCount,
      totalAnswered: player.totalAnswered,
    });
  });

  // Sort by score descending, then by correct count, then by avg response time
  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.correctCount !== a.correctCount) return b.correctCount - a.correctCount;
    return 0;
  });

  // Assign ranks
  entries.forEach((entry, idx) => {
    entry.rank = idx + 1;
  });

  return entries;
}

// ─── Star Rating ────────────────────────────────────────────────────────────────

/**
 * Get star rating (1-5) based on accuracy percentage.
 */
export function getStarRating(percentage: number): number {
  if (percentage >= 90) return 5;
  if (percentage >= 75) return 4;
  if (percentage >= 60) return 3;
  if (percentage >= 40) return 2;
  return 1;
}

// ─── Nickname Generator ─────────────────────────────────────────────────────────

const ADJECTIVES = [
  'Speedy', 'Quantum', 'Neon', 'Cosmic', 'Turbo', 'Mighty', 'Blazing', 'Funky',
  'Atomic', 'Stellar', 'Hyper', 'Ultra', 'Super', 'Mega', 'Epic', 'Radical',
  'Clever', 'Brave', 'Swift', 'Noble', 'Fierce', 'Daring', 'Lucky', 'Witty',
  'Zippy', 'Groovy', 'Snappy', 'Jazzy', 'Peppy', 'Vivid', 'Rapid', 'Crisp',
];

const NOUNS = [
  'Atom', 'Cat', 'Panda', 'Phoenix', 'Falcon', 'Dragon', 'Tiger', 'Wizard',
  'Knight', 'Ninja', 'Robot', 'Comet', 'Spark', 'Bolt', 'Blaze', 'Storm',
  'Fox', 'Wolf', 'Eagle', 'Shark', 'Lion', 'Bear', 'Hawk', 'Otter',
  'Pixel', 'Byte', 'Quark', 'Proton', 'Neutron', 'Photon', 'Orbit', 'Nova',
];

/**
 * Generate a fun random nickname like "SpeedyAtom" or "NeonDragon".
 */
export function generateNickname(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}${noun}`;
}

// ─── Shuffle Utility ────────────────────────────────────────────────────────────

/**
 * Fisher-Yates shuffle (returns new array).
 */
export function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Apply 50/50 power-up: returns indices of 2 wrong options to hide.
 */
export function getFiftyFiftyIndices(correctIndex: number, totalOptions: number): number[] {
  const wrongIndices: number[] = [];
  for (let i = 0; i < totalOptions; i++) {
    if (i !== correctIndex) wrongIndices.push(i);
  }
  // Shuffle wrong indices and pick 2
  const shuffled = shuffleArray(wrongIndices);
  return shuffled.slice(0, 2);
}
