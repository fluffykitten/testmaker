// ─── Game Mode Type Definitions ─────────────────────────────────────────────────
// Types for the Quizizz-style gamified quiz mode with real-time multiplayer.

// ─── Game Configuration ─────────────────────────────────────────────────────────

export interface GameConfig {
  quizMode: 'exam' | 'game';
  enablePowerUps: boolean;
  enableStreaks: boolean;
  enableFunSounds: boolean;
  enableMemes: boolean;
  pointsPerQuestion: number;       // default 1000
  questionTimerSeconds: number;    // default 20
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
}

export const DEFAULT_GAME_CONFIG: GameConfig = {
  quizMode: 'game',
  enablePowerUps: true,
  enableStreaks: true,
  enableFunSounds: true,
  enableMemes: true,
  pointsPerQuestion: 1000,
  questionTimerSeconds: 20,
  shuffleQuestions: true,
  shuffleOptions: true,
};

// ─── Player State ───────────────────────────────────────────────────────────────

export type PowerUpType = 'fifty_fifty' | 'time_freeze' | 'double_points';

export interface PowerUpState {
  type: PowerUpType;
  used: boolean;
}

export interface GamePlayer {
  id: string;                      // unique per session
  nickname: string;
  avatarEmoji: string;
  score: number;
  streak: number;
  longestStreak: number;
  correctCount: number;
  totalAnswered: number;
  totalResponseTimeMs: number;     // sum of all response times
  powerUps: PowerUpState[];
  isHost: boolean;
}

// ─── Question State ─────────────────────────────────────────────────────────────

export interface GameQuestionState {
  questionIndex: number;
  totalQuestions: number;
  timerMs: number;                 // remaining ms
  totalTimerMs: number;            // total ms for this question
  answersReceived: number;         // how many players have answered
  totalPlayers: number;
  phase: 'countdown' | 'answering' | 'feedback' | 'leaderboard';
}

// ─── Answer & Feedback ──────────────────────────────────────────────────────────

export interface PlayerAnswer {
  playerId: string;
  questionIndex: number;
  optionIndex?: number;
  textAnswer?: string;
  timeLeftMs: number;              // how much time was left when they answered
  timestamp: number;
}

export interface AnswerFeedback {
  isCorrect: boolean;
  correctOptionIndex: number;
  pointsEarned: number;
  basePoints: number;
  timeBonus: number;
  streakMultiplier: number;
  newStreak: number;
  newTotalScore: number;
  reaction: { emoji: string; message: string };
  usedDoublePoints: boolean;
}

// ─── Leaderboard ────────────────────────────────────────────────────────────────

export interface LeaderboardEntry {
  playerId: string;
  nickname: string;
  avatarEmoji: string;
  score: number;
  rank: number;
  previousRank: number;           // for rank change animation
  streak: number;
  lastAnswerCorrect: boolean;
  correctCount: number;
  totalAnswered: number;
}

// ─── Game Session ───────────────────────────────────────────────────────────────

export type GamePhase =
  | 'lobby'           // waiting for players
  | 'countdown'       // 3-2-1-GO
  | 'question'        // showing question, timer running
  | 'question_result' // showing correct answer + feedback
  | 'leaderboard'     // showing rankings between questions
  | 'final_results';  // game over, podium

export interface GameSession {
  quizCode: string;
  quizTitle: string;
  config: GameConfig;
  phase: GamePhase;
  players: Map<string, GamePlayer>;
  currentQuestionIndex: number;
  totalQuestions: number;
  questionStartTime: number;       // timestamp when question was shown
}

// ─── Realtime Broadcast Message Types ───────────────────────────────────────────

export interface RTPlayerJoinMessage {
  type: 'player_join';
  playerId: string;
  nickname: string;
  avatarEmoji: string;
}

export interface RTPlayerLeaveMessage {
  type: 'player_leave';
  playerId: string;
}

export interface RTGameStartMessage {
  type: 'game_start';
  totalQuestions: number;
  config: GameConfig;
}

export interface RTQuestionStartMessage {
  type: 'question_start';
  questionIndex: number;
  totalQuestions: number;
  title?: string;
  contextStem?: string;
  questionText: string;
  questionType?: 'mcq' | 'structured';
  options?: string[];
  timerMs: number;
  hasImage: boolean;
  imageUrl?: string;
  marks?: number;
}

export interface RTPlayerAnswerMessage {
  type: 'player_answer';
  playerId: string;
  nickname: string;
  questionIndex: number;
  optionIndex?: number;
  textAnswer?: string;
  timeLeftMs: number;
}

export interface RTAnswerRevealMessage {
  type: 'answer_reveal';
  questionIndex: number;
  correctOptionIndex?: number;
  correctAnswerText?: string;
  feedbackText?: string;
  playerResults: Record<string, {
    isCorrect: boolean;
    pointsEarned: number;
    newScore: number;
    newStreak: number;
    reaction: { emoji: string; message: string };
  }>;
}

export interface RTLeaderboardMessage {
  type: 'leaderboard_update';
  entries: LeaderboardEntry[];
  questionIndex: number;
}

export interface RTGameEndMessage {
  type: 'game_end';
  finalLeaderboard: LeaderboardEntry[];
  questionCount: number;
}

export interface RTAnswerCountMessage {
  type: 'answer_count';
  questionIndex: number;
  count: number;
  total: number;
}

export type RealtimeGameMessage =
  | RTPlayerJoinMessage
  | RTPlayerLeaveMessage
  | RTGameStartMessage
  | RTQuestionStartMessage
  | RTPlayerAnswerMessage
  | RTAnswerRevealMessage
  | RTLeaderboardMessage
  | RTGameEndMessage
  | RTAnswerCountMessage;

// ─── Avatar Emoji Options ───────────────────────────────────────────────────────

export const AVATAR_EMOJIS = [
  '🐱', '🦊', '🐼', '🦁', '🐸', '🦄', '🐉', '🎃', '🤖', '👾',
  '🐶', '🐯', '🦋', '🐙', '🦈', '🐧', '🦩', '🐝', '🦖', '🐨',
  '🍕', '🌮', '🍩', '🧁', '🎸', '⚡', '🌈', '🎯', '🏆', '💎',
];
