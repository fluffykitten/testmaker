// ─── Game Realtime Service ──────────────────────────────────────────────────────
// Supabase Realtime Broadcast wrapper for live multiplayer game sessions.
// Uses Broadcast channels — zero database reads/writes.
// Teacher's browser acts as the game host.

import { supabase } from '../lib/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type {
  RTPlayerJoinMessage,
  RTPlayerLeaveMessage,
  RTGameStartMessage,
  RTQuestionStartMessage,
  RTPlayerAnswerMessage,
  RTAnswerRevealMessage,
  RTLeaderboardMessage,
  RTGameEndMessage,
  RTAnswerCountMessage,
  GameConfig,
  LeaderboardEntry,
} from '../types/gameTypes';

// ─── Channel Reference ─────────────────────────────────────────────────────────

let activeChannel: RealtimeChannel | null = null;
let activeQuizCode: string = '';

function getChannelName(quizCode: string): string {
  return `game:${quizCode.toUpperCase()}`;
}

// ─── Cleanup ────────────────────────────────────────────────────────────────────

export function destroySession(): void {
  if (activeChannel) {
    supabase.removeChannel(activeChannel);
    activeChannel = null;
    activeQuizCode = '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEACHER (HOST) SIDE
// ═══════════════════════════════════════════════════════════════════════════════

export interface HostCallbacks {
  onPlayerJoin: (msg: RTPlayerJoinMessage) => void;
  onPlayerLeave: (msg: RTPlayerLeaveMessage) => void;
  onPlayerAnswer: (msg: RTPlayerAnswerMessage) => void;
}

/**
 * Create a game session as the host (teacher).
 * Returns the channel for further interaction.
 */
export function createGameSession(
  quizCode: string,
  callbacks: HostCallbacks
): RealtimeChannel {
  destroySession(); // cleanup any existing session

  activeQuizCode = quizCode.toUpperCase();
  const channelName = getChannelName(activeQuizCode);

  activeChannel = supabase.channel(channelName, {
    config: { broadcast: { self: false } },
  });

  // Listen for player events
  activeChannel.on('broadcast', { event: 'player_join' }, ({ payload }) => {
    callbacks.onPlayerJoin(payload as RTPlayerJoinMessage);
  });

  activeChannel.on('broadcast', { event: 'player_leave' }, ({ payload }) => {
    callbacks.onPlayerLeave(payload as RTPlayerLeaveMessage);
  });

  activeChannel.on('broadcast', { event: 'player_answer' }, ({ payload }) => {
    callbacks.onPlayerAnswer(payload as RTPlayerAnswerMessage);
  });

  activeChannel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log(`[GameHost] Channel "${channelName}" ready`);
    }
  });

  return activeChannel;
}

/**
 * Broadcast: Game is starting
 */
export function broadcastGameStart(totalQuestions: number, config: GameConfig): void {
  if (!activeChannel) return;
  const msg: RTGameStartMessage = {
    type: 'game_start',
    totalQuestions,
    config,
  };
  activeChannel.send({ type: 'broadcast', event: 'game_start', payload: msg });
}

/**
 * Broadcast: New question starting
 */
export function broadcastQuestionStart(
  questionIndex: number,
  totalQuestions: number,
  questionText: string,
  options?: string[],
  timerMs?: number,
  hasImage?: boolean,
  imageUrl?: string,
  extra?: {
    title?: string;
    contextStem?: string;
    questionType?: 'mcq' | 'structured';
    marks?: number;
  }
): void {
  if (!activeChannel) return;
  const msg: RTQuestionStartMessage = {
    type: 'question_start',
    questionIndex,
    totalQuestions,
    questionText,
    options: options || [],
    timerMs: timerMs || 20000,
    hasImage: !!hasImage,
    imageUrl,
    title: extra?.title,
    contextStem: extra?.contextStem,
    questionType: extra?.questionType || (options && options.length >= 2 ? 'mcq' : 'structured'),
    marks: extra?.marks,
  };
  activeChannel.send({ type: 'broadcast', event: 'question_start', payload: msg });
}

/**
 * Broadcast: Answer count update (how many have answered)
 */
export function broadcastAnswerCount(questionIndex: number, count: number, total: number): void {
  if (!activeChannel) return;
  const msg: RTAnswerCountMessage = {
    type: 'answer_count',
    questionIndex,
    count,
    total,
  };
  activeChannel.send({ type: 'broadcast', event: 'answer_count', payload: msg });
}

/**
 * Broadcast: Reveal correct answer + individual player results
 */
export function broadcastAnswerReveal(
  questionIndex: number,
  correctOptionIndex: number | undefined,
  playerResults: RTAnswerRevealMessage['playerResults'],
  correctAnswerText?: string,
  feedbackText?: string
): void {
  if (!activeChannel) return;
  const msg: RTAnswerRevealMessage = {
    type: 'answer_reveal',
    questionIndex,
    correctOptionIndex,
    correctAnswerText,
    feedbackText,
    playerResults,
  };
  activeChannel.send({ type: 'broadcast', event: 'answer_reveal', payload: msg });
}

