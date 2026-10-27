import { useState, useEffect } from 'react';
import {
  getActiveGameProfile,
  setActiveGameProfile,
  loginGameProfile,
  registerGameProfile,
  updateGameAvatar,
  DEFAULT_AVATAR,
} from '../../services/gameProfileService';
import { getSchoolSubjects, DEFAULT_SUBJECTS } from '../../lib/settings';
import { GameAvatarRenderer } from './GameAvatarRenderer';
import type { GameProfile, GameAvatarConfig } from '../../types/database';
import './GameProfileStudioModal.css';

interface GameProfileStudioModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const SKIN_TONES = [
  { label: 'Fair', value: '#ffd8b3' },
  { label: 'Warm', value: '#f2c197' },
  { label: 'Medium', value: '#d08b5b' },
  { label: 'Deep', value: '#8d5524' },
  { label: 'Espresso', value: '#593110' },
];

const HAIR_STYLES = [
  { id: 'curly_brunette', label: 'Curls (Brunette)', cost: 0 },
  { id: 'short_fade', label: 'Short Fade', cost: 0 },
  { id: 'messy_scientist', label: 'Wild Scientist', cost: 15 },
  { id: 'hijab_navy', label: 'ICM Hijab (Navy)', cost: 0 },
  { id: 'long_braids', label: 'Twin Braids', cost: 15 },
  { id: 'slick_back', label: 'Slick Back', cost: 15 },
  { id: 'bald', label: 'Clean Shaved', cost: 0 },
] as const;

const OUTFITS = [
  { id: 'lab_coat', label: 'Cambridge Lab Coat', cost: 0 },
  { id: 'school_blazer', label: 'ICM School Blazer', cost: 0 },
  { id: 'hazmat_suit', label: 'Chemical Hazmat Suit', cost: 25 },
  { id: 'hoodie_emerald', label: 'Emerald Hoodie', cost: 20 },
  { id: 'tweed_vest', label: 'Tweed Professor Vest', cost: 30 },
  { id: 'alchemist_robe', label: 'Alchemist Purple Robe', cost: 40 },
] as const;

const PROPS = [
  { id: 'erlenmeyer_flask', label: 'Erlenmeyer Flask', cost: 0 },
  { id: 'test_tube_rack', label: 'Reagent Tube Rack', cost: 0 },
  { id: 'bunsen_burner', label: 'Bunsen Burner', cost: 20 },
  { id: 'molecule_ball', label: 'Molecular 3D Model', cost: 25 },
  { id: 'periodic_chart', label: 'Pocket Periodic Table', cost: 30 },
  { id: 'gold_trophy', label: 'Grand Champion Trophy', cost: 50 },
] as const;

const AURAS = [
  { id: 'none', label: 'None', cost: 0 },
  { id: 'chem_bubbles', label: 'Effervescent Bubbles', cost: 0 },
  { id: 'sparkles', label: 'Golden Sparkles', cost: 20 },
  { id: 'electric_plasma', label: 'Electric Plasma Ring', cost: 30 },
  { id: 'flame_glow', label: 'Combustion Heat Aura', cost: 35 },
  { id: 'quantum_orbit', label: 'Quantum Electron Orbit', cost: 50 },
] as const;

const COHORT_OPTIONS = ['Grade 10', 'Grade 11', 'Grade 12'];

