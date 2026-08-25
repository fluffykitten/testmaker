// ─── Game Sound Engine ──────────────────────────────────────────────────────────
// Web Audio API synthesized sound effects for the Quizizz-style game mode.
// Zero external audio files — all sounds generated programmatically.

let audioContext: AudioContext | null = null;
let masterVolume = 0.6;
let isMuted = false;

function getContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  // Resume if suspended (browser autoplay policy)
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
  return audioContext;
}

function getGain(ctx: AudioContext, volume: number = 1): GainNode {
  const gain = ctx.createGain();
  gain.gain.value = isMuted ? 0 : volume * masterVolume;
  gain.connect(ctx.destination);
  return gain;
}

// ─── Volume Controls ────────────────────────────────────────────────────────────

export function setVolume(vol: number): void {
  masterVolume = Math.max(0, Math.min(1, vol));
}

export function getVolume(): number {
  return masterVolume;
}

export function toggleMute(): boolean {
  isMuted = !isMuted;
  return isMuted;
}

export function getIsMuted(): boolean {
  return isMuted;
}

// ─── Helper: Play a Tone ────────────────────────────────────────────────────────

function playTone(
  frequency: number,
  duration: number,
  type: OscillatorType = 'sine',
  volume: number = 0.5,
  startDelay: number = 0
): void {
  const ctx = getContext();
  const osc = ctx.createOscillator();
  const gain = getGain(ctx, volume);

  osc.type = type;
  osc.frequency.value = frequency;
  osc.connect(gain);

  const startTime = ctx.currentTime + startDelay;
  gain.gain.setValueAtTime(volume * masterVolume * (isMuted ? 0 : 1), startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playNoise(duration: number, volume: number = 0.3, startDelay: number = 0): void {
  const ctx = getContext();
  const bufferSize = ctx.sampleRate * duration;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * 0.5;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = getGain(ctx, volume);
  source.connect(gain);

  const startTime = ctx.currentTime + startDelay;
  gain.gain.setValueAtTime(volume * masterVolume * (isMuted ? 0 : 1), startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  source.start(startTime);
  source.stop(startTime + duration);
}

// ─── Sound Effects ──────────────────────────────────────────────────────────────

/**
 * Bright ascending chime — correct answer
 */
export function playCorrectSound(): void {
  playTone(523.25, 0.12, 'sine', 0.5);      // C5
  playTone(659.25, 0.12, 'sine', 0.5, 0.08); // E5
  playTone(783.99, 0.2, 'sine', 0.6, 0.16);  // G5
  playTone(1046.5, 0.3, 'sine', 0.4, 0.24);  // C6
}

/**
 * Low descending buzz — wrong answer
 */
export function playWrongSound(): void {
  playTone(311.13, 0.15, 'sawtooth', 0.3);   // Eb4
  playTone(233.08, 0.25, 'sawtooth', 0.25, 0.12); // Bb3
  playNoise(0.15, 0.15, 0.05);
}

/**
 * Streak fire whoosh — pitch rises with streak count
 */
export function playStreakSound(streakCount: number): void {
  const baseFreq = 400 + streakCount * 60;
  playTone(baseFreq, 0.08, 'sine', 0.4);
  playTone(baseFreq * 1.25, 0.08, 'sine', 0.4, 0.06);
  playTone(baseFreq * 1.5, 0.12, 'sine', 0.5, 0.12);
  playTone(baseFreq * 2, 0.2, 'sine', 0.3, 0.18);
}

/**
 * Subtle countdown tick (last 5 seconds)
 */
export function playCountdownTick(): void {
  playTone(800, 0.05, 'square', 0.15);
}

/**
 * Urgent rapid beeping (last 3 seconds)
 */
export function playCountdownUrgent(): void {
  playTone(1000, 0.06, 'square', 0.25);
  playTone(1000, 0.06, 'square', 0.25, 0.1);
}

/**
 * Magical sparkle — power-up activation
 */
export function playPowerUpActivate(): void {
  const notes = [784, 988, 1175, 1568, 1976];
  notes.forEach((freq, i) => {
    playTone(freq, 0.1, 'sine', 0.3, i * 0.04);
  });
  playNoise(0.08, 0.1, 0.15);
}

/**
 * Energetic countdown: 3... 2... 1... GO!
 */
export function playGameStartCountdown(step: number): void {
  if (step === 0) {
    // "GO!" — triumphant chord
    playTone(523.25, 0.1, 'sine', 0.5);
    playTone(659.25, 0.1, 'sine', 0.5);
    playTone(783.99, 0.3, 'sine', 0.6);
    playTone(1046.5, 0.4, 'sine', 0.5, 0.08);
    playNoise(0.05, 0.2);
  } else {
    // 3, 2, 1 — ascending pips
    const freq = 440 + (4 - step) * 110;
    playTone(freq, 0.15, 'sine', 0.4);
  }
}

/**
 * Victory fanfare — triumphant horn + cascade
 */
export function playVictoryFanfare(): void {
  // Fanfare ascending
  const fanfare = [523, 659, 784, 1047, 784, 1047, 1319];
  fanfare.forEach((freq, i) => {
    const dur = i === fanfare.length - 1 ? 0.5 : 0.12;
    playTone(freq, dur, 'sine', 0.4, i * 0.1);
  });
  // Sparkle overlay
  [2093, 2637, 3136, 2637, 3136].forEach((freq, i) => {
    playTone(freq, 0.06, 'sine', 0.15, 0.5 + i * 0.06);
  });
}

/**
 * Airhorn — on 5+ streak milestone
 */
export function playAirhorn(): void {
  const ctx = getContext();
  const osc1 = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const gain = getGain(ctx, 0.35);

  osc1.type = 'sawtooth';
  osc1.frequency.value = 480;
  osc2.type = 'sawtooth';
  osc2.frequency.value = 540;

  osc1.connect(gain);
  osc2.connect(gain);

  const now = ctx.currentTime;
  gain.gain.setValueAtTime(0.35 * masterVolume * (isMuted ? 0 : 1), now);
  gain.gain.linearRampToValueAtTime(0.4 * masterVolume * (isMuted ? 0 : 1), now + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

  osc1.start(now);
  osc2.start(now);
  osc1.stop(now + 0.6);
  osc2.stop(now + 0.6);
}

/**
 * Funny wrong sounds — randomly picks one
 */
export function playFunnyWrong(): void {
  const pick = Math.floor(Math.random() * 3);
  switch (pick) {
    case 0: playSadTrombone(); break;
    case 1: playSlideWhistle(); break;
    case 2: playComicBoing(); break;
  }
}

// ─── Funny Sound Internals ──────────────────────────────────────────────────────

function playSadTrombone(): void {
  // wah wah wah waaah
  const notes = [
    { freq: 311, dur: 0.25 },
    { freq: 293, dur: 0.25 },
    { freq: 277, dur: 0.25 },
    { freq: 233, dur: 0.6 },
  ];
  let offset = 0;
  notes.forEach(({ freq, dur }) => {
    playTone(freq, dur, 'sawtooth', 0.25, offset);
    offset += dur * 0.85;
  });
}

function playSlideWhistle(): void {
  const ctx = getContext();
  const osc = ctx.createOscillator();
  const gain = getGain(ctx, 0.3);

  osc.type = 'sine';
  osc.frequency.setValueAtTime(1200, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.5);
  osc.connect(gain);

  gain.gain.setValueAtTime(0.3 * masterVolume * (isMuted ? 0 : 1), ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.55);

  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.55);
}

function playComicBoing(): void {
  const ctx = getContext();
  const osc = ctx.createOscillator();
  const gain = getGain(ctx, 0.35);

  osc.type = 'sine';
  const now = ctx.currentTime;
  osc.frequency.setValueAtTime(150, now);
  osc.frequency.exponentialRampToValueAtTime(600, now + 0.08);
  osc.frequency.exponentialRampToValueAtTime(250, now + 0.2);
  osc.frequency.exponentialRampToValueAtTime(500, now + 0.28);
  osc.frequency.exponentialRampToValueAtTime(200, now + 0.4);
  osc.connect(gain);

  gain.gain.setValueAtTime(0.35 * masterVolume * (isMuted ? 0 : 1), now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

  osc.start(now);
  osc.stop(now + 0.45);
}

/**
 * Quick click/tap feedback sound
 */
export function playClickSound(): void {
  playTone(600, 0.04, 'sine', 0.2);
}

/**
 * Player joined lobby sound
 */
export function playPlayerJoinSound(): void {
  playTone(880, 0.08, 'sine', 0.25);
  playTone(1100, 0.1, 'sine', 0.2, 0.06);
}
