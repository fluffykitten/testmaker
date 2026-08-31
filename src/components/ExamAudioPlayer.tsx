import React, { useState, useRef, useEffect } from 'react';
import type { AudioMetadata } from '../types/database';
import { formatAudioDuration, speakTtsPreview, stopTtsSpeech } from '../services/audioService';
import './ExamAudioPlayer.css';

interface ExamAudioPlayerProps {
  audioUrl: string;
  metadata?: AudioMetadata | null;
  title?: string;
  compact?: boolean;
  isIeltsMode?: boolean;
  disableSeeking?: boolean;
  disableSpeed?: boolean;
  questionRangeLabel?: string;
  maxPlaysAllowed?: number | null;
  allowTranscript?: boolean;
  autoPlay?: boolean;
  initialCurrentTime?: number;
  initialPlayedCount?: number;
  onTimeUpdate?: (currentTime: number) => void;
  onPlayCountChange?: (remainingPlays: number | null, playedCount: number) => void;
  className?: string;
}

export function ExamAudioPlayer({
  audioUrl,
  metadata,
  title,
  compact = false,
  isIeltsMode = false,
  disableSeeking = false,
  disableSpeed = false,
  questionRangeLabel,
  maxPlaysAllowed,
  allowTranscript = true,
  autoPlay = false,
  initialCurrentTime = 0,
  initialPlayedCount = 0,
  onTimeUpdate,
  onPlayCountChange,
  className = '',
}: ExamAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const isTts = Boolean(audioUrl && audioUrl.startsWith('tts://'));
  const shouldDisableSeeking = isIeltsMode || disableSeeking;
  const shouldDisableSpeed = isIeltsMode || disableSpeed;

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(initialCurrentTime);
  const [duration, setDuration] = useState(metadata?.duration || 0);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [volume, setVolume] = useState(1.0);
  const [isMuted, setIsMuted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);

  // Play limit configuration (maxPlaysAllowed overrides metadata.play_limit if defined)
  const configuredLimit = maxPlaysAllowed !== undefined ? maxPlaysAllowed : (metadata?.play_limit ?? null);
  const [playedCount, setPlayedCount] = useState(initialPlayedCount);

  const isLimitReached = configuredLimit !== null && configuredLimit > 0 && playedCount >= configuredLimit;
  const remainingPlays = configuredLimit !== null && configuredLimit > 0 ? Math.max(0, configuredLimit - playedCount) : null;

  const displayTitle = title || metadata?.title || 'Listening Comprehension Audio';

  // Handle play state
  const handleTogglePlay = async () => {
    if (isTts) {
      if (isPlaying) {
        stopTtsSpeech();
        setIsPlaying(false);
      } else {
        if (isLimitReached) return;
        handlePlayStarted();
        setIsPlaying(true);
        speakTtsPreview(
          metadata?.transcript || displayTitle,
          metadata?.voice,
          playbackRate,
          1.0,
          () => {
            handleEnded();
          }
        );
      }
      return;
    }

    if (!audioRef.current) return;

    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      if (isLimitReached) return;

      try {
        setIsLoading(true);
        await audioRef.current.play();
        setIsPlaying(true);
      } catch (err) {
        console.warn('Audio play prevented:', err);
      } finally {
        setIsLoading(false);
      }
    }
  };

  // TTS playback ticker
  useEffect(() => {
    let ticker: any = null;
    if (isTts && isPlaying) {
      ticker = setInterval(() => {
        setCurrentTime((prev) => {
          if (duration > 0 && prev >= duration) {
            return prev;
          }
          const next = prev + 0.25;
          onTimeUpdate?.(next);
          return next;
        });
      }, 250);
    }
    return () => {
      if (ticker) clearInterval(ticker);
    };
  }, [isTts, isPlaying, duration, onTimeUpdate]);

  // When playback starts from beginning, count as a play
  const handlePlayStarted = () => {
    if (currentTime < 1 && playedCount === 0) {
      const nextCount = playedCount + 1;
      setPlayedCount(nextCount);
      const nextRemaining = configuredLimit !== null ? Math.max(0, configuredLimit - nextCount) : null;
      onPlayCountChange?.(nextRemaining, nextCount);
    }
    setIsPlaying(true);
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      const cur = audioRef.current.currentTime;
      setCurrentTime(cur);
      onTimeUpdate?.(cur);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      const dur = audioRef.current.duration;
      if (!isNaN(dur) && dur > 0) {
        setDuration(dur);
      }
      if (initialCurrentTime && initialCurrentTime > 0 && initialCurrentTime < (dur || Infinity)) {
        try {
          audioRef.current.currentTime = initialCurrentTime;
        } catch {}
      }
    }
  };

  const handleEnded = () => {
    setIsPlaying(false);
    setCurrentTime(0);
    onTimeUpdate?.(0);
    if (isTts) stopTtsSpeech();
  };

  const handleError = () => {
    setIsLoading(false);
    setIsPlaying(false);
  };

  // Reset player state ONLY when audioUrl changes (preserves playback across related questions sharing same URL)
  const prevAudioUrlRef = useRef(audioUrl);
  useEffect(() => {
    if (prevAudioUrlRef.current !== audioUrl) {
      prevAudioUrlRef.current = audioUrl;
      setIsPlaying(false);
      const initTime = initialCurrentTime || 0;
      setCurrentTime(initTime);
      setDuration(metadata?.duration || 0);
      setPlayedCount(initialPlayedCount || 0);
      if (isTts) stopTtsSpeech();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = initTime;
      }
    }
  }, [audioUrl, metadata?.duration, isTts, initialCurrentTime, initialPlayedCount]);

  // Cleanup speech synthesis on unmount
  useEffect(() => {
    return () => {
      stopTtsSpeech();
    };
  }, []);

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (shouldDisableSeeking) return;
    const time = Number(e.target.value);
    setCurrentTime(time);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
    }
  };

  const handleCycleSpeed = () => {
    if (shouldDisableSpeed) return;
    const speeds = [1.0, 1.25, 1.5, 0.75];
    const nextIdx = (speeds.indexOf(playbackRate) + 1) % speeds.length;
    const nextSpeed = speeds[nextIdx];
    setPlaybackRate(nextSpeed);
    if (audioRef.current) {
      audioRef.current.playbackRate = nextSpeed;
    }
  };

  const handleToggleMute = () => {
    if (audioRef.current) {
      const nextMuted = !isMuted;
      setIsMuted(nextMuted);
      audioRef.current.muted = nextMuted;
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    setVolume(val);
    setIsMuted(val === 0);
    if (audioRef.current) {
      audioRef.current.volume = val;
      audioRef.current.muted = val === 0;
    }
  };

  // Auto-play support
  useEffect(() => {
    if (autoPlay && audioRef.current && !isLimitReached) {
      audioRef.current.play().catch(() => {});
    }
  }, [autoPlay, isLimitReached]);

  // Clean progress percent
  const progressPercent = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  if (compact) {
    return (
      <div className={`eap-compact-root ${className}`}>
        {!isTts && (
          <audio
            ref={audioRef}
            src={audioUrl}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onPlay={handlePlayStarted}
            onEnded={handleEnded}
            onError={handleError}
            preload="metadata"
          />
        )}
        <button
          type="button"
          className={`eap-compact-play-btn ${isPlaying ? 'eap-btn--playing' : ''} ${isLimitReached ? 'eap-btn--disabled' : ''}`}
          onClick={handleTogglePlay}
          disabled={isLimitReached && !isPlaying}
          title={isLimitReached ? 'Playback limit reached' : isPlaying ? 'Pause audio' : 'Play audio'}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
        <div className="eap-compact-info">
          <span className="eap-compact-title">{displayTitle}</span>
          <span className="eap-compact-time">
            {formatAudioDuration(currentTime)} / {formatAudioDuration(duration)}
          </span>
        </div>
        {configuredLimit !== null && (
          <span className={`eap-limit-badge ${isLimitReached ? 'eap-limit-badge--exhausted' : ''}`}>
            {isLimitReached ? '🔒 Limit reached' : `🎧 ${remainingPlays} play${remainingPlays !== 1 ? 's' : ''} left`}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className={`eap-player-card animate-fade-in ${className} ${isPlaying ? 'eap-player-card--active' : ''} ${isIeltsMode ? 'eap-player-card--ielts' : ''}`}
    >
      {!isTts && (
        <audio
          ref={audioRef}
          src={audioUrl}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onPlay={handlePlayStarted}
          onEnded={handleEnded}
          onError={handleError}
          preload="metadata"
        />
      )}

      {/* Top Header Bar */}
      <div className="eap-header">
        <div className="eap-header-left">
          <div className="eap-audio-icon-wrap">
            <span className="eap-icon">🎧</span>
            {isPlaying && (
              <span className="eap-wave-bars">
                <span className="eap-bar eap-bar-1" />
                <span className="eap-bar eap-bar-2" />
                <span className="eap-bar eap-bar-3" />
                <span className="eap-bar eap-bar-4" />
              </span>
            )}
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h4 className="eap-title">{displayTitle}</h4>
              {questionRangeLabel && (
                <span className="eap-range-badge">
                  {questionRangeLabel}
                </span>
              )}
            </div>
            <div className="eap-sub">
              <span>{isIeltsMode ? 'Official Listening Track' : 'English Listening Track'}</span>
              {metadata?.voice && <span>• Voice: {metadata.voice}</span>}
              {shouldDisableSeeking && <span style={{ color: '#f59e0b', fontWeight: 600 }}>• 🔒 Real-time Playback (No Rewind)</span>}
            </div>
          </div>
        </div>

        <div className="eap-header-right">
          {configuredLimit !== null && configuredLimit > 0 ? (
            <div className={`eap-limit-pill ${isLimitReached ? 'eap-limit-pill--exhausted' : ''}`}>
              <span className="eap-limit-icon">{isLimitReached ? '🔒' : '⏱️'}</span>
              <span>
                {isLimitReached
                  ? 'Limit Reached (0 plays left)'
                  : `${remainingPlays} of ${configuredLimit} play${configuredLimit !== 1 ? 's' : ''} remaining`}
              </span>
            </div>
          ) : (
            <div className="eap-limit-pill eap-limit-pill--unlimited">
              <span>{isIeltsMode ? '🎧 Official Track' : '♾️ Unlimited Practice'}</span>
            </div>
          )}
        </div>
      </div>

      {/* Main Controls Row */}
      <div className="eap-controls-row">
        {/* Play/Pause Main Button */}
        <button
          type="button"
          className={`eap-main-play-btn ${isPlaying ? 'eap-main-play-btn--playing' : ''} ${isLimitReached && !isPlaying ? 'eap-main-play-btn--disabled' : ''}`}
          onClick={handleTogglePlay}
          disabled={isLimitReached && !isPlaying}
          title={isLimitReached ? 'Listening limit reached' : isPlaying ? 'Pause Audio' : 'Play Audio'}
        >
          {isLoading ? (
            <span className="eap-spinner" />
          ) : isPlaying ? (
            <span className="eap-play-icon">⏸</span>
          ) : (
            <span className="eap-play-icon">▶</span>
          )}
        </button>

        {/* Timeline (Readonly in IELTS Mode or interactive scrubber in standard mode) */}
        <div className="eap-scrubber-group">
          <div className="eap-time-row">
            <div className="eap-track-scope-label">
              <span className="eap-scope-icon">🎧</span>
              <span className="eap-scope-text">
                <strong>Listening Comprehension Question</strong>
                {questionRangeLabel ? ` (${questionRangeLabel})` : ''}
              </span>
            </div>
            <div className="eap-time-display">
              <span className="eap-time-current">{formatAudioDuration(currentTime)}</span>
              <span className="eap-time-divider">/</span>
              <span className="eap-time-total">{formatAudioDuration(duration)}</span>
            </div>
          </div>

          <div className="eap-slider-wrap">
            {shouldDisableSeeking ? (
              <div
                className="eap-readonly-progress"
                title="Rewind & seeking are disabled in exam mode"
              >
                <div
                  className="eap-progress-fill"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            ) : (
              <input
                type="range"
                min={0}
                max={duration || 100}
                step={0.1}
                value={currentTime}
                onChange={handleSeek}
                className="eap-scrubber-range"
                style={{
                  background: `linear-gradient(to right, var(--color-primary-500, #6366f1) ${progressPercent}%, var(--color-border, #334155) ${progressPercent}%)`,
                }}
                disabled={duration === 0}
              />
            )}
          </div>
        </div>

        {/* Tools Group: Volume and optional Speed */}
        <div className="eap-tools-group">
          {!shouldDisableSpeed && (
            <button
              type="button"
              className="eap-tool-btn eap-speed-btn"
              onClick={handleCycleSpeed}
              title="Cycle playback speed"
            >
              {playbackRate}x
            </button>
          )}

          {/* Volume Control */}
          <div className="eap-vol-wrap">
            <button
              type="button"
              className="eap-tool-btn eap-vol-btn"
              onClick={handleToggleMute}
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={isMuted ? 0 : volume}
              onChange={handleVolumeChange}
              className="eap-vol-slider"
              title="Volume"
            />
          </div>
        </div>
      </div>

      {/* Transcript Accordion (Optional for Teacher / Practice mode) */}
      {allowTranscript && metadata?.transcript && (
        <div className="eap-transcript-section">
          <button
            type="button"
            className="eap-transcript-toggle-btn"
            onClick={() => setShowTranscript((prev) => !prev)}
          >
            <span>📜 {showTranscript ? 'Hide Audio Transcript' : 'View Audio Transcript'}</span>
            <span className="eap-chevron">{showTranscript ? '▲' : '▼'}</span>
          </button>

          {showTranscript && (
            <div className="eap-transcript-box animate-fade-in">
              <p className="eap-transcript-text">{metadata.transcript}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

