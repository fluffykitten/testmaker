import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Question } from '../types/database';
import type { ExamHeaderConfig } from '../services/testBuilderService';
import { resolveStudentQuiz, type StudentQuizData } from '../services/quizCodeService';
import {
  joinGameSession,
  sendPlayerAnswer,
  sendPlayerLeave,
  destroySession,
} from '../services/gameRealtimeService';
import {
  calculatePoints,
  getStarRating,
  generateNickname,
  getFiftyFiftyIndices,
} from '../services/gameScoreEngine';
import {
  flattenQuizQuestionsForGame,
  evaluateGameAnswer,
  type GamePlayableItem,
} from '../services/gameQuestionAdapter';
import { resolveMcqCorrectOptionIndex } from '../services/deterministicGradingService';
import {
  playCorrectSound,
  playWrongSound,
  playFunnyWrong,
  playStreakSound,
  playAirhorn,
  playPowerUpActivate,
  playVictoryFanfare,
  playClickSound,
  toggleMute,
  getIsMuted,
} from '../lib/gameSoundEngine';
import { getReactionForAnswer, getStarLabel } from '../lib/gameMemes';
import {
  AVATAR_EMOJIS,
  type GameConfig,
  type LeaderboardEntry,
  type PowerUpType,
  type RTGameStartMessage,
  type RTQuestionStartMessage,
  type RTAnswerRevealMessage,
  type RTLeaderboardMessage,
  type RTGameEndMessage,
} from '../types/gameTypes';
import { ExamMathText } from '../components/ExamMathText';
import './GameQuizRunner.css';

interface GameQuizRunnerProps {
  testIdOrCode?: string;
  initialQuestions?: Question[];
  initialHeaderConfig?: ExamHeaderConfig;
  initialGameConfig?: Partial<GameConfig>;
  onExit?: () => void;
}

type PlayerPhase =
  | 'join'
  | 'waiting_host'
  | 'answering'
  | 'answer_locked'
  | 'feedback'
  | 'leaderboard'
  | 'final_results';

interface QuestionResultRecord {
  questionIndex: number;
  questionText: string;
  title?: string;
  selectedOption: number | string;
  correctOption: number | string;
  isCorrect: boolean;
  pointsEarned: number;
}

interface ActiveQuestionDisplay {
  questionIndex: number;
  totalQuestions: number;
  title?: string;
  contextStem?: string;
  questionText: string;
  questionType?: 'mcq' | 'structured';
  options: string[];
  imageUrl?: string;
  hasImage?: boolean;
  correctAnswerText?: string;
}

const QUICK_CHEM_SYMBOLS = [
  '→', '⇌', 'Δ', '°C', 'mol/dm³', 'g/cm³', 'kJ/mol', '(s)', '(l)', '(g)', '(aq)', '⁺', '⁻', '²', '³', '⁴'
];

