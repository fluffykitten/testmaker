// ─── Game Memes & Reaction Library ──────────────────────────────────────────────
// Fun reaction messages and emoji combinations for the Quizizz-style game mode.

interface Reaction {
  emoji: string;
  message: string;
}

// ─── Correct Answer Reactions ───────────────────────────────────────────────────

const CORRECT_REACTIONS: Reaction[] = [
  { emoji: '🔥', message: 'On Fire!' },
  { emoji: '💯', message: 'Perfect!' },
  { emoji: '🧠', message: 'Big Brain!' },
  { emoji: '⚡', message: 'Lightning Fast!' },
  { emoji: '🎯', message: 'Bullseye!' },
  { emoji: '🚀', message: 'Unstoppable!' },
  { emoji: '👑', message: 'Crown Material!' },
  { emoji: '✨', message: 'Brilliant!' },
  { emoji: '🌟', message: 'Superstar!' },
  { emoji: '💪', message: 'Flexin!' },
  { emoji: '🎉', message: 'Nailed It!' },
  { emoji: '😎', message: 'Too Easy!' },
];

const CORRECT_FAST_REACTIONS: Reaction[] = [
  { emoji: '⚡', message: 'Speed Demon!' },
  { emoji: '🏎️', message: 'Zooooom!' },
  { emoji: '💨', message: 'Gone in a Flash!' },
  { emoji: '🦅', message: 'Eagle Eye!' },
  { emoji: '🎯', message: 'Instant Reflex!' },
];

// ─── High Streak Reactions (5+) ─────────────────────────────────────────────────

const HIGH_STREAK_REACTIONS: Reaction[] = [
  { emoji: '🔥🔥🔥', message: 'LEGENDARY STREAK!' },
  { emoji: '😱', message: "Can't Be Stopped!" },
  { emoji: '💎', message: 'Diamond Tier!' },
  { emoji: '🏆', message: 'CHAMPION MODE!' },
  { emoji: '🌋', message: 'ERUPTION!' },
  { emoji: '⭐', message: 'SUPERNOVAAA!' },
  { emoji: '🦾', message: 'MACHINE MODE!' },
  { emoji: '👑🔥', message: 'ABSOLUTE ROYALTY!' },
];

// ─── Incorrect Answer Reactions ─────────────────────────────────────────────────

const INCORRECT_REACTIONS: Reaction[] = [
  { emoji: '😅', message: 'Almost!' },
  { emoji: '🤔', message: 'Think Again!' },
  { emoji: '💪', message: 'Keep Going!' },
  { emoji: '📚', message: 'Review Time!' },
  { emoji: '🌱', message: 'Learning Moment!' },
  { emoji: '😬', message: 'Oops!' },
  { emoji: '🫠', message: 'Next One!' },
  { emoji: '🤷', message: 'Happens to Everyone!' },
];

const FUNNY_INCORRECT_REACTIONS: Reaction[] = [
  { emoji: '💀', message: 'RIP Streak' },
  { emoji: '🍕', message: "At Least There's Pizza" },
  { emoji: '🐌', message: 'Slow and... Not Steady' },
  { emoji: '🪦', message: 'Press F to Pay Respects' },
  { emoji: '😭', message: 'My Eyes Are Sweating' },
  { emoji: '🤡', message: 'Clown Moment' },
  { emoji: '💔', message: 'Heartbreaker' },
  { emoji: '🫣', message: "Let's Pretend That Didn't Happen" },
  { emoji: '🧊', message: 'Ice Cold Take' },
  { emoji: '📉', message: 'Stonks Going Down' },
];

// ─── Time Ran Out Reactions ─────────────────────────────────────────────────────

const TIMEOUT_REACTIONS: Reaction[] = [
  { emoji: '⏰', message: 'Too Slow!' },
  { emoji: '🐢', message: 'Turtle Mode' },
  { emoji: '😴', message: 'Wake Up!' },
  { emoji: '🦥', message: 'Sloth Energy' },
  { emoji: '⌛', message: 'Time Waits for No One!' },
  { emoji: '🏖️', message: 'On Vacation?' },
];

// ─── Streak Milestone Messages ──────────────────────────────────────────────────

export const STREAK_MILESTONES: Record<number, { emoji: string; message: string }> = {
  3: { emoji: '🔥', message: '3 in a row!' },
  5: { emoji: '🔥🔥', message: '5 STREAK! AIRHORN!' },
  7: { emoji: '🔥🔥🔥', message: '7 STREAK! UNSTOPPABLE!' },
  10: { emoji: '💎🔥', message: '10 STREAK! LEGENDARY!' },
  15: { emoji: '👑🔥💎', message: '15 STREAK! GODLIKE!' },
};

// ─── Podium Messages ────────────────────────────────────────────────────────────

export const PODIUM_MESSAGES: Record<number, { emoji: string; title: string; subtitle: string }> = {
  1: { emoji: '🥇', title: 'CHAMPION!', subtitle: 'You absolutely dominated!' },
  2: { emoji: '🥈', title: 'Runner Up!', subtitle: 'So close to the throne!' },
  3: { emoji: '🥉', title: 'Bronze Medal!', subtitle: 'On the podium!' },
};

// ─── Main Reaction Picker ───────────────────────────────────────────────────────

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Get a reaction message for an answer.
 * @param isCorrect Whether the answer was correct
 * @param streak Current streak count (after this answer)
 * @param timeLeftPercent Percentage of time remaining (0-100), -1 if timed out
 */
export function getReactionForAnswer(
  isCorrect: boolean,
  streak: number,
  timeLeftPercent: number
): Reaction {
  // Timed out
  if (timeLeftPercent < 0) {
    return pickRandom(TIMEOUT_REACTIONS);
  }

  if (isCorrect) {
    // High streak reactions take priority
    if (streak >= 5) {
      return pickRandom(HIGH_STREAK_REACTIONS);
    }
    // Fast answer bonus
    if (timeLeftPercent > 70) {
      return Math.random() > 0.4 ? pickRandom(CORRECT_FAST_REACTIONS) : pickRandom(CORRECT_REACTIONS);
    }
    return pickRandom(CORRECT_REACTIONS);
  }

  // Incorrect — mix of encouraging and funny
  return Math.random() > 0.5 ? pickRandom(FUNNY_INCORRECT_REACTIONS) : pickRandom(INCORRECT_REACTIONS);
}

/**
 * Get a star label for the rating.
 */
export function getStarLabel(stars: number): string {
  switch (stars) {
    case 5: return 'Outstanding!';
    case 4: return 'Great Job!';
    case 3: return 'Good Effort!';
    case 2: return 'Keep Practicing!';
    default: return 'Room to Grow!';
  }
}