export function GameProfileStudioModal({ isOpen, onClose }: GameProfileStudioModalProps) {
  const [profile, setProfile] = useState<GameProfile | null>(() => getActiveGameProfile());

  // Navigation when logged in: 'avatar' | 'mastery' | 'history'
  const [activeTab, setActiveTab] = useState<'avatar' | 'mastery' | 'history'>('avatar');

  // Auth form states (when profile is null)
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [handleInput, setHandleInput] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [realNameInput, setRealNameInput] = useState('');
  const [selectedCohort, setSelectedCohort] = useState('Grade 10');
  const [authError, setAuthError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Avatar customization draft
  const [draftAvatar, setDraftAvatar] = useState<GameAvatarConfig>(() => profile?.avatar || DEFAULT_AVATAR);
  const [previewReaction, setPreviewReaction] = useState<'neutral' | 'happy' | 'thinking' | 'celebrating' | 'wrong'>('neutral');
  const [avatarSuccessMsg, setAvatarSuccessMsg] = useState('');

  // Topic mastery subject filter
  const [masterySubject, setMasterySubject] = useState('Chemistry');
  const [availableSubjects] = useState<string[]>(() => {
    const list = getSchoolSubjects();
    return list.length > 0 ? list : DEFAULT_SUBJECTS;
  });

  // Sync profile when opened or changed
  useEffect(() => {
    if (isOpen) {
      const current = getActiveGameProfile();
      setProfile(current);
      if (current) {
        setDraftAvatar(current.avatar);
      }
      setAuthError('');
      setAvatarSuccessMsg('');
    }
  }, [isOpen]);

  useEffect(() => {
    const handleProfileUpdate = () => {
      const current = getActiveGameProfile();
      setProfile(current);
      if (current) setDraftAvatar(current.avatar);
    };

    window.addEventListener('game_profile_changed', handleProfileUpdate);
    window.addEventListener('game_profile_updated', handleProfileUpdate);
    return () => {
      window.removeEventListener('game_profile_changed', handleProfileUpdate);
      window.removeEventListener('game_profile_updated', handleProfileUpdate);
    };
  }, []);

  if (!isOpen) return null;

  async function handleLoginSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAuthError('');
    setIsSubmitting(true);
    try {
      const res = await loginGameProfile(handleInput, pinInput);
      if (res.success && res.profile) {
        setProfile(res.profile);
        setDraftAvatar(res.profile.avatar);
      } else {
        setAuthError(res.error || 'Login failed. Check your handle and PIN.');
      }
    } catch {
      setAuthError('An error occurred during login. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleRegisterSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAuthError('');
    if (!handleInput.trim()) {
      setAuthError('Please enter a creative handle.');
      return;
    }
    if (pinInput.trim().length !== 4) {
      setAuthError('4-digit PIN is required for account protection.');
      return;
    }

    setIsSubmitting(true);
    try {
      const created = await registerGameProfile({
        handle: handleInput.trim(),
        pin: pinInput.trim(),
        realName: realNameInput.trim() || undefined,
        studentClass: selectedCohort,
        avatar: draftAvatar,
      });
      setProfile(created);
      setDraftAvatar(created.avatar);
    } catch (err: any) {
      setAuthError(err?.message || 'Registration failed. Try a different handle.');
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleLogout() {
    setActiveGameProfile(null);
    setProfile(null);
    setDraftAvatar(DEFAULT_AVATAR);
    setHandleInput('');
    setPinInput('');
  }

  async function handleEquipOrBuy(type: 'hair' | 'outfit' | 'prop' | 'aura', itemId: string, cost: number) {
    if (!profile) return;
    const isUnlocked = profile.unlocked_items?.includes(itemId) || cost === 0;

    if (!isUnlocked) {
      if (profile.coins < cost) {
        setAuthError(`You need 🪙 ${cost} coins to unlock this item. Answer questions to earn coins!`);
        setTimeout(() => setAuthError(''), 4000);
        return;
      }
    }

    const updatedAvatar: GameAvatarConfig = {
      ...draftAvatar,
      [type]: itemId,
    };
    setDraftAvatar(updatedAvatar);

    try {
      const updated = await updateGameAvatar(
        profile.id,
        updatedAvatar,
        !isUnlocked ? itemId : undefined,
        !isUnlocked ? cost : 0
      );
      setProfile(updated);
      setAvatarSuccessMsg(!isUnlocked ? `🎉 Unlocked ${itemId.replace(/_/g, ' ')}!` : '✓ Equipped!');
      setTimeout(() => setAvatarSuccessMsg(''), 2500);
    } catch (err: any) {
      setAuthError(err?.message || 'Failed to update avatar.');
    }
  }

  // Topic mastery calculations for active subject
  const subjectMastery = profile?.topic_mastery?.[masterySubject] || {};
  const topicList = Object.entries(subjectMastery);
  const totalCorrect = topicList.reduce((acc, [, val]) => acc + val.correct, 0);
  const totalAnswered = topicList.reduce((acc, [, val]) => acc + val.total, 0);
  const overallMasteryPct = totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0;

  return (
    <div className="game-studio-overlay" role="dialog" aria-modal="true">
      <div className="game-studio-card">
        {/* Modal Top Header */}
        <div className="game-studio-header">
          <div className="game-studio-header-left">
            <span className="game-studio-icon">🎮</span>
            <div>
              <h2 className="game-studio-title">Creative Mode Hub</h2>
              <p className="game-studio-sub">Parametric Avatars • Topic Mastery • Arcade Career</p>
            </div>
          </div>
          <button
            type="button"
            className="game-studio-close-btn"
            onClick={onClose}
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        {/* ─── STATE 1: GUEST / AUTHENTICATION GATE ─── */}
        {!profile ? (
          <div className="game-studio-auth-pane">
            <div className="game-studio-auth-tabs">
              <button
                type="button"
                className={`game-studio-auth-tab ${authMode === 'login' ? 'active' : ''}`}
                onClick={() => { setAuthMode('login'); setAuthError(''); }}
              >
                Log In to Existing Account
              </button>
              <button
                type="button"
                className={`game-studio-auth-tab ${authMode === 'register' ? 'active' : ''}`}
                onClick={() => { setAuthMode('register'); setAuthError(''); }}
              >
                Create New Creative Handle
              </button>
            </div>

            {authError && <div className="game-studio-error-banner">{authError}</div>}

            {authMode === 'login' ? (
              <form onSubmit={handleLoginSubmit} className="game-studio-form">
                <p className="game-studio-form-desc">
                  Log in with your custom handle and 4-digit PIN to load your customized avatar, coins, and topic mastery.
                </p>

                <div className="game-field">
                  <label className="game-label">Creative Handle</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. QuantumChemist"
                    value={handleInput}
                    onChange={(e) => setHandleInput(e.target.value)}
                    className="game-input"
                  />
                </div>

                <div className="game-field">
                  <label className="game-label">4-Digit Security PIN</label>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    required
                    placeholder="••••"
                    value={pinInput}
                    onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    className="game-input game-input--pin"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting || !handleInput.trim() || pinInput.length !== 4}
                  className="game-primary-btn"
                >
                  {isSubmitting ? 'Logging In…' : 'Enter Creative Hub'}
                </button>
              </form>
            ) : (
              <form onSubmit={handleRegisterSubmit} className="game-studio-form">
                <p className="game-studio-form-desc">
                  Create your student game profile. You will start with <strong>🪙 50 starter coins</strong> for the Avatar Wardrobe!
                </p>

                <div className="game-field">
                  <label className="game-label">Creative Handle * (Visible on leaderboards)</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. BenzeneRing or ApexElectron"
                    value={handleInput}
                    onChange={(e) => setHandleInput(e.target.value)}
                    className="game-input"
                  />
                </div>

                <div className="game-input-row">
                  <div className="game-field">
                    <label className="game-label">Real Name (Optional, for teacher reports)</label>
                    <input
                      type="text"
                      placeholder="e.g. Ahmad Fauzi"
                      value={realNameInput}
                      onChange={(e) => setRealNameInput(e.target.value)}
                      className="game-input"
                    />
                  </div>
                  <div className="game-field">
                    <label className="game-label">Teaching Cohort *</label>
                    <select
                      value={selectedCohort}
                      onChange={(e) => setSelectedCohort(e.target.value)}
                      className="game-select"
                    >
                      {COHORT_OPTIONS.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="game-field">
                  <label className="game-label">4-Digit Security PIN * (For cross-device login)</label>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    required
                    placeholder="•••• (e.g. 1234)"
                    value={pinInput}
                    onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    className="game-input game-input--pin"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting || !handleInput.trim() || pinInput.length !== 4}
                  className="game-primary-btn"
                >
                  {isSubmitting ? 'Creating Profile…' : 'Create & Claim 50 Coins'}
                </button>
              </form>
            )}
          </div>
        ) : (
          /* ─── STATE 2: AUTHENTICATED STUDENT CREATIVE HUB ─── */
          <div className="game-studio-main">
            {/* Top Identity Ribbon */}
            <div className="game-identity-ribbon">
              <div className="game-identity-left">
                <GameAvatarRenderer avatar={profile.avatar} reaction={previewReaction} size={64} />
                <div className="game-identity-meta">
                  <div className="game-identity-title-row">
                    <span className="game-identity-handle">{profile.handle}</span>
                    <span className="game-identity-level-badge">Lv. {profile.level}</span>
                    <span className="game-identity-cohort-badge">{profile.class}</span>
                  </div>
                  {profile.real_name && (
                    <span className="game-identity-realname">Student: {profile.real_name}</span>
                  )}
                  {/* XP Progress Bar */}
                  <div className="game-xp-bar-wrap">
                    <div
                      className="game-xp-bar-fill"
                      style={{ width: `${Math.min(100, ((profile.xp % 150) / 150) * 100)}%` }}
                    />
                    <span className="game-xp-text">{profile.xp % 150} / 150 XP to Level {profile.level + 1}</span>
                  </div>
                </div>
              </div>

              <div className="game-identity-right">
                <div className="game-coin-purse">
                  <span className="game-coin-icon">🪙</span>
                  <span className="game-coin-amount">{profile.coins}</span>
                  <span className="game-coin-label">Coins</span>
                </div>
                <button type="button" className="game-logout-btn" onClick={handleLogout} title="Switch or log out of this account">
                  Switch Account
                </button>
              </div>
            </div>

            {/* Sub-Navigation Tabs */}
            <div className="game-nav-tabs">
              <button
                type="button"
                className={`game-nav-tab ${activeTab === 'avatar' ? 'active' : ''}`}
                onClick={() => setActiveTab('avatar')}
              >
                🎨 Avatar Studio & Wardrobe
              </button>
              <button
                type="button"
                className={`game-nav-tab ${activeTab === 'mastery' ? 'active' : ''}`}
                onClick={() => setActiveTab('mastery')}
              >
                📊 Topic Mastery & Career
              </button>
              <button
                type="button"
                className={`game-nav-tab ${activeTab === 'history' ? 'active' : ''}`}
                onClick={() => setActiveTab('history')}
              >
                📜 Match History ({profile.match_history?.length || 0})
              </button>
            </div>

            {authError && <div className="game-studio-error-banner">{authError}</div>}
            {avatarSuccessMsg && <div className="game-studio-success-banner">{avatarSuccessMsg}</div>}

            {/* ─── TAB 1: AVATAR STUDIO & WARDROBE ─── */}
            {activeTab === 'avatar' && (
              <div className="game-tab-pane game-avatar-studio-layout">
                {/* Left: Interactive Avatar Preview */}
                <div className="game-avatar-preview-box">
                  <div className="game-avatar-stage">
                    <GameAvatarRenderer avatar={draftAvatar} reaction={previewReaction} size={150} />
                  </div>

                  {/* Reaction preview buttons */}
                  <div className="game-reaction-controls">
                    <span className="game-reaction-label">Emotional Reaction:</span>
                    <div className="game-reaction-btn-row">
                      {(['neutral', 'happy', 'thinking', 'celebrating', 'wrong'] as const).map((r) => (
                        <button
                          key={r}
                          type="button"
                          className={`game-reaction-btn ${previewReaction === r ? 'active' : ''}`}
                          onClick={() => setPreviewReaction(r)}
                        >
                          {r === 'neutral' ? '😐 Calm' : r === 'happy' ? '😊 Happy' : r === 'thinking' ? '🤔 Think' : r === 'celebrating' ? '🎉 Win' : '😅 Oops'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Right: Customization Wardrobe */}
                <div className="game-wardrobe-scroll">
                  {/* Skin Tone */}
                  <div className="game-wardrobe-section">
                    <span className="game-wardrobe-title">Skin Complexion</span>
                    <div className="game-skin-row">
                      {SKIN_TONES.map((st) => (
                        <button
                          key={st.value}
                          type="button"
                          className={`game-skin-btn ${draftAvatar.skin === st.value ? 'selected' : ''}`}
                          style={{ backgroundColor: st.value }}
                          onClick={() => {
                            const updated = { ...draftAvatar, skin: st.value };
                            setDraftAvatar(updated);
                            updateGameAvatar(profile.id, updated).catch(() => {});
                          }}
                          title={st.label}
                        />
                      ))}
                    </div>
                  </div>

                  {/* Hair / Headwear */}
                  <div className="game-wardrobe-section">
                    <span className="game-wardrobe-title">Hair & Headwear</span>
                    <div className="game-item-grid">
                      {HAIR_STYLES.map((h) => {
                        const isEquipped = draftAvatar.hair === h.id;
                        const isUnlocked = profile.unlocked_items?.includes(h.id) || h.cost === 0;
                        return (
                          <button
                            key={h.id}
                            type="button"
                            className={`game-item-card ${isEquipped ? 'equipped' : ''}`}
                            onClick={() => handleEquipOrBuy('hair', h.id, h.cost)}
                          >
                            <span className="game-item-name">{h.label}</span>
                            <span className="game-item-status">
                              {isEquipped ? '✓ Equipped' : isUnlocked ? 'Equip' : `🪙 ${h.cost}`}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Outfits */}
                  <div className="game-wardrobe-section">
                    <span className="game-wardrobe-title">Outfit & Attire</span>
                    <div className="game-item-grid">
                      {OUTFITS.map((o) => {
                        const isEquipped = draftAvatar.outfit === o.id;
                        const isUnlocked = profile.unlocked_items?.includes(o.id) || o.cost === 0;
                        return (
                          <button
                            key={o.id}
                            type="button"
                            className={`game-item-card ${isEquipped ? 'equipped' : ''}`}
                            onClick={() => handleEquipOrBuy('outfit', o.id, o.cost)}
                          >
                            <span className="game-item-name">{o.label}</span>
                            <span className="game-item-status">
                              {isEquipped ? '✓ Equipped' : isUnlocked ? 'Equip' : `🪙 ${o.cost}`}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Chemistry Props */}
                  <div className="game-wardrobe-section">
                    <span className="game-wardrobe-title">Held Scientific Prop</span>
                    <div className="game-item-grid">
                      {PROPS.map((p) => {
                        const isEquipped = draftAvatar.prop === p.id;
                        const isUnlocked = profile.unlocked_items?.includes(p.id) || p.cost === 0;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            className={`game-item-card ${isEquipped ? 'equipped' : ''}`}
                            onClick={() => handleEquipOrBuy('prop', p.id, p.cost)}
                          >
                            <span className="game-item-name">{p.label}</span>
                            <span className="game-item-status">
                              {isEquipped ? '✓ Equipped' : isUnlocked ? 'Equip' : `🪙 ${p.cost}`}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Aura Effects */}
                  <div className="game-wardrobe-section">
                    <span className="game-wardrobe-title">Special Aura Effect</span>
                    <div className="game-item-grid">
                      {AURAS.map((a) => {
                        const isEquipped = draftAvatar.aura === a.id;
                        const isUnlocked = profile.unlocked_items?.includes(a.id) || a.cost === 0;
                        return (
                          <button
                            key={a.id}
                            type="button"
                            className={`game-item-card ${isEquipped ? 'equipped' : ''}`}
                            onClick={() => handleEquipOrBuy('aura', a.id, a.cost)}
                          >
                            <span className="game-item-name">{a.label}</span>
                            <span className="game-item-status">
                              {isEquipped ? '✓ Equipped' : isUnlocked ? 'Equip' : `🪙 ${a.cost}`}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ─── TAB 2: TOPIC MASTERY & CAREER ─── */}
            {activeTab === 'mastery' && (
              <div className="game-tab-pane">
                <div className="game-mastery-header">
                  <div>
                    <h3 className="game-pane-heading">Subject Topic Mastery</h3>
                    <p className="game-pane-sub">Track your accuracy and mastery progression by subject</p>
                  </div>
                  {/* Subject filter */}
                  <select
                    className="game-select"
                    style={{ width: 'auto', minWidth: '180px' }}
                    value={masterySubject}
                    onChange={(e) => setMasterySubject(e.target.value)}
                  >
                    {availableSubjects.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>

                {/* Overall Subject KPI Ribbon */}
                <div className="game-mastery-kpi-grid">
                  <div className="game-kpi-box">
                    <span className="game-kpi-val">{totalAnswered}</span>
                    <span className="game-kpi-lbl">Questions Attempted</span>
                  </div>
                  <div className="game-kpi-box">
                    <span className="game-kpi-val">{totalCorrect}</span>
                    <span className="game-kpi-lbl">Correct Answers</span>
                  </div>
                  <div className="game-kpi-box">
                    <span className="game-kpi-val" style={{ color: overallMasteryPct >= 80 ? '#10b981' : '#24448c' }}>
                      {overallMasteryPct}%
                    </span>
                    <span className="game-kpi-lbl">Overall Mastery</span>
                  </div>
                </div>

                {/* Topic Breakdown Bars */}
                {topicList.length > 0 ? (
                  <div className="game-topic-bars-list">
                    {topicList.map(([topic, data]) => {
                      const color = data.masteryPct >= 80 ? '#10b981' : data.masteryPct >= 60 ? '#f59e0b' : '#3b82f6';
                      return (
                        <div key={topic} className="game-topic-item">
                          <div className="game-topic-header">
                            <span className="game-topic-name">{topic}</span>
                            <span className="game-topic-score" style={{ color }}>
                              {data.correct} / {data.total} ({data.masteryPct}%)
                            </span>
                          </div>
                          <div className="game-topic-bar-bg">
                            <div
                              className="game-topic-bar-fill"
                              style={{ width: `${data.masteryPct}%`, backgroundColor: color }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="game-empty-state">
                    <span className="game-empty-icon">🧪</span>
                    <strong>No practice matches recorded in {masterySubject} yet</strong>
                    <p>Enter an exam or quiz code to start building your topic mastery!</p>
                  </div>
                )}
              </div>
            )}

            {/* ─── TAB 3: MATCH HISTORY ─── */}
            {activeTab === 'history' && (
              <div className="game-tab-pane">
                {profile.match_history && profile.match_history.length > 0 ? (
                  <div className="game-history-list">
                    {profile.match_history.map((m, idx) => (
                      <div key={m.matchId || idx} className="game-history-card">
                        <div className="game-history-top">
                          <div>
                            <span className="game-history-title">{m.quizTitle}</span>
                            <span className="game-history-subject">{m.subject} • {new Date(m.timestamp).toLocaleDateString()}</span>
                          </div>
                          <div className="game-history-badges">
                            <span className="game-history-score-badge">🏆 {m.score} pts</span>
                            <span className="game-history-acc-badge">{m.accuracy}% Acc</span>
                          </div>
                        </div>
                        {m.missedTopics && m.missedTopics.length > 0 && (
                          <div className="game-history-missed">
                            <span className="game-history-missed-label">Topics to review:</span>
                            {m.missedTopics.map((t, ti) => (
                              <span key={ti} className="game-history-missed-tag">{t}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="game-empty-state">
                    <span className="game-empty-icon">🎮</span>
                    <strong>No completed matches yet</strong>
                    <p>Matches you complete in Creative Mode will appear here with question review summaries.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
