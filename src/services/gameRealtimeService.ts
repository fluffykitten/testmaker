// ─── Game Realtime Service ──────────────────────────────────────────────────────
// Supabase Realtime Broadcast wrapper for live multiplayer game sessions.
// Uses Broadcast channels — zero database reads/writes.
// Teacher's browser acts as the game host.

import { supabase } from '../lib/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  generateProctorSigningSession,
  signGameBroadcastFrame,
  verifyGameBroadcastFrame,
  type ProctorSigningSession,
  type PublicKeyLookupResult,
} from '../lib/proctorCommandAuth';
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

let hostSigningSessionPromise: Promise<ProctorSigningSession | null> | null = null;
const registeredGameHostKeys = new Set<string>();
const gameKeyRegPromises = new Map<string, Promise<{ registered: boolean; rpcMissing: boolean }>>();
const gamePublicKeyCache = new Map<string, PublicKeyLookupResult>();

function isMissingRpcError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return (
    error.code === '42883' ||
    error.code === 'PGRST202' ||
    /could not find the function|does not exist/i.test(error.message || '')
  );
}

function getOrCreateGameHostSigningSession(): Promise<ProctorSigningSession | null> {
  if (!hostSigningSessionPromise) {
    hostSigningSessionPromise = generateProctorSigningSession().catch(() => null);
  }
  return hostSigningSessionPromise;
}

async function ensureGameHostKeyRegistered(
  code: string
): Promise<{ session: ProctorSigningSession | null; registered: boolean; rpcMissing: boolean }> {
  const session = await getOrCreateGameHostSigningSession();
  if (!session) return { session: null, registered: false, rpcMissing: false };

  const regKey = `${code}::${session.keyId}`;
  if (registeredGameHostKeys.has(regKey)) {
    return { session, registered: true, rpcMissing: false };
  }

  let inflight = gameKeyRegPromises.get(regKey);
  if (!inflight) {
    inflight = (async () => {
      try {
        const { error } = await (supabase as any).rpc('register_proctor_public_key', {
          p_quiz_code: code,
          p_key_id: session.keyId,
          p_public_jwk: session.publicJwk,
        });
        if (!error) {
          registeredGameHostKeys.add(regKey);
          return { registered: true, rpcMissing: false };
        }
        if (isMissingRpcError(error)) {
          return { registered: false, rpcMissing: true };
        }
        return { registered: false, rpcMissing: false };
      } catch {
        return { registered: false, rpcMissing: false };
      }
    })();
    gameKeyRegPromises.set(regKey, inflight);
  }

  const res = await inflight;
  if (!res.registered) {
    gameKeyRegPromises.delete(regKey);
  }
  return { session, registered: res.registered, rpcMissing: res.rpcMissing };
}

async function resolveGamePublicKey(
  quizCode: string,
  keyId: string
): Promise<PublicKeyLookupResult> {
  const code = quizCode.trim().toUpperCase();
  const cacheKey = `${code}::${keyId}`;
  const cached = gamePublicKeyCache.get(cacheKey);
  if (cached?.found) return cached;

  try {
    const { data, error } = await (supabase as any).rpc('get_proctor_public_key', {
      p_quiz_code: code,
      p_key_id: keyId,
    });
    if (error) {
      if (isMissingRpcError(error)) {
        return { found: false, rpcUnavailable: true };
      }
      return { found: false };
    }
    if (data?.found && data?.isActive !== false && data?.publicJwk) {
      const result: PublicKeyLookupResult = { found: true, publicJwk: data.publicJwk };
      gamePublicKeyCache.set(cacheKey, result);
      return result;
    }
    return { found: false };
  } catch {
    return { found: false };
  }
}

async function sendSignedHostFrame<T extends Record<string, unknown>>(
  event: string,
  payload: T
): Promise<void> {
  const ch = activeChannel;
  const code = activeQuizCode;
  if (!ch || !code) return;

  const { session, registered, rpcMissing } = await ensureGameHostKeyRegistered(code);
  if (session && registered) {
    try {
      const signed = await signGameBroadcastFrame(session, code, payload);
      await ch.send({ type: 'broadcast', event, payload: signed });
      return;
    } catch {
      // fall through only if signing failed in unsupported environment
    }
  }
  if (!rpcMissing && registered === false) {
    console.warn('[game] blocked unsigned host frame — signing key not registered');
    return;
  }
  await ch.send({ type: 'broadcast', event, payload });
}

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
  void ensureGameHostKeyRegistered(activeQuizCode);

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
  void sendSignedHostFrame('game_start', msg as unknown as Record<string, unknown>);
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
  void sendSignedHostFrame('question_start', msg as unknown as Record<string, unknown>);
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
  void sendSignedHostFrame('answer_count', msg as unknown as Record<string, unknown>);
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
  void sendSignedHostFrame('answer_reveal', msg as unknown as Record<string, unknown>);
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
  void sendSignedHostFrame('leaderboard_update', msg as unknown as Record<string, unknown>);
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
  void sendSignedHostFrame('game_end', msg as unknown as Record<string, unknown>);
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

  // Listen for signed host events (VULN-P3-08)
  const handleVerifiedHostEvent = <T>(eventLabel: string, payload: unknown, handler: (msg: T) => void) => {
    const channelCode = activeQuizCode;
    void verifyGameBroadcastFrame(payload as Record<string, unknown>, channelCode, resolveGamePublicKey).then(
      (verdict) => {
        if (verdict.status === 'valid' || verdict.status === 'legacy_fallback') {
          handler(payload as T);
        } else {
          console.warn(`[game] dropped unverified host frame (${eventLabel}):`, verdict.reason);
        }
      }
    );
  };

  activeChannel.on('broadcast', { event: 'game_start' }, ({ payload }) => {
    handleVerifiedHostEvent('game_start', payload, callbacks.onGameStart);
  });

  activeChannel.on('broadcast', { event: 'question_start' }, ({ payload }) => {
    handleVerifiedHostEvent('question_start', payload, callbacks.onQuestionStart);
  });

  activeChannel.on('broadcast', { event: 'answer_count' }, ({ payload }) => {
    handleVerifiedHostEvent('answer_count', payload, callbacks.onAnswerCount);
  });

  activeChannel.on('broadcast', { event: 'answer_reveal' }, ({ payload }) => {
    handleVerifiedHostEvent('answer_reveal', payload, callbacks.onAnswerReveal);
  });

  activeChannel.on('broadcast', { event: 'leaderboard_update' }, ({ payload }) => {
    handleVerifiedHostEvent('leaderboard_update', payload, callbacks.onLeaderboardUpdate);
  });

  activeChannel.on('broadcast', { event: 'game_end' }, ({ payload }) => {
    handleVerifiedHostEvent('game_end', payload, callbacks.onGameEnd);
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