/**
 * Broadcast: Updated leaderboard
 */
export function broadcastLeaderboard(entries: LeaderboardEntry[], questionIndex: number): void {
  if (!activeChannel) return;
  const msg: RTLeaderboardMessage = {
    type: 'leaderboard_update',
    entries,
    questionIndex,
  };
  activeChannel.send({ type: 'broadcast', event: 'leaderboard_update', payload: msg });
}

/**
 * Broadcast: Game has ended
 */
export function broadcastGameEnd(finalLeaderboard: LeaderboardEntry[], questionCount: number): void {
  if (!activeChannel) return;
  const msg: RTGameEndMessage = {
    type: 'game_end',
    finalLeaderboard,
    questionCount,
  };
  activeChannel.send({ type: 'broadcast', event: 'game_end', payload: msg });
}

// ═══════════════════════════════════════════════════════════════════════════════
// STUDENT (PLAYER) SIDE
// ═══════════════════════════════════════════════════════════════════════════════

export interface PlayerCallbacks {
  onGameStart: (msg: RTGameStartMessage) => void;
  onQuestionStart: (msg: RTQuestionStartMessage) => void;
  onAnswerCount: (msg: RTAnswerCountMessage) => void;
  onAnswerReveal: (msg: RTAnswerRevealMessage) => void;
  onLeaderboardUpdate: (msg: RTLeaderboardMessage) => void;
  onGameEnd: (msg: RTGameEndMessage) => void;
}

/**
 * Join a game session as a student (player).
 */
export function joinGameSession(
  quizCode: string,
  playerId: string,
  nickname: string,
  avatarEmoji: string,
  callbacks: PlayerCallbacks
): RealtimeChannel {
  destroySession(); // cleanup any existing session

  activeQuizCode = quizCode.toUpperCase();
  const channelName = getChannelName(activeQuizCode);

  activeChannel = supabase.channel(channelName, {
    config: { broadcast: { self: false } },
  });

  // Listen for host events
  activeChannel.on('broadcast', { event: 'game_start' }, ({ payload }) => {
    callbacks.onGameStart(payload as RTGameStartMessage);
  });

  activeChannel.on('broadcast', { event: 'question_start' }, ({ payload }) => {
    callbacks.onQuestionStart(payload as RTQuestionStartMessage);
  });

  activeChannel.on('broadcast', { event: 'answer_count' }, ({ payload }) => {
    callbacks.onAnswerCount(payload as RTAnswerCountMessage);
  });

  activeChannel.on('broadcast', { event: 'answer_reveal' }, ({ payload }) => {
    callbacks.onAnswerReveal(payload as RTAnswerRevealMessage);
  });

  activeChannel.on('broadcast', { event: 'leaderboard_update' }, ({ payload }) => {
    callbacks.onLeaderboardUpdate(payload as RTLeaderboardMessage);
  });

  activeChannel.on('broadcast', { event: 'game_end' }, ({ payload }) => {
    callbacks.onGameEnd(payload as RTGameEndMessage);
  });

  activeChannel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log(`[GamePlayer] Joined channel "${channelName}"`);
      // Announce ourselves to the host
      sendPlayerJoin(playerId, nickname, avatarEmoji);
    }
  });

  return activeChannel;
}

/**
 * Send: Player joining the game
 */
export function sendPlayerJoin(playerId: string, nickname: string, avatarEmoji: string): void {
  if (!activeChannel) return;
  const msg: RTPlayerJoinMessage = {
    type: 'player_join',
    playerId,
    nickname,
    avatarEmoji,
  };
  activeChannel.send({ type: 'broadcast', event: 'player_join', payload: msg });
}

/**
 * Send: Player's answer to current question (option index or typed string)
 */
export function sendPlayerAnswer(
  playerId: string,
  nickname: string,
  questionIndex: number,
  answer: number | string,
  timeLeftMs: number
): void {
  if (!activeChannel) return;
  const isNumeric = typeof answer === 'number';
  const msg: RTPlayerAnswerMessage = {
    type: 'player_answer',
    playerId,
    nickname,
    questionIndex,
    optionIndex: isNumeric ? answer : undefined,
    textAnswer: !isNumeric ? String(answer) : undefined,
    timeLeftMs,
  };
  activeChannel.send({ type: 'broadcast', event: 'player_answer', payload: msg });
}

/**
 * Send: Player leaving the game
 */
export function sendPlayerLeave(playerId: string): void {
  if (!activeChannel) return;
  const msg: RTPlayerLeaveMessage = {
    type: 'player_leave',
    playerId,
  };
  activeChannel.send({ type: 'broadcast', event: 'player_leave', payload: msg });
  destroySession();
}

/**
 * Get the current active channel (for checking connection status).
 */
export function getActiveChannel(): RealtimeChannel | null {
  return activeChannel;
}

export function getActiveQuizCode(): string {
  return activeQuizCode;
}
