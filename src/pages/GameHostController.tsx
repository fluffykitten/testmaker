import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Question } from '../types/database';
import type { PublishedQuiz } from '../services/quizManagerService';
import type {
  GameConfig,
  GamePlayer,
  LeaderboardEntry,
  PlayerAnswer,
  RTPlayerJoinMessage,
  RTPlayerLeaveMessage,
  RTPlayerAnswerMessage,
} from '../types/gameTypes';
import {
  createGameSession,
  broadcastGameStart,
  broadcastQuestionStart,
  broadcastAnswerCount,
  broadcastAnswerReveal,
  broadcastLeaderboard,
  broadcastGameEnd,
  destroySession,
} from '../services/gameRealtimeService';
import {
  processAnswer,
  buildLeaderboard,
} from '../services/gameScoreEngine';
import {
  flattenQuizQuestionsForGame,
  evaluateGameAnswer,
  type GamePlayableItem,
} from '../services/gameQuestionAdapter';
import {
  playPlayerJoinSound,
  playGameStartCountdown,
  playVictoryFanfare,
  playAirhorn,
  playClickSound,
  toggleMute,
  getIsMuted,
} from '../lib/gameSoundEngine';
import { ExamMathText } from '../components/ExamMathText';
import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import './GameHostController.css';

interface GameHostControllerProps {
  quiz: PublishedQuiz;
  questions: Question[];
  onExit: () => void;
}

type HostPhase = 'lobby' | 'countdown' | 'question' | 'feedback' | 'leaderboard' | 'final_results';

