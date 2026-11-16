import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getAudioLimitStatus, shouldConsumePlayCount } from '../src/utils/audioPlaybackUtils.ts';

function runUnitTests() {
  // 1. Fresh 1x track before first play
  const initial1x = getAudioLimitStatus({
    configuredLimit: 1,
    playedCount: 0,
    currentTime: 0,
    isPlaying: false,
    hasConsumedCurrentRun: false,
  });
  assert.equal(initial1x.isLimitReached, false);
  assert.equal(initial1x.isPlaybackLocked, false);
  assert.equal(shouldConsumePlayCount(0, false), true);

  // 2. Actively playing 1x track after play count consumed
  const playing1x = getAudioLimitStatus({
    configuredLimit: 1,
    playedCount: 1,
    currentTime: 12,
    isPlaying: true,
    hasConsumedCurrentRun: true,
  });
  assert.equal(playing1x.isLimitReached, true);
  assert.equal(playing1x.isPlaybackLocked, false);
  assert.equal(playing1x.isPausedMidRun, false);

  // 3. Paused mid-track at 25s under 1x limit -> MUST allow resume
  const pausedMid1x = getAudioLimitStatus({
    configuredLimit: 1,
    playedCount: 1,
    currentTime: 25,
    isPlaying: false,
    hasConsumedCurrentRun: true,
  });
  assert.equal(pausedMid1x.isLimitReached, true);
  assert.equal(pausedMid1x.isPausedMidRun, true);
  assert.equal(pausedMid1x.isPlaybackLocked, false, 'Must allow resuming 1x track paused mid-run');
  assert.equal(shouldConsumePlayCount(25, true), false);

  // 4. Paused very early (< 1s) under 1x limit -> MUST allow resume without double-counting
  const pausedEarly1x = getAudioLimitStatus({
    configuredLimit: 1,
    playedCount: 1,
    currentTime: 0.3,
    isPlaying: false,
    hasConsumedCurrentRun: true,
  });
  assert.equal(pausedEarly1x.isPausedMidRun, true);
  assert.equal(pausedEarly1x.isPlaybackLocked, false, 'Must allow resuming 1x track paused before 1s');
  assert.equal(shouldConsumePlayCount(0.3, true), false, 'Must not double-count on early resume');

  // 5. Session reload mid-track under 1x limit (currentTime > 0, playedCount = 1)
  const reloadedMid1x = getAudioLimitStatus({
    configuredLimit: 1,
    playedCount: 1,
    currentTime: 18.5,
    isPlaying: false,
    hasConsumedCurrentRun: true,
  });
  assert.equal(reloadedMid1x.isPlaybackLocked, false, 'Must allow resuming 1x track after reload');

  // 6. After track finishes (`onEnded` resets currentTime = 0 and hasConsumedCurrentRun = false) -> locked!
  const ended1x = getAudioLimitStatus({
    configuredLimit: 1,
    playedCount: 1,
    currentTime: 0,
    isPlaying: false,
    hasConsumedCurrentRun: false,
  });
  assert.equal(ended1x.isLimitReached, true);
  assert.equal(ended1x.isPausedMidRun, false);
  assert.equal(ended1x.isPlaybackLocked, true, 'Must lock once the 1x run finishes cleanly');

  // 7. 2x limit lifecycle: after 1st end -> unlocked; after 2nd pause -> unlocked; after 2nd end -> locked
  const afterFirstEnd2x = getAudioLimitStatus({
    configuredLimit: 2,
    playedCount: 1,
    currentTime: 0,
    isPlaying: false,
    hasConsumedCurrentRun: false,
  });
  assert.equal(afterFirstEnd2x.remainingPlays, 1);
  assert.equal(afterFirstEnd2x.isPlaybackLocked, false);

  const pausedSecond2x = getAudioLimitStatus({
    configuredLimit: 2,
    playedCount: 2,
    currentTime: 10,
    isPlaying: false,
    hasConsumedCurrentRun: true,
  });
  assert.equal(pausedSecond2x.isPlaybackLocked, false);

  const afterSecondEnd2x = getAudioLimitStatus({
    configuredLimit: 2,
    playedCount: 2,
    currentTime: 0,
    isPlaying: false,
    hasConsumedCurrentRun: false,
  });
  assert.equal(afterSecondEnd2x.isPlaybackLocked, true);

  // 8. Unlimited mode never locks
  const unlimited = getAudioLimitStatus({
    configuredLimit: null,
    playedCount: 5,
    currentTime: 0,
    isPlaying: false,
    hasConsumedCurrentRun: false,
  });
  assert.equal(unlimited.isPlaybackLocked, false);

  console.log('PASS: Audio playback limit & mid-run resume unit tests');
}

function runSourceWiringChecks() {
  const playerSrc = fs.readFileSync('src/components/ExamAudioPlayer.tsx', 'utf8');
  assert.ok(playerSrc.includes('getAudioLimitStatus'), 'ExamAudioPlayer must use getAudioLimitStatus');
  assert.ok(playerSrc.includes('shouldConsumePlayCount'), 'ExamAudioPlayer must use shouldConsumePlayCount');
  assert.ok(playerSrc.includes('disabled={isPlaybackLocked}'), 'Play/Pause buttons must gate on isPlaybackLocked');
  assert.equal(
    playerSrc.includes('disabled={isLimitReached && !isPlaying}'),
    false,
    'Old mid-run lockout condition must not remain'
  );
  console.log('PASS: ExamAudioPlayer Option A wiring verified');
}

runUnitTests();
runSourceWiringChecks();
