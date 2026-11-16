export interface AudioPlayLimitState {
  configuredLimit: number | null;
  playedCount: number;
  currentTime: number;
  isPlaying: boolean;
  hasConsumedCurrentRun: boolean;
}

export interface AudioLimitStatus {
  hasLimit: boolean;
  isLimitReached: boolean;
  remainingPlays: number | null;
  isMidRun: boolean;
  isPausedMidRun: boolean;
  isPlaybackLocked: boolean;
}

/**
 * Returns true when playback for the current run has started and not yet ended.
 */
export function isMidAudioRun(
  state: Pick<AudioPlayLimitState, 'currentTime' | 'hasConsumedCurrentRun'>
): boolean {
  return state.hasConsumedCurrentRun || state.currentTime > 0;
}

/**
 * Computes play-limit status for ExamAudioPlayer.
 * Allows pausing and resuming an in-progress run (even under a 1x limit)
 * until the audio finishes (`onEnded`), instead of locking mid-track.
 */
export function getAudioLimitStatus(state: AudioPlayLimitState): AudioLimitStatus {
  const { configuredLimit, playedCount, isPlaying } = state;
  const hasLimit = configuredLimit !== null && configuredLimit > 0;
  const isLimitReached = hasLimit && playedCount >= configuredLimit;
  const remainingPlays = hasLimit ? Math.max(0, configuredLimit - playedCount) : null;
  const midRun = isMidAudioRun(state);

  const isPlaybackLocked = isLimitReached && !isPlaying && !midRun;
  const isPausedMidRun = !isPlaying && midRun;

  return {
    hasLimit,
    isLimitReached,
    remainingPlays,
    isMidRun: midRun,
    isPausedMidRun,
    isPlaybackLocked,
  };
}

/**
 * Determines whether starting playback should consume a play count.
 * Guards against double-counting when resuming a paused run (even at < 1s).
 */
export function shouldConsumePlayCount(
  currentTime: number,
  hasConsumedCurrentRun: boolean
): boolean {
  return currentTime < 1 && !hasConsumedCurrentRun;
}