export function GameHostController({ quiz, questions: initialQuestions, onExit }: GameHostControllerProps) {
  // Flatten MCQs, structured questions, and sub-questions into unified game rounds
  const playableItems: GamePlayableItem[] = useMemo(() => {
    return flattenQuizQuestionsForGame(initialQuestions, {
      shuffleQuestions: quiz.shuffleQuestions ?? false,
    });
  }, [initialQuestions, quiz.shuffleQuestions]);

  const [timerSeconds, setTimerSeconds] = useState<number>(quiz.questionTimerSeconds ?? 20);

  const config: GameConfig = {
    quizMode: 'game',
    enablePowerUps: quiz.enablePowerUps ?? true,
    enableStreaks: quiz.enableStreaks ?? true,
    enableFunSounds: quiz.enableFunSounds ?? true,
    enableMemes: quiz.enableMemes ?? true,
    pointsPerQuestion: quiz.pointsPerQuestion ?? 1000,
    questionTimerSeconds: timerSeconds,
    shuffleQuestions: quiz.shuffleQuestions ?? true,
    shuffleOptions: quiz.shuffleOptions ?? true,
  };

  const [phase, setPhase] = useState<HostPhase>('lobby');
  const [players, setPlayers] = useState<Map<string, GamePlayer>>(new Map());
  const [currentQIndex, setCurrentQIndex] = useState(0);
  const [timeLeft, setTimeLeft] = useState(timerSeconds);
  const [countdownNum, setCountdownNum] = useState(3);
  const [muted, setMuted] = useState(getIsMuted());
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [currentAnswers, setCurrentAnswers] = useState<Map<string, PlayerAnswer>>(new Map());

  const currentAnswersRef = useRef<Map<string, PlayerAnswer>>(new Map());
  const playersRef = useRef<Map<string, GamePlayer>>(new Map());
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const questionStartTimeRef = useRef<number>(0);

  playersRef.current = players;
  currentAnswersRef.current = currentAnswers;

  const currentItem = playableItems[currentQIndex] || playableItems[0];

  // ─── 1. Setup Supabase Realtime Host Session ────────────────────────────────
  useEffect(() => {
    createGameSession(quiz.quizCode, {
      onPlayerJoin: (msg: RTPlayerJoinMessage) => {
        setPlayers((prev) => {
          const next = new Map(prev);
          if (!next.has(msg.playerId)) {
            next.set(msg.playerId, {
              id: msg.playerId,
              nickname: msg.nickname,
              avatarEmoji: msg.avatarEmoji,
              score: 0,
              streak: 0,
              longestStreak: 0,
              correctCount: 0,
              totalAnswered: 0,
              totalResponseTimeMs: 0,
              powerUps: [
                { type: 'fifty_fifty', used: false },
                { type: 'time_freeze', used: false },
                { type: 'double_points', used: false },
              ],
              isHost: false,
            });
            if (config.enableFunSounds) playPlayerJoinSound();
          }
          return next;
        });
      },
      onPlayerLeave: (msg: RTPlayerLeaveMessage) => {
        setPlayers((prev) => {
          const next = new Map(prev);
          next.delete(msg.playerId);
          return next;
        });
      },
      onPlayerAnswer: (msg: RTPlayerAnswerMessage) => {
        setCurrentAnswers((prev) => {
          const next = new Map(prev);
          next.set(msg.playerId, {
            playerId: msg.playerId,
            questionIndex: msg.questionIndex,
            optionIndex: msg.optionIndex,
            textAnswer: msg.textAnswer,
            timeLeftMs: msg.timeLeftMs,
            timestamp: Date.now(),
          });
          // Broadcast answer count update
          broadcastAnswerCount(msg.questionIndex, next.size, playersRef.current.size);
          return next;
        });
      },
    });

    return () => {
      destroySession();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [quiz.quizCode]);

  // ─── 2. Start Game Countdown ────────────────────────────────────────────────
  const handleStartGame = () => {
    playClickSound();
    setPhase('countdown');
    setCountdownNum(3);
    playGameStartCountdown(3);

    let step = 3;
    const interval = setInterval(() => {
      step -= 1;
      if (step > 0) {
        setCountdownNum(step);
        playGameStartCountdown(step);
      } else if (step === 0) {
        setCountdownNum(0); // "GO!"
        playGameStartCountdown(0);
      } else {
        clearInterval(interval);
        broadcastGameStart(playableItems.length, config);
        launchQuestion(0);
      }
    }, 1000);
  };

  // ─── 3. Launch Question ─────────────────────────────────────────────────────
  const launchQuestion = useCallback((qIdx: number) => {
    setCurrentQIndex(qIdx);
    setCurrentAnswers(new Map());
    setTimeLeft(config.questionTimerSeconds);
    setPhase('question');
    questionStartTimeRef.current = Date.now();

    const item = playableItems[qIdx];
    const timerMs = config.questionTimerSeconds * 1000;

    if (item) {
      broadcastQuestionStart(
        qIdx,
        playableItems.length,
        item.questionText,
        item.options,
        timerMs,
        !!item.diagramUrl,
        item.diagramUrl || undefined,
        {
          title: item.title,
          contextStem: item.contextStem,
          questionType: item.type,
          marks: item.marks,
        }
      );
    }

    // Start Timer Interval
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          handleTimeUp(qIdx);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, [playableItems, config]);

  // Check if all players answered
  useEffect(() => {
    if (phase === 'question' && players.size > 0 && currentAnswers.size >= players.size) {
      if (timerRef.current) clearInterval(timerRef.current);
      handleTimeUp(currentQIndex);
    }
  }, [currentAnswers, players.size, phase, currentQIndex]);

  // ─── 4. End Question & Reveal Answer ────────────────────────────────────────
  const handleTimeUp = useCallback((qIdx: number) => {
    setPhase('feedback');
    const item = playableItems[qIdx];
    const answersMap = currentAnswersRef.current;
    const currentPlayers = playersRef.current;
    const totalTimeMs = config.questionTimerSeconds * 1000;

    const playerResultsPayload: any = {};
    const updatedPlayers = new Map(currentPlayers);

    currentPlayers.forEach((player, pId) => {
      const ans = answersMap.get(pId);
      const playerSubmittedAnswer = ans ? (ans.optionIndex !== undefined ? ans.optionIndex : ans.textAnswer) : undefined;
      const evalResult = item ? evaluateGameAnswer(item, playerSubmittedAnswer) : { isCorrect: false, correctDisplay: '' };
      const isCorrect = evalResult.isCorrect;
      const timeLeftMs = ans ? ans.timeLeftMs : 0;

      const feedback = processAnswer(
        player,
        isCorrect,
        timeLeftMs,
        totalTimeMs,
        config.pointsPerQuestion,
        null, // host evaluates base without active power-ups
        config.enableStreaks,
        config.enableMemes
      );

      const newPlayer: GamePlayer = {
        ...player,
        score: feedback.newTotalScore,
        streak: feedback.newStreak,
        longestStreak: Math.max(player.longestStreak, feedback.newStreak),
        correctCount: player.correctCount + (isCorrect ? 1 : 0),
        totalAnswered: player.totalAnswered + 1,
        totalResponseTimeMs: player.totalResponseTimeMs + (totalTimeMs - timeLeftMs),
      };
      updatedPlayers.set(pId, newPlayer);

      playerResultsPayload[pId] = {
        isCorrect,
        pointsEarned: feedback.pointsEarned,
        newScore: feedback.newTotalScore,
        newStreak: feedback.newStreak,
        reaction: feedback.reaction,
      };

      if (feedback.newStreak >= 5 && isCorrect) {
        playAirhorn();
      }
    });

    setPlayers(updatedPlayers);
    broadcastAnswerReveal(
      qIdx,
      item?.correctOptionIndex,
      playerResultsPayload,
      item?.correctAnswerText,
      item ? `Answer: ${item.correctAnswerText}` : undefined
    );

    // Build new Leaderboard
    const newLb = buildLeaderboard(updatedPlayers, leaderboard);
    setLeaderboard(newLb);
  }, [playableItems, config, leaderboard]);

  // ─── 5. Show Leaderboard ────────────────────────────────────────────────────
  const handleShowLeaderboard = () => {
    playClickSound();
    setPhase('leaderboard');
    broadcastLeaderboard(leaderboard, currentQIndex);
  };

  // ─── 6. Next Question or Final Results ──────────────────────────────────────
  const handleNext = () => {
    playClickSound();
    if (currentQIndex + 1 < playableItems.length) {
      launchQuestion(currentQIndex + 1);
    } else {
      // Game Over
      setPhase('final_results');
      playVictoryFanfare();
      broadcastGameEnd(leaderboard, playableItems.length);
    }
  };

  // ─── 7. Export Results to Excel ─────────────────────────────────────────────
  const handleExportExcel = () => {
    const wb = XLSX.utils.book_new();
    const rows = leaderboard.map((e, idx) => ({
      'Rank': idx + 1,
      'Player Name': e.nickname,
      'Avatar': e.avatarEmoji,
      'Total Points': e.score,
      'Correct Answers': `${e.correctCount} / ${playableItems.length}`,
      'Accuracy (%)': `${((e.correctCount / Math.max(1, playableItems.length)) * 100).toFixed(1)}%`,
      'Longest Streak': e.streak,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Game Leaderboard');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    saveAs(blob, `${quiz.quizCode}_multiplayer_results.xlsx`);
  };

  const handleToggleAudio = () => {
    const isM = toggleMute();
    setMuted(isM);
  };

  return (
    <div className="gh-root animate-fade-in">
      {/* ─── Top Control Bar ─────────────────────────────────────────────────── */}
      <header className="gh-topbar">
        <div className="gh-topbar-left">
          <span className="gh-game-badge">🎮 LIVE HOST</span>
          <h2 className="gh-topbar-title">{quiz.title}</h2>
          <span className="gh-subject-pill">{quiz.subject || 'Assessment'}</span>
        </div>

        <div className="gh-topbar-right">
          <button
            type="button"
            className="gh-btn-icon"
            onClick={handleToggleAudio}
            title={muted ? 'Unmute Audio' : 'Mute Audio'}
          >
            {muted ? '🔇' : '🔊'}
          </button>
          <button
            type="button"
            className="gh-btn-exit"
            onClick={() => {
              if (confirm('Are you sure you want to end this live game session?')) {
                destroySession();
                onExit();
              }
            }}
          >
            ✕ Exit Game
          </button>
        </div>
      </header>

      {/* ═════════════════════════════════════════════════════════════════════════
          PHASE 1: LOBBY (WAITING FOR PLAYERS)
      ══════════════════════════════════════════════════════════════════════════ */}
      {phase === 'lobby' && (
        <main className="gh-lobby animate-scale-up">
          <div className="gh-join-hero">
            <div className="gh-join-instruction">
              <span>Join on your phone or laptop at:</span>
              <strong>{window.location.host}</strong>
            </div>

            <div className="gh-code-card">
              <span className="gh-code-label">GAME CODE:</span>
              <span className="gh-code-huge">{quiz.quizCode}</span>
            </div>

            <div className="gh-lobby-stats">
              <div className="gh-stat-chip">
                <span className="gh-chip-icon">👥</span>
                <strong>{players.size}</strong> Students Joined
              </div>
              <div className="gh-stat-chip">
                <span className="gh-chip-icon">📝</span>
                <strong>{playableItems.length}</strong> Questions / Rounds
              </div>
              <div className="gh-stat-chip">
                <span className="gh-chip-icon">⏱️</span>
                <strong>{timerSeconds}s</strong> per question
              </div>
            </div>

            {/* Custom Timer Selector Controls */}
            <div style={{
              background: 'rgba(15, 23, 42, 0.75)',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              borderRadius: '16px',
              padding: '12px 18px',
              margin: '10px 0',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              textAlign: 'left',
              width: '100%',
              boxSizing: 'border-box',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  ⏱️ Question Timer: <strong style={{ color: '#c084fc' }}>{timerSeconds}s</strong>
                </span>
                <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Change before starting</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                {[10, 15, 20, 30, 45, 60, 90, 120].map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    style={{
                      background: timerSeconds === sec ? '#8b5cf6' : 'rgba(255, 255, 255, 0.08)',
                      color: '#ffffff',
                      border: timerSeconds === sec ? '1px solid #c084fc' : '1px solid rgba(255, 255, 255, 0.15)',
                      borderRadius: '8px',
                      padding: '4px 10px',
                      fontWeight: 700,
                      fontSize: '0.85rem',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                    onClick={() => {
                      setTimerSeconds(sec);
                      setTimeLeft(sec);
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
                    value={timerSeconds}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (!isNaN(v) && v > 0) {
                        setTimerSeconds(v);
                        setTimeLeft(v);
                      }
                    }}
                    style={{
                      width: '60px',
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

            <button
              type="button"
              className="gh-btn-start-game"
              onClick={handleStartGame}
              disabled={players.size === 0}
            >
              {players.size === 0 ? '⏳ Waiting for students to join...' : `🚀 START GAME (${players.size} Players)`}
            </button>
          </div>

          {/* Connected Players Wall */}
          <div className="gh-players-wall">
            <h3 className="gh-wall-heading">Connected Players ({players.size})</h3>
            {players.size === 0 ? (
              <div className="gh-wall-empty">
                <div className="gh-pulse-dot" />
                <span>Waiting for players to enter code {quiz.quizCode}...</span>
              </div>
            ) : (
              <div className="gh-player-chips-grid">
                {Array.from(players.values()).map((p) => (
                  <div key={p.id} className="gh-player-chip animate-scale-up">
                    <span className="gh-chip-avatar">{p.avatarEmoji}</span>
                    <span className="gh-chip-name">{p.nickname}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </main>
      )}

      {/* ═════════════════════════════════════════════════════════════════════════
          PHASE 2: 3-2-1 COUNTDOWN
      ══════════════════════════════════════════════════════════════════════════ */}
      {phase === 'countdown' && (
        <main className="gh-countdown-screen">
          <div className="gh-countdown-number animate-bounce-in">
            {countdownNum === 0 ? 'GO!' : countdownNum}
          </div>
          <p className="gh-countdown-sub">Get ready to answer fast!</p>
        </main>
      )}

      {/* ═════════════════════════════════════════════════════════════════════════
          PHASE 3: QUESTION DISPLAY (TIMER RUNNING)
      ══════════════════════════════════════════════════════════════════════════ */}
      {(phase === 'question' || phase === 'feedback') && currentItem && (
        <main className="gh-question-screen animate-fade-in">
          {/* Progress Header */}
          <div className="gh-q-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="gh-q-number-pill">
                {currentItem.title} ({currentQIndex + 1} of {playableItems.length})
              </span>
              <span style={{
                background: currentItem.type === 'mcq' ? 'rgba(59, 130, 246, 0.2)' : 'rgba(139, 92, 246, 0.2)',
                color: currentItem.type === 'mcq' ? '#60a5fa' : '#c084fc',
                fontSize: '0.75rem',
                fontWeight: 800,
                padding: '3px 8px',
                borderRadius: '6px',
                border: '1px solid rgba(255, 255, 255, 0.1)',
              }}>
                {currentItem.type === 'mcq' ? '🔘 4-Choice MCQ' : '✏️ Chemistry / Math Sprint'}
              </span>
            </div>

            {/* Live Answers Counter */}
            <div className="gh-answers-counter">
              <span className="gh-counter-label">Answers Received:</span>
              <strong className="gh-counter-num">
                {currentAnswers.size} / {players.size}
              </strong>
            </div>

            {/* Timer Bubble */}
            <div className={`gh-timer-bubble ${timeLeft <= 5 ? 'gh-timer-urgent' : ''}`}>
              ⏱️ {timeLeft}s
            </div>
          </div>

          {/* Animated Timer Bar */}
          <div className="gh-timer-track">
            <div
              className="gh-timer-fill"
              style={{
                width: `${(timeLeft / config.questionTimerSeconds) * 100}%`,
              }}
            />
          </div>

          {/* Question Text Box */}
          <div className="gh-question-card">
            {currentItem.contextStem && (
              <div style={{
                background: 'rgba(139, 92, 246, 0.15)',
                border: '1px solid rgba(139, 92, 246, 0.3)',
                borderRadius: '10px',
                padding: '8px 14px',
                marginBottom: '10px',
                fontSize: '0.9rem',
                color: '#cbd5e1',
              }}>
                <strong>Context:</strong> <ExamMathText content={currentItem.contextStem} />
              </div>
            )}

            <div className="gh-question-text">
              <ExamMathText content={currentItem.questionText} />
            </div>

            {currentItem.diagramUrl && (
              <div className="gh-question-diagram">
                <img src={currentItem.diagramUrl} alt="Exam Diagram" />
              </div>
            )}
          </div>

          {/* Type A: 4 Colored MCQ Option Blocks */}
          {currentItem.type === 'mcq' ? (
            <div className="gh-options-grid">
              {(currentItem.options || ['Option A', 'Option B', 'Option C', 'Option D']).map((opt, oIdx) => {
                const optionShapes = ['◆', '●', '▲', '■'];
                const optionColors = ['red', 'blue', 'green', 'yellow'];
                const isCorrect = oIdx === currentItem.correctOptionIndex;
                const showResult = phase === 'feedback';

                return (
                  <div
                    key={oIdx}
                    className={`gh-option-card gh-option--${optionColors[oIdx % 4]} ${
                      showResult ? (isCorrect ? 'gh-option--correct' : 'gh-option--dimmed') : ''
                    }`}
                  >
                    <div className="gh-option-shape">{optionShapes[oIdx % 4]}</div>
                    <div className="gh-option-text">
                      <ExamMathText content={opt} />
                    </div>
                    {showResult && isCorrect && <span className="gh-correct-badge">✓ CORRECT</span>}
                  </div>
                );
              })}
            </div>
          ) : (
            /* Type B: Structured / Short-Answer Projector Banner */
            <div style={{
              background: 'rgba(15, 23, 42, 0.85)',
              border: '2px dashed rgba(139, 92, 246, 0.4)',
              borderRadius: '20px',
              padding: '24px',
              textAlign: 'center',
              margin: '12px 0',
            }}>
              {phase === 'feedback' ? (
                <div className="animate-scale-up">
                  <span style={{ fontSize: '0.85rem', fontWeight: 800, color: '#10b981', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                    ✓ Official Model Solution
                  </span>
                  <h2 style={{ fontSize: '1.75rem', fontWeight: 900, color: '#ffffff', margin: '8px 0' }}>
                    <ExamMathText content={currentItem.correctAnswerText} />
                  </h2>
                </div>
              ) : (
                <div>
                  <span style={{ fontSize: '2rem' }}>⚡</span>
                  <h3 style={{ fontSize: '1.25rem', fontWeight: 800, color: '#e2e8f0', margin: '6px 0' }}>
                    Students are typing their formula or calculation live!
                  </h3>
                  <p style={{ color: '#94a3b8', fontSize: '0.875rem', margin: 0 }}>
                    Fast deterministic grading active ({currentAnswers.size} submitted)
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Host Action Bar */}
          <div className="gh-host-action-bar">
            {phase === 'question' ? (
              <button
                type="button"
                className="gh-btn-action"
                onClick={() => {
                  if (timerRef.current) clearInterval(timerRef.current);
                  handleTimeUp(currentQIndex);
                }}
              >
                ⏹️ End Question Early ({currentAnswers.size}/{players.size} answered)
              </button>
            ) : (
              <button
                type="button"
                className="gh-btn-action gh-btn-action--primary animate-pulse"
                onClick={handleShowLeaderboard}
              >
                📊 Show Leaderboard →
              </button>
            )}
          </div>
        </main>
      )}

      {/* ═════════════════════════════════════════════════════════════════════════
          PHASE 4: MID-GAME LEADERBOARD
      ══════════════════════════════════════════════════════════════════════════ */}
      {phase === 'leaderboard' && (
        <main className="gh-leaderboard-screen animate-scale-up">
          <div className="gh-lb-header">
            <h2 className="gh-lb-title">🏆 Current Standings</h2>
            <span className="gh-lb-subtitle">After Question {currentQIndex + 1}</span>
          </div>

          <div className="gh-lb-list">
            {leaderboard.slice(0, 5).map((entry, idx) => (
              <div
                key={entry.playerId}
                className={`gh-lb-row gh-lb-rank-${idx + 1} animate-slide-up`}
                style={{ animationDelay: `${idx * 0.1}s` }}
              >
                <div className="gh-lb-rank">
                  {idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`}
                </div>
                <div className="gh-lb-player">
                  <span className="gh-lb-avatar">{entry.avatarEmoji}</span>
                  <strong className="gh-lb-name">{entry.nickname}</strong>
                  {entry.streak >= 3 && (
                    <span className="gh-lb-streak">🔥 {entry.streak}</span>
                  )}
                </div>
                <div className="gh-lb-score">{entry.score.toLocaleString()} pts</div>
              </div>
            ))}
          </div>

          <div className="gh-lb-actions">
            <button type="button" className="gh-btn-start-game" onClick={handleNext}>
              {currentQIndex + 1 < playableItems.length ? 'Next Question →' : '🏆 View Final Results →'}
            </button>
          </div>
        </main>
      )}

      {/* ═════════════════════════════════════════════════════════════════════════
          PHASE 5: FINAL RESULTS & PODIUM
      ══════════════════════════════════════════════════════════════════════════ */}
      {phase === 'final_results' && (
        <main className="gh-results-screen animate-fade-in">
          <div className="gh-podium-header">
            <span className="gh-results-badge">GAME OVER</span>
            <h1 className="gh-podium-title">🎉 Victory Podium! 🎉</h1>
          </div>

          {/* 3-Place Podium */}
          <div className="gh-podium-wrap">
            {/* 2nd Place */}
            {leaderboard[1] && (
              <div className="gh-podium-col gh-podium-col--2 animate-slide-up" style={{ animationDelay: '0.2s' }}>
                <div className="gh-podium-avatar">{leaderboard[1].avatarEmoji}</div>
                <div className="gh-podium-name">{leaderboard[1].nickname}</div>
                <div className="gh-podium-score">{leaderboard[1].score.toLocaleString()} pts</div>
                <div className="gh-podium-block gh-podium-block--2">🥈 2nd</div>
              </div>
            )}

            {/* 1st Place */}
            {leaderboard[0] && (
              <div className="gh-podium-col gh-podium-col--1 animate-slide-up">
                <div className="gh-podium-crown">👑</div>
                <div className="gh-podium-avatar">{leaderboard[0].avatarEmoji}</div>
                <div className="gh-podium-name">{leaderboard[0].nickname}</div>
                <div className="gh-podium-score">{leaderboard[0].score.toLocaleString()} pts</div>
                <div className="gh-podium-block gh-podium-block--1">🥇 1st</div>
              </div>
            )}

            {/* 3rd Place */}
            {leaderboard[2] && (
              <div className="gh-podium-col gh-podium-col--3 animate-slide-up" style={{ animationDelay: '0.4s' }}>
                <div className="gh-podium-avatar">{leaderboard[2].avatarEmoji}</div>
                <div className="gh-podium-name">{leaderboard[2].nickname}</div>
                <div className="gh-podium-score">{leaderboard[2].score.toLocaleString()} pts</div>
                <div className="gh-podium-block gh-podium-block--3">🥉 3rd</div>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="gh-results-actions">
            <button type="button" className="gh-btn-excel" onClick={handleExportExcel}>
              📊 Download Class Gradebook (.xlsx)
            </button>
            <button type="button" className="gh-btn-exit-final" onClick={onExit}>
              Exit to Teacher Suite
            </button>
          </div>
        </main>
      )}
    </div>
  );
}