export function GameQuizRunner({
  testIdOrCode,
  initialQuestions,
  initialHeaderConfig,
  initialGameConfig,
  onExit,
}: GameQuizRunnerProps) {
  // Test / Quiz Metadata
  const [loading, setLoading] = useState(!initialQuestions);
  const [error, setError] = useState<string | null>(null);
  const [isQuizPaused, setIsQuizPaused] = useState<boolean>(false);
  const [title, setTitle] = useState(initialHeaderConfig?.title || 'Interactive Game');
  const [questions, setQuestions] = useState<Question[]>(initialQuestions || []);


  // Session Persistence Key (per quiz code)
  const sessionKey = `gq_sess_${testIdOrCode || 'solo'}`;
  const getSavedSession = () => {
    try {
      const raw = sessionStorage.getItem(sessionKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  const savedSess = useRef(getSavedSession()).current;

  // Player Profile
  const [playerId] = useState(() => savedSess?.playerId || `player_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`);
  const [nickname, setNickname] = useState(() => savedSess?.nickname || generateNickname());
  const [avatarEmoji, setAvatarEmoji] = useState(() => savedSess?.avatarEmoji || AVATAR_EMOJIS[Math.floor(Math.random() * AVATAR_EMOJIS.length)]);

  // Game Engine State
  const [phase, setPhase] = useState<PlayerPhase>('join');
  const [isLiveMultiplayer, setIsLiveMultiplayer] = useState<boolean>(() => savedSess?.isLiveMultiplayer || false);
  const [currentQIndex, setCurrentQIndex] = useState<number>(0);
  const [activeDisplayQuestion, setActiveDisplayQuestion] = useState<ActiveQuestionDisplay | null>(null);
  const [typedAnswer, setTypedAnswer] = useState<string>('');
  const [score, setScore] = useState<number>(() => savedSess?.score || 0);
  const [streak, setStreak] = useState<number>(() => savedSess?.streak || 0);
  const [longestStreak, setLongestStreak] = useState<number>(() => savedSess?.longestStreak || 0);
  const [timeLeft, setTimeLeft] = useState<number>(20);
  const [totalTimeForQ, setTotalTimeForQ] = useState<number>(20);
  const [selectedOption, setSelectedOption] = useState<number | string | null>(null);
  const [hiddenOptions, setHiddenOptions] = useState<number[]>([]);
  const [isFrozen, setIsFrozen] = useState<boolean>(false);
  const [isDoublePointsActive, setIsDoublePointsActive] = useState<boolean>(false);
  const [muted, setMuted] = useState<boolean>(getIsMuted());

  // Power-Ups (1 of each per game)
  const [usedFiftyFifty, setUsedFiftyFifty] = useState<boolean>(() => savedSess?.usedFiftyFifty || false);
  const [usedFreeze, setUsedFreeze] = useState<boolean>(() => savedSess?.usedFreeze || false);
  const [usedDouble, setUsedDouble] = useState<boolean>(() => savedSess?.usedDouble || false);

  // Feedback State
  const [lastFeedback, setLastFeedback] = useState<{
    isCorrect: boolean;
    correctDisplay: string;
    pointsEarned: number;
    reaction: { emoji: string; message: string };
  } | null>(null);

  // Results & Leaderboard
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [myRank, setMyRank] = useState<number>(1);
  const [history, setHistory] = useState<QuestionResultRecord[]>(() => savedSess?.history || []);
  const [showReview, setShowReview] = useState<boolean>(false);

  // Config
  const [gameConfig, setGameConfig] = useState<GameConfig>({
    quizMode: 'game',
    enablePowerUps: initialGameConfig?.enablePowerUps ?? true,
    enableStreaks: initialGameConfig?.enableStreaks ?? true,
    enableFunSounds: initialGameConfig?.enableFunSounds ?? true,
    enableMemes: initialGameConfig?.enableMemes ?? true,
    pointsPerQuestion: initialGameConfig?.pointsPerQuestion ?? 1000,
    questionTimerSeconds: initialGameConfig?.questionTimerSeconds ?? 20,
    shuffleQuestions: initialGameConfig?.shuffleQuestions ?? true,
    shuffleOptions: initialGameConfig?.shuffleOptions ?? true,
  });

  // Flatten questions into structured/MCQ game rounds (structured questions never shuffled out of sequence)
  const playableItems: GamePlayableItem[] = useMemo(() => {
    return flattenQuizQuestionsForGame(questions, {
      shuffleQuestions: gameConfig.shuffleQuestions ?? false,
      shuffleOptions: gameConfig.shuffleOptions ?? false,
    });
  }, [questions, gameConfig.shuffleQuestions, gameConfig.shuffleOptions]);

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const questionStartTimeRef = useRef<number>(0);

  // Current Question Object
  const currentQ = questions[currentQIndex];

  // Helper to extract correct option index
  const getCorrectOptionIndex = useCallback((q: Question): number => {
    return resolveMcqCorrectOptionIndex(q);
  }, []);

  // ─── 1. Load Quiz Data ──────────────────────────────────────────────────────
  useEffect(() => {
    if (initialQuestions && initialQuestions.length > 0) {
      const mcqs = initialQuestions.filter((q) => q.options && q.options.length >= 2);
      setQuestions(mcqs.length > 0 ? mcqs : initialQuestions);
      setLoading(false);
      return;
    }

    if (!testIdOrCode) {
      setError('No quiz code provided.');
      setLoading(false);
      return;
    }

    async function load() {
      setLoading(true);
      try {
        const data: StudentQuizData | null = await resolveStudentQuiz(testIdOrCode!);
        if (!data || data.questions.length === 0) {
          setError(`Quiz "${testIdOrCode}" not found.`);
        } else if (data.isActive === false) {
          setIsQuizPaused(true);
          setTitle(data.title);
        } else {
          setIsQuizPaused(false);
          setTitle(data.title);
          setQuestions(data.questions);
          if (data.pointsPerQuestion || data.questionTimerSeconds) {
            setGameConfig((prev) => ({
              ...prev,
              pointsPerQuestion: data.pointsPerQuestion ?? prev.pointsPerQuestion,
              questionTimerSeconds: data.questionTimerSeconds ?? prev.questionTimerSeconds,
              enablePowerUps: data.enablePowerUps ?? prev.enablePowerUps,
              enableStreaks: data.enableStreaks ?? prev.enableStreaks,
              enableFunSounds: data.enableFunSounds ?? prev.enableFunSounds,
              enableMemes: data.enableMemes ?? prev.enableMemes,
            }));
          }
        }
      } catch (err: any) {
        setError(`Failed to load quiz: ${err?.message || 'Network error'}`);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [testIdOrCode, initialQuestions]);

  // ─── 2. Join Flow (Multiplayer or Solo) ──────────────────────────────────────
  const handleJoinGame = (mode: 'multiplayer' | 'solo') => {
    playClickSound();
    if (!nickname.trim()) return;

    if (mode === 'multiplayer' && testIdOrCode) {
      setIsLiveMultiplayer(true);
      setPhase('waiting_host');

      // Connect to Realtime Broadcast Channel
      joinGameSession(testIdOrCode, playerId, nickname, avatarEmoji, {
        onGameStart: (msg: RTGameStartMessage) => {
          setGameConfig(msg.config);
          setPhase('answering');
        },
        onQuestionStart: (msg: RTQuestionStartMessage) => {
          setCurrentQIndex(msg.questionIndex);
          setTypedAnswer('');
          setActiveDisplayQuestion({
            questionIndex: msg.questionIndex,
            totalQuestions: msg.totalQuestions,
            title: msg.title,
            contextStem: msg.contextStem,
            questionText: msg.questionText,
            questionType: msg.questionType || (msg.options && msg.options.length >= 2 ? 'mcq' : 'structured'),
            options: msg.options || [],
            imageUrl: msg.imageUrl,
            hasImage: msg.hasImage,
          });
          const sec = Math.max(1, Math.round(msg.timerMs / 1000));
          setTimeLeft(sec);
          setTotalTimeForQ(sec);
          setSelectedOption(null);
          setHiddenOptions([]);
          setIsFrozen(false);
          setIsDoublePointsActive(false);
          setPhase('answering');
          questionStartTimeRef.current = Date.now();

          // Start the countdown timer for the player
          if (timerRef.current) clearInterval(timerRef.current);
          timerRef.current = setInterval(() => {
            setTimeLeft((prev) => {
              if (prev <= 1) {
                if (timerRef.current) clearInterval(timerRef.current);
                return 0;
              }
              return prev - 1;
            });
          }, 1000);
        },
        onAnswerCount: () => {},
        onAnswerReveal: (msg: RTAnswerRevealMessage) => {
          if (timerRef.current) clearInterval(timerRef.current);
          const myResult = msg.playerResults[playerId];
          if (myResult) {
            setScore(myResult.newScore);
            setStreak(myResult.newStreak);
            setLongestStreak((prev) => Math.max(prev, myResult.newStreak));
            setLastFeedback({
              isCorrect: myResult.isCorrect,
              correctDisplay: msg.correctAnswerText || (msg.correctOptionIndex !== undefined ? String.fromCharCode(65 + msg.correctOptionIndex) : ''),
              pointsEarned: myResult.pointsEarned,
              reaction: myResult.reaction,
            });

            if (myResult.isCorrect) {
              playCorrectSound();
              if (myResult.newStreak >= 5) playAirhorn();
              else if (myResult.newStreak >= 3) playStreakSound(myResult.newStreak);
            } else {
              playWrongSound();
              if (Math.random() > 0.6) playFunnyWrong();
            }
          }
          setPhase('feedback');
        },
        onLeaderboardUpdate: (msg: RTLeaderboardMessage) => {
          if (timerRef.current) clearInterval(timerRef.current);
          setLeaderboard(msg.entries);
          const myEntry = msg.entries.find((e) => e.playerId === playerId);
          if (myEntry) setMyRank(myEntry.rank);
          setPhase('leaderboard');
        },
        onGameEnd: (msg: RTGameEndMessage) => {
          if (timerRef.current) clearInterval(timerRef.current);
          setLeaderboard(msg.finalLeaderboard);
          const myEntry = msg.finalLeaderboard.find((e) => e.playerId === playerId);
          if (myEntry) setMyRank(myEntry.rank);
          setPhase('final_results');
          playVictoryFanfare();
        },
      });
    } else {
      // Solo Game Mode
      setIsLiveMultiplayer(false);
      startSoloQuestion(0);
    }
  };

  // ─── 3. Solo Game Loop ──────────────────────────────────────────────────────
  const startSoloQuestion = (qIdx: number) => {
    const item = playableItems[qIdx];
    setCurrentQIndex(qIdx);
    setTypedAnswer('');
    if (item) {
      setActiveDisplayQuestion({
        questionIndex: qIdx,
        totalQuestions: playableItems.length,
        title: item.title,
        contextStem: item.contextStem,
        questionText: item.questionText,
        questionType: item.type,
        options: item.options || [],
        imageUrl: item.diagramUrl || undefined,
        hasImage: !!item.diagramUrl,
        correctAnswerText: item.correctAnswerText,
      });
    }
    setTimeLeft(gameConfig.questionTimerSeconds);
    setTotalTimeForQ(gameConfig.questionTimerSeconds);
    setSelectedOption(null);
    setHiddenOptions([]);
    setIsFrozen(false);
    setIsDoublePointsActive(false);
    setPhase('answering');
    questionStartTimeRef.current = Date.now();

    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          handleSoloSubmit(''); // Timeout
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleSoloSubmit = (answer: number | string) => {
    if (timerRef.current) clearInterval(timerRef.current);
    setSelectedOption(answer);
    setPhase('feedback');

    const item = playableItems[currentQIndex];
    const evalRes = item ? evaluateGameAnswer(item, answer) : { isCorrect: false, correctDisplay: '' };
    const isCorrect = evalRes.isCorrect;
    const totalTimeMs = gameConfig.questionTimerSeconds * 1000;
    const elapsedMs = Date.now() - questionStartTimeRef.current;
    const timeLeftMs = Math.max(0, totalTimeMs - elapsedMs);

    let pointsEarned = 0;
    const newStreak = isCorrect ? streak + 1 : 0;

    if (isCorrect) {
      const calc = calculatePoints(
        timeLeftMs,
        totalTimeMs,
        gameConfig.pointsPerQuestion,
        newStreak,
        isDoublePointsActive
      );
      pointsEarned = calc.total;
      setScore((s) => s + pointsEarned);
      setStreak(newStreak);
      setLongestStreak((ls) => Math.max(ls, newStreak));

      playCorrectSound();
      if (newStreak >= 5) playAirhorn();
      else if (newStreak >= 3) playStreakSound(newStreak);
    } else {
      setStreak(0);
      playWrongSound();
      if (Math.random() > 0.6) playFunnyWrong();
    }

    const timeLeftPercent = totalTimeMs > 0 ? (timeLeftMs / totalTimeMs) * 100 : 0;
    const reaction = getReactionForAnswer(isCorrect, newStreak, answer === '' || answer === -1 ? -1 : timeLeftPercent);

    setLastFeedback({
      isCorrect,
      correctDisplay: evalRes.correctDisplay,
      pointsEarned,
      reaction,
    });

    setHistory((prev) => [
      ...prev,
      {
        questionIndex: currentQIndex,
        title: item?.title,
        questionText: item ? item.questionText : '',
        selectedOption: answer,
        correctOption: evalRes.correctDisplay,
        isCorrect,
        pointsEarned,
      },
    ]);
  };

  const handleNextSoloQuestion = () => {
    playClickSound();
    if (currentQIndex + 1 < playableItems.length) {
      startSoloQuestion(currentQIndex + 1);
    } else {
      setPhase('final_results');
      playVictoryFanfare();
    }
  };

  // ─── 4. Player Submits Answer (MCQ click or Structured text) ────────────────
  const handleSelectAnswer = (answer: number | string) => {
    if (phase !== 'answering') return;
    playClickSound();
    setSelectedOption(answer);

    if (isLiveMultiplayer && testIdOrCode) {
      setPhase('answer_locked');
      if (timerRef.current) clearInterval(timerRef.current);
      const totalTimeMs = totalTimeForQ * 1000;
      const elapsedMs = Date.now() - questionStartTimeRef.current;
      const timeLeftMs = Math.max(0, totalTimeMs - elapsedMs);
      sendPlayerAnswer(playerId, nickname, currentQIndex, answer, timeLeftMs);
    } else {
      handleSoloSubmit(answer);
    }
  };

  const handleInsertSymbol = (sym: string) => {
    setTypedAnswer((prev) => prev + sym);
  };

  // ─── 5. Power-Up Activations ────────────────────────────────────────────────
  const handleUsePowerUp = (type: PowerUpType) => {
    if (phase !== 'answering') return;
    playPowerUpActivate();

    if (type === 'fifty_fifty' && !usedFiftyFifty && activeDisplayQuestion) {
      setUsedFiftyFifty(true);
      let correctIdx = 0;
      const currentItem = playableItems[currentQIndex];
      if (currentItem && currentItem.correctOptionIndex !== undefined) {
        correctIdx = currentItem.correctOptionIndex;
      } else if (!isLiveMultiplayer && currentQ) {
        correctIdx = getCorrectOptionIndex(currentQ);
      } else {
        const matched = questions.find((q) => q.question_text === activeDisplayQuestion.questionText);
        if (matched) correctIdx = getCorrectOptionIndex(matched);
      }
      const totalOpts = activeDisplayQuestion.options?.length || 4;
      const toHide = getFiftyFiftyIndices(correctIdx, totalOpts);
      setHiddenOptions(toHide);
    } else if (type === 'time_freeze' && !usedFreeze) {
      setUsedFreeze(true);
      setIsFrozen(true);
      if (timerRef.current) clearInterval(timerRef.current);
      setTimeout(() => {
        setIsFrozen(false);
        // Resume timer
        if (phase === 'answering') {
          timerRef.current = setInterval(() => {
            setTimeLeft((prev) => {
              if (prev <= 1) {
                if (timerRef.current) clearInterval(timerRef.current);
                if (!isLiveMultiplayer) handleSoloSubmit(-1);
                return 0;
              }
              return prev - 1;
            });
          }, 1000);
        }
      }, 5000);
    } else if (type === 'double_points' && !usedDouble) {
      setUsedDouble(true);
      setIsDoublePointsActive(true);
    }
  };

  // Auto-persist player game session across page refreshes
  useEffect(() => {
    if (phase !== 'join') {
      try {
        sessionStorage.setItem(
          sessionKey,
          JSON.stringify({
            playerId,
            nickname,
            avatarEmoji,
            score,
            streak,
            longestStreak,
            usedFiftyFifty,
            usedFreeze,
            usedDouble,
            history,
            isLiveMultiplayer,
          })
        );
      } catch (e) {
        console.warn('Session save error:', e);
      }
    }
  }, [
    sessionKey,
    phase,
    playerId,
    nickname,
    avatarEmoji,
    score,
    streak,
    longestStreak,
    usedFiftyFifty,
    usedFreeze,
    usedDouble,
    history,
    isLiveMultiplayer,
  ]);

  // Auto-reconnect if session was active prior to refresh
  useEffect(() => {
    if (savedSess?.isLiveMultiplayer && testIdOrCode && !loading) {
      handleJoinGame('multiplayer');
    }
  }, [loading]);

  const handleToggleAudio = () => {
    const isM = toggleMute();
    setMuted(isM);
  };

  const handleLeave = () => {
    if (isLiveMultiplayer) sendPlayerLeave(playerId);
    destroySession();
    if (timerRef.current) clearInterval(timerRef.current);
    try {
      sessionStorage.removeItem(sessionKey);
    } catch {}
    if (onExit) onExit();
  };

  // Accuracy calculation
  const correctCount = history.filter((h) => h.isCorrect).length;
  const totalQuestionsCount = activeDisplayQuestion?.totalQuestions || questions.length || 1;
  const accuracyPercent = (correctCount / totalQuestionsCount) * 100;
  const starRating = getStarRating(accuracyPercent);

  // ─── Loading / Error Views ──────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="gq-root gq-centered">
        <div className="gq-loading-spinner" />
        <h2>Joining Quiz Arena...</h2>
      </div>
    );
  }

  if (isQuizPaused) {
    return (
      <div className="gq-root gq-centered animate-fade-in">
        <div className="gq-error-card animate-scale-up">
          <span className="gq-error-icon" style={{ fontSize: '3rem' }}>⏸️</span>
          <h2>Game Arena Paused</h2>
          <p style={{ maxWidth: '420px', margin: '8px auto 16px', lineHeight: 1.5 }}>
            The host has paused access to <strong>{title || testIdOrCode}</strong>. Submissions are temporarily closed. Please wait for the teacher to activate the challenge.
          </p>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
            <button
              type="button"
              className="gq-btn-primary"
              onClick={async () => {
                setLoading(true);
                try {
                  const refreshed = await resolveStudentQuiz(testIdOrCode!);
                  if (refreshed && refreshed.isActive !== false) {
                    setIsQuizPaused(false);
                    setQuestions(refreshed.questions);
                  }
                } catch (err) {
                  console.warn('Check game status error:', err);
                } finally {
                  setLoading(false);
                }
              }}
            >
              ↻ Check Status
            </button>
            <button type="button" className="gq-btn-leave" onClick={handleLeave} style={{ padding: '10px 18px', borderRadius: '8px' }}>
              Back to Portal
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="gq-root gq-centered">
        <div className="gq-error-card animate-scale-up">
          <span className="gq-error-icon">⚠️</span>
          <h2>Unable to Join Game</h2>
          <p>{error}</p>
          <button type="button" className="gq-btn-primary" onClick={handleLeave}>
            Back to Portal
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="gq-root animate-fade-in">
      {/* ─── Topbar HUD ──────────────────────────────────────────────────────── */}
      <header className="gq-topbar">
        <div className="gq-topbar-profile">
          <span className="gq-player-avatar">{avatarEmoji}</span>
          <div className="gq-player-info">
            <strong className="gq-player-name">{nickname}</strong>
            <span className="gq-quiz-title-tag">{title}</span>
          </div>
        </div>

        {phase !== 'join' && phase !== 'waiting_host' && (
          <div className="gq-topbar-score-hud">
            {streak >= 2 && (
              <div className="gq-streak-badge animate-bounce-in">
                🔥 {streak} Streak!
              </div>
            )}
            <div className="gq-score-counter">
              <span className="gq-score-lbl">SCORE:</span>
              <strong className="gq-score-val">{score.toLocaleString()}</strong>
            </div>
          </div>
        )}

        <div className="gq-topbar-actions">
          <button
            type="button"
            className="gq-btn-icon"
            onClick={handleToggleAudio}
            title={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? '🔇' : '🔊'}
          </button>
          <button type="button" className="gq-btn-leave" onClick={handleLeave}>
            ✕ Exit
          </button>
        </div>
      </header>

      {/* ═════════════════════════════════════════════════════════════════════════
          PHASE 1: JOIN / PROFILE SETUP SCREEN
      ══════════════════════════════════════════════════════════════════════════ */}
      {phase === 'join' && (
        <main className="gq-join-screen animate-scale-up">
          <div className="gq-join-card">
            <div className="gq-join-brand">
              <span className="gq-brand-icon">🎮</span>
              <h1 className="gq-game-title">{title}</h1>
              <p className="gq-game-sub">{questions.length} MCQ Questions • Points & Streaks</p>
            </div>

            {/* Avatar Selector */}
            <div className="gq-avatar-section">
              <label className="gq-section-label">Choose Avatar:</label>
              <div className="gq-avatar-grid">
                {AVATAR_EMOJIS.slice(0, 14).map((emoji: string) => (
                  <button
                    key={emoji}
                    type="button"
                    className={`gq-avatar-btn ${avatarEmoji === emoji ? 'gq-avatar--selected' : ''}`}
                    onClick={() => {
                      playClickSound();
                      setAvatarEmoji(emoji);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>

            {/* Nickname Input */}
            <div className="gq-name-section">
              <label className="gq-section-label">Your Nickname:</label>
              <div className="gq-name-input-wrap">
                <input
                  type="text"
                  className="gq-name-input"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  maxLength={18}
                  placeholder="Enter fun nickname"
                />
                <button
                  type="button"
                  className="gq-btn-randomize"
                  onClick={() => {
                    playClickSound();
                    setNickname(generateNickname());
                  }}
                  title="Generate Random Nickname"
                >
                  🎲 Random
                </button>
              </div>
            </div>

            {/* Custom Question Timer Selector (for Solo Mode) */}
            <div className="gq-timer-select-section" style={{
              background: 'rgba(15, 23, 42, 0.65)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: '16px',
              padding: '12px 16px',
              margin: '12px 0',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              textAlign: 'left',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label className="gq-section-label" style={{ margin: 0 }}>
                  ⏱️ Timer Per Question: <strong style={{ color: '#c084fc' }}>{gameConfig.questionTimerSeconds}s</strong>
                </label>
                <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Solo mode speed</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                {[15, 20, 30, 45, 60, 90, 120].map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    style={{
                      background: gameConfig.questionTimerSeconds === sec ? '#8b5cf6' : 'rgba(255, 255, 255, 0.08)',
                      color: '#ffffff',
                      border: gameConfig.questionTimerSeconds === sec ? '1px solid #c084fc' : '1px solid rgba(255, 255, 255, 0.15)',
                      borderRadius: '8px',
                      padding: '4px 10px',
                      fontWeight: 700,
                      fontSize: '0.85rem',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                    onClick={() => {
                      playClickSound();
                      setGameConfig((prev) => ({ ...prev, questionTimerSeconds: sec }));
                      setTimeLeft(sec);
                      setTotalTimeForQ(sec);
                    }}
                  >
                    {sec}s
                  </button>
                ))}
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: 'auto' }}>
                  <span style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: 700 }}>Custom:</span>
                  <input
                    type="number"
                    min={5}
                    max={600}
                    value={gameConfig.questionTimerSeconds}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (!isNaN(v) && v > 0) {
                        setGameConfig((prev) => ({ ...prev, questionTimerSeconds: v }));
                        setTimeLeft(v);
                        setTotalTimeForQ(v);
                      }
                    }}
                    style={{
                      width: '55px',
                      background: 'rgba(0, 0, 0, 0.5)',
                      border: '1px solid rgba(255, 255, 255, 0.25)',
                      borderRadius: '6px',
                      color: '#ffffff',
                      padding: '3px 6px',
                      fontWeight: 700,
                      fontSize: '0.85rem',
                      textAlign: 'center',
                    }}
                  />
                  <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>s</span>
                </div>
              </div>
            </div>

            {/* Join Buttons */}
            <div className="gq-join-actions">
              {testIdOrCode && (
                <button
                  type="button"
                  className="gq-btn-join gq-btn-join--multi"
                  onClick={() => handleJoinGame('multiplayer')}
                >
                  🌐 Join Live Class Game
                </button>
              )}
              <button
                type="button"
                className="gq-btn-join gq-btn-join--solo"
                onClick={() => handleJoinGame('solo')}
              >
                🚀 Play Solo Challenge
              </button>
            </div>
          </div>
        </main>
      )}

      {/* ═════════════════════════════════════════════════════════════════════════
          PHASE 2: WAITING FOR HOST
      ══════════════════════════════════════════════════════════════════════════ */}
      {phase === 'waiting_host' && (
        <main className="gq-waiting-screen animate-fade-in">
          <div className="gq-waiting-card">
            <div className="gq-waiting-avatar animate-bounce">{avatarEmoji}</div>
            <h2>You're in, {nickname}!</h2>
            <p>Waiting for the teacher to start the game...</p>
            <div className="gq-pulse-waves">
              <div className="wave wave-1" />
              <div className="wave wave-2" />
              <div className="wave wave-3" />
            </div>
          </div>
        </main>
      )}

      {/* ═════════════════════════════════════════════════════════════════════════
          PHASE 3: ANSWERING / LOCKED
      ══════════════════════════════════════════════════════════════════════════ */}
      {(phase === 'answering' || phase === 'answer_locked') && activeDisplayQuestion && (
        <main className="gq-gameplay-screen animate-fade-in">
          {/* Top Info Bar */}
          <div className="gq-hud-bar">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="gq-q-tracker">
                {activeDisplayQuestion.title || `Q ${activeDisplayQuestion.questionIndex + 1}`} / {activeDisplayQuestion.totalQuestions}
              </span>
              <span style={{
                background: activeDisplayQuestion.questionType === 'mcq' ? 'rgba(59, 130, 246, 0.25)' : 'rgba(139, 92, 246, 0.25)',
                color: activeDisplayQuestion.questionType === 'mcq' ? '#60a5fa' : '#c084fc',
                fontSize: '0.75rem',
                fontWeight: 800,
                padding: '2px 8px',
                borderRadius: '6px',
                border: '1px solid rgba(255, 255, 255, 0.1)',
              }}>
                {activeDisplayQuestion.questionType === 'mcq' ? '🔘 MCQ' : '✏️ Chemistry / Math Sprint'}
              </span>
            </div>

            {/* Timer Ring / Bar */}
            <div className={`gq-timer-badge ${timeLeft <= 5 ? 'gq-timer--urgent' : ''} ${isFrozen ? 'gq-timer--frozen' : ''}`}>
              {isFrozen ? '❄️ FROZEN' : `⏱️ ${timeLeft}s`}
            </div>
          </div>

          {/* Animated Timer Progress Bar */}
          <div className="gq-progress-track">
            <div
              className="gq-progress-fill"
              style={{
                width: `${(timeLeft / totalTimeForQ) * 100}%`,
              }}
            />
          </div>

          {/* Question Card */}
          <div className="gq-q-card animate-scale-up">
            {activeDisplayQuestion.contextStem && (
              <div className="gq-context-stem-banner">
                <strong>Context:</strong> <ExamMathText content={activeDisplayQuestion.contextStem} />
              </div>
            )}

            <div className="gq-q-text">
              <ExamMathText content={activeDisplayQuestion.questionText} />
            </div>
            {activeDisplayQuestion.imageUrl && (
              <div className="gq-q-diagram">
                <img src={activeDisplayQuestion.imageUrl} alt="Exam Figure" />
              </div>
            )}
          </div>

          {/* ─── Type A: 4 Large Colored MCQ Option Buttons ─── */}
          {activeDisplayQuestion.questionType === 'mcq' ? (
            <div className="gq-answers-grid">
              {(activeDisplayQuestion.options || ['Option A', 'Option B', 'Option C', 'Option D']).map((opt, oIdx) => {
                const optionShapes = ['◆', '●', '▲', '■'];
                const optionColors = ['red', 'blue', 'green', 'yellow'];
                const isHidden = hiddenOptions.includes(oIdx);
                const isSelected = selectedOption === oIdx;

                if (isHidden) {
                  return (
                    <div key={oIdx} className="gq-answer-card gq-answer--hidden">
                      <span>50:50 Eliminated</span>
                    </div>
                  );
                }

                return (
                  <button
                    key={oIdx}
                    type="button"
                    className={`gq-answer-card gq-answer--${optionColors[oIdx % 4]} ${
                      isSelected ? 'gq-answer--selected' : ''
                    }`}
                    disabled={phase === 'answer_locked'}
                    onClick={() => handleSelectAnswer(oIdx)}
                  >
                    <span className="gq-answer-shape">{optionShapes[oIdx % 4]}</span>
                    <div className="gq-answer-text">
                      <ExamMathText content={opt} />
                    </div>
                    {isSelected && <span className="gq-locked-badge">LOCKED 🔒</span>}
                  </button>
                );
              })}
            </div>
          ) : (
            /* ─── Type B: Structured / Calculation Neon Type-In Sprint Box ─── */
            <div className="gq-structured-box animate-fly-up">
              {/* Quick Chemistry / Math Symbols Toolbar */}
              <div className="gq-sym-bar">
                <span className="gq-sym-label">Quick Insert:</span>
                {QUICK_CHEM_SYMBOLS.map((sym) => (
                  <button
                    key={sym}
                    type="button"
                    className="gq-sym-btn"
                    onClick={() => handleInsertSymbol(sym)}
                    disabled={phase === 'answer_locked'}
                  >
                    {sym}
                  </button>
                ))}
              </div>

              {/* Text Input Row */}
              <div className="gq-structured-input-row">
                <input
                  type="text"
                  className="gq-type-input"
                  placeholder="Type formula, calculation, or scientific term..."
                  value={typedAnswer}
                  onChange={(e) => setTypedAnswer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && typedAnswer.trim()) {
                      handleSelectAnswer(typedAnswer);
                    }
                  }}
                  autoFocus
                  disabled={phase === 'answer_locked'}
                />
                <button
                  type="button"
                  className="gq-btn-submit-type"
                  onClick={() => handleSelectAnswer(typedAnswer)}
                  disabled={phase === 'answer_locked' || !typedAnswer.trim()}
                >
                  {phase === 'answer_locked' ? '🔒 Locked' : '🚀 Submit'}
                </button>
              </div>

              {/* Live Formula / Math Preview */}
              {typedAnswer.trim() && (
                <div className="gq-math-preview">
                  <span className="gq-math-preview-label">Live Preview:</span>
                  <ExamMathText content={typedAnswer} />
                </div>
              )}
            </div>
          )}

          {/* Power-Ups Bar */}
          {gameConfig.enablePowerUps && phase === 'answering' && (
            <div className="gq-powerups-bar">
              {activeDisplayQuestion.questionType === 'mcq' && (
                <button
                  type="button"
                  className={`gq-powerup-btn ${usedFiftyFifty ? 'gq-powerup--used' : ''}`}
                  disabled={usedFiftyFifty}
                  onClick={() => handleUsePowerUp('fifty_fifty')}
                  title="Eliminate 2 wrong answers"
                >
                  <span className="gq-pu-icon">✂️</span>
                  <span className="gq-pu-label">50 / 50</span>
                </button>
              )}

              <button
                type="button"
                className={`gq-powerup-btn ${usedFreeze ? 'gq-powerup--used' : ''}`}
                disabled={usedFreeze}
                onClick={() => handleUsePowerUp('time_freeze')}
                title="Freeze timer for 5 seconds"
              >
                <span className="gq-pu-icon">❄️</span>
                <span className="gq-pu-label">Time Freeze</span>
              </button>

              <button
                type="button"
                className={`gq-powerup-btn ${usedDouble ? 'gq-powerup--used' : ''} ${
                  isDoublePointsActive ? 'gq-powerup--active' : ''
                }`}
                disabled={usedDouble}
                onClick={() => handleUsePowerUp('double_points')}
                title="Double points on this question"
              >
                <span className="gq-pu-icon">⚡</span>
                <span className="gq-pu-label">2× Points</span>
              </button>
            </div>
          )}
        </main>
      )}

      {/* ═════════════════════════════════════════════════════════════════════════
          PHASE 4: INSTANT FEEDBACK SCREEN
      ══════════════════════════════════════════════════════════════════════════ */}
      {phase === 'feedback' && lastFeedback && (
        <main
          className={`gq-feedback-screen ${
            lastFeedback.isCorrect ? 'gq-feedback--correct' : 'gq-feedback--incorrect'
          } animate-scale-up`}
        >
          <div className="gq-feedback-card">
            <div className="gq-feedback-emoji animate-bounce-in">
              {lastFeedback.reaction.emoji}
            </div>
            <h2 className="gq-feedback-heading">{lastFeedback.reaction.message}</h2>

            {lastFeedback.isCorrect ? (
              <div className="gq-points-splash animate-fly-up">
                +{lastFeedback.pointsEarned.toLocaleString()} PTS!
              </div>
            ) : (
              <div className="gq-feedback-correct-answer">
                <span>Correct Answer:</span>
                <strong>
                  <ExamMathText content={lastFeedback.correctDisplay} />
                </strong>
              </div>
            )}

            {!isLiveMultiplayer && (
              <button
                type="button"
                className="gq-btn-primary gq-btn-feedback-next"
                onClick={handleNextSoloQuestion}
              >
                Next Question →
              </button>
            )}

            {isLiveMultiplayer && (
              <p className="gq-waiting-next-txt">Waiting for teacher to advance...</p>
            )}
          </div>
        </main>
      )}

      {/* ═════════════════════════════════════════════════════════════════════════
          PHASE 5: MID-GAME LEADERBOARD
      ══════════════════════════════════════════════════════════════════════════ */}
      {phase === 'leaderboard' && (
        <main className="gq-leaderboard-screen animate-fade-in">
          <div className="gq-my-rank-banner">
            <span>You are currently ranked:</span>
            <strong className="gq-my-rank-num">#{myRank}</strong>
          </div>

          <div className="gq-lb-card">
            <h3 className="gq-lb-heading">Top Players</h3>
            <div className="gq-lb-rows">
              {leaderboard.slice(0, 5).map((e, idx) => (
                <div
                  key={e.playerId}
                  className={`gq-lb-row ${e.playerId === playerId ? 'gq-lb-row--me' : ''}`}
                >
                  <span className="gq-lb-rank">#{idx + 1}</span>
                  <span className="gq-lb-avatar">{e.avatarEmoji}</span>
                  <strong className="gq-lb-name">{e.nickname}</strong>
                  <span className="gq-lb-pts">{e.score.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
        </main>
      )}

      {/* ═════════════════════════════════════════════════════════════════════════
          PHASE 6: FINAL RESULTS & PODIUM
      ══════════════════════════════════════════════════════════════════════════ */}
      {phase === 'final_results' && (
        <main className="gq-results-screen animate-scale-up">
          <div className="gq-results-card">
            <div className="gq-stars-row">
              {[1, 2, 3, 4, 5].map((star) => (
                <span
                  key={star}
                  className={`gq-star ${star <= starRating ? 'gq-star--lit' : ''}`}
                >
                  ★
                </span>
              ))}
            </div>

            <h1 className="gq-results-title">{getStarLabel(starRating)}</h1>
            <p className="gq-results-player">{avatarEmoji} {nickname}</p>

            {/* KPI Cards Grid */}
            <div className="gq-kpi-grid">
              <div className="gq-kpi-card">
                <span className="gq-kpi-val">{score.toLocaleString()}</span>
                <span className="gq-kpi-lbl">Total Score</span>
              </div>
              <div className="gq-kpi-card">
                <span className="gq-kpi-val">{accuracyPercent.toFixed(0)}%</span>
                <span className="gq-kpi-lbl">Accuracy</span>
              </div>
              <div className="gq-kpi-card">
                <span className="gq-kpi-val">🔥 {longestStreak}</span>
                <span className="gq-kpi-lbl">Best Streak</span>
              </div>
              {isLiveMultiplayer && (
                <div className="gq-kpi-card">
                  <span className="gq-kpi-val">#{myRank}</span>
                  <span className="gq-kpi-lbl">Final Rank</span>
                </div>
              )}
            </div>

            {/* Question & Mark Scheme Review Toggle */}
            {history.length > 0 && (
              <div className="gq-review-section">
                <button
                  type="button"
                  className="gq-btn-review-toggle"
                  onClick={() => setShowReview(!showReview)}
                >
                  <span>{showReview ? '▲ Hide' : '📋 Review'} Questions & Mark Schemes ({history.length})</span>
                </button>

                {showReview && (
                  <div className="gq-review-list animate-fade-in">
                    {history.map((h, i) => (
                      <div
                        key={i}
                        className={`gq-review-item ${h.isCorrect ? 'gq-review-item--correct' : 'gq-review-item--incorrect'}`}
                      >
                        <div className="gq-review-header">
                          <span className="gq-review-qnum">
                            {h.title || `Question ${i + 1}`}
                          </span>
                          <span className={`gq-review-status ${h.isCorrect ? 'status-correct' : 'status-incorrect'}`}>
                            {h.isCorrect ? '✓ Correct' : '✗ Incorrect'}
                          </span>
                        </div>
                        <div className="gq-review-prompt">
                          <ExamMathText content={h.questionText} />
                        </div>
                        <div className="gq-review-details">
                          <div className="gq-review-row">
                            <span className="gq-review-lbl">Your Answer:</span>
                            <span className="gq-review-val">
                              {typeof h.selectedOption === 'number' && h.selectedOption >= 0
                                ? `Option ${String.fromCharCode(65 + h.selectedOption)}`
                                : h.selectedOption || '(None)'}
                            </span>
                          </div>
                          <div className="gq-review-row gq-review-row--scheme">
                            <span className="gq-review-lbl">Mark Scheme / Correct:</span>
                            <span className="gq-review-val gq-review-val--scheme">
                              <ExamMathText content={String(h.correctOption)} />
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="gq-results-actions">
              <button
                type="button"
                className="gq-btn-primary"
                onClick={() => {
                  setPhase('join');
                  setScore(0);
                  setStreak(0);
                  setHistory([]);
                  setUsedFiftyFifty(false);
                  setUsedFreeze(false);
                  setUsedDouble(false);
                }}
              >
                🔄 Play Again
              </button>
              <button type="button" className="gq-btn-secondary" onClick={handleLeave}>
                Exit to Portal
              </button>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
