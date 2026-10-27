import type { GameAvatarConfig } from '../../types/database';

export interface GameAvatarRendererProps {
  avatar: GameAvatarConfig;
  reaction?: 'neutral' | 'happy' | 'thinking' | 'celebrating' | 'wrong';
  size?: number;
  className?: string;
  showAura?: boolean;
}

export function GameAvatarRenderer({
  avatar,
  reaction = 'neutral',
  size = 80,
  className = '',
  showAura = true,
}: GameAvatarRendererProps) {
  const skin = avatar.skin || '#ffd8b3';
  const eyes = avatar.eyes || 'curious';
  const hair = avatar.hair || 'curly_brunette';
  const outfit = avatar.outfit || 'lab_coat';
  const prop = avatar.prop || 'erlenmeyer_flask';
  const aura = avatar.aura || 'none';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={`game-avatar-svg ${className}`}
      aria-label="Student Avatar"
      role="img"
      style={{ overflow: 'visible', display: 'inline-block' }}
    >
      <defs>
        {/* Glow Filters */}
        <filter id={`aura-glow-${size}`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="3.5" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
        <radialGradient id={`flask-grad-${size}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#8abf44" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#24448c" stopOpacity="0.8" />
        </radialGradient>
      </defs>

      {/* ─── LAYER 1: Aura (Background Effect) ─── */}
      {showAura && aura !== 'none' && (
        <g className="avatar-aura-layer">
          {aura === 'chem_bubbles' && (
            <g opacity="0.85">
              <circle cx="22" cy="30" r="5" fill="#8abf44" opacity="0.5" />
              <circle cx="78" cy="28" r="6" fill="#38bdf8" opacity="0.6" />
              <circle cx="16" cy="60" r="4" fill="#22c55e" opacity="0.4" />
              <circle cx="84" cy="55" r="4.5" fill="#8abf44" opacity="0.5" />
              <circle cx="50" cy="14" r="3.5" fill="#38bdf8" opacity="0.7" />
              {/* Floating bubble outlines */}
              <circle cx="22" cy="30" r="4" stroke="#ffffff" strokeWidth="0.8" fill="none" opacity="0.6" />
              <circle cx="78" cy="28" r="5" stroke="#ffffff" strokeWidth="0.8" fill="none" opacity="0.6" />
            </g>
          )}

          {aura === 'sparkles' && (
            <g opacity="0.9">
              <path d="M 18 24 L 20 28 L 24 30 L 20 32 L 18 36 L 16 32 L 12 30 L 16 28 Z" fill="#fbbf24" />
              <path d="M 82 22 L 83.5 25 L 86.5 26.5 L 83.5 28 L 82 31 L 80.5 28 L 77.5 26.5 L 80.5 25 Z" fill="#f59e0b" />
              <path d="M 86 64 L 87 66 L 89 67 L 87 68 L 86 70 L 85 68 L 83 67 L 85 66 Z" fill="#fbbf24" />
              <path d="M 14 62 L 15.5 64 L 17.5 65 L 15.5 66 L 14 68 L 12.5 66 L 10.5 65 L 12.5 64 Z" fill="#f59e0b" />
            </g>
          )}

          {aura === 'electric_plasma' && (
            <g opacity="0.8">
              <circle cx="50" cy="50" r="45" fill="none" stroke="#38bdf8" strokeWidth="1.5" strokeDasharray="6,4" opacity="0.7" />
              <circle cx="50" cy="50" r="42" fill="none" stroke="#818cf8" strokeWidth="1.2" opacity="0.5" />
              <path d="M 20 18 Q 28 26 22 34" stroke="#00f2fe" strokeWidth="1.8" fill="none" />
              <path d="M 80 18 Q 72 26 78 34" stroke="#00f2fe" strokeWidth="1.8" fill="none" />
            </g>
          )}

          {aura === 'flame_glow' && (
            <circle cx="50" cy="50" r="44" fill="#f59e0b" opacity="0.18" filter={`url(#aura-glow-${size})`} />
          )}

          {aura === 'quantum_orbit' && (
            <g opacity="0.75">
              <ellipse cx="50" cy="50" rx="46" ry="16" fill="none" stroke="#24448c" strokeWidth="1.2" transform="rotate(-25 50 50)" />
              <circle cx="86" cy="34" r="3" fill="#24448c" />
              <ellipse cx="50" cy="50" rx="46" ry="16" fill="none" stroke="#8abf44" strokeWidth="1.2" transform="rotate(35 50 50)" />
              <circle cx="15" cy="40" r="3" fill="#8abf44" />
            </g>
          )}
        </g>
      )}

      {/* ─── LAYER 2: Base Body, Neck & Face ─── */}
      <g className="avatar-body-layer">
        {/* Neck */}
        <rect x="44" y="62" width="12" height="12" rx="2" fill={skin} />

        {/* Shoulders / Upper Torso Foundation */}
        <path d="M 22 96 C 22 76, 34 70, 50 70 C 66 70, 78 76, 78 96 Z" fill={skin} opacity="0.9" />

        {/* Ears */}
        {hair !== 'hijab_navy' && (
          <>
            <circle cx="28" cy="48" r="4.5" fill={skin} />
            <circle cx="72" cy="48" r="4.5" fill={skin} />
          </>
        )}

        {/* Face Oval */}
        <ellipse cx="50" cy="47" rx="21" ry="23" fill={skin} />
      </g>

      {/* ─── LAYER 3: Outfit (Torso Garment) ─── */}
      <g className="avatar-outfit-layer">
        {outfit === 'lab_coat' && (
          <g>
            <path d="M 22 96 C 22 75, 33 70, 50 70 C 67 70, 78 75, 78 96 Z" fill="#ffffff" stroke="#cbd5e1" strokeWidth="1" />
            {/* V-neck lapel & buttons */}
            <path d="M 43 70 L 50 82 L 57 70" fill="none" stroke="#24448c" strokeWidth="1.8" />
            <line x1="50" y1="82" x2="50" y2="96" stroke="#94a3b8" strokeWidth="1.2" />
            <circle cx="50" cy="86" r="1.2" fill="#475569" />
            <circle cx="50" cy="91" r="1.2" fill="#475569" />
            {/* Pocket with chemistry pens */}
            <rect x="30" y="80" width="8" height="9" rx="1.5" fill="#f8fafc" stroke="#cbd5e1" strokeWidth="0.8" />
            <line x1="32" y1="77" x2="32" y2="82" stroke="#24448c" strokeWidth="1.4" strokeLinecap="round" />
            <line x1="35" y1="76" x2="35" y2="82" stroke="#e11d48" strokeWidth="1.4" strokeLinecap="round" />
          </g>
        )}

        {outfit === 'school_blazer' && (
          <g>
            <path d="M 22 96 C 22 75, 33 70, 50 70 C 67 70, 78 75, 78 96 Z" fill="#1e293b" />
            {/* Inner white shirt & tie */}
            <polygon points="45,70 55,70 50,80" fill="#ffffff" />
            <polygon points="48,72 52,72 50.8,84 49.2,84" fill="#8abf44" />
            {/* Lapels */}
            <path d="M 32 70 L 45 84 L 50 96 L 55 84 L 68 70" fill="none" stroke="#0f172a" strokeWidth="1.5" />
            {/* School Crest Badge */}
            <circle cx="34" cy="80" r="3.2" fill="#24448c" stroke="#fbbf24" strokeWidth="0.8" />
          </g>
        )}

        {outfit === 'hazmat_suit' && (
          <g>
            <path d="M 22 96 C 22 75, 33 70, 50 70 C 67 70, 78 75, 78 96 Z" fill="#eab308" stroke="#ca8a04" strokeWidth="1" />
            {/* Neck seal ring */}
            <rect x="36" y="68" width="28" height="6" rx="3" fill="#0f172a" />
            {/* Chest biohazard / radiation emblem */}
            <circle cx="50" cy="83" r="4.5" fill="#0f172a" />
            <circle cx="50" cy="83" r="2" fill="#eab308" />
          </g>
        )}

        {outfit === 'hoodie_emerald' && (
          <g>
            <path d="M 22 96 C 22 75, 33 70, 50 70 C 67 70, 78 75, 78 96 Z" fill="#10b981" />
            {/* Hood collar & strings */}
            <path d="M 40 70 C 44 76, 56 76, 60 70" fill="none" stroke="#047857" strokeWidth="2.5" />
            <line x1="46" y1="74" x2="45" y2="84" stroke="#ffffff" strokeWidth="1.2" strokeLinecap="round" />
            <line x1="54" y1="74" x2="55" y2="84" stroke="#ffffff" strokeWidth="1.2" strokeLinecap="round" />
          </g>
        )}

        {outfit === 'tweed_vest' && (
          <g>
            <path d="M 22 96 C 22 75, 33 70, 50 70 C 67 70, 78 75, 78 96 Z" fill="#78350f" />
            <polygon points="44,70 56,70 50,78" fill="#fef3c7" />
            <polygon points="48,72 52,72 50.5,82 49.5,82" fill="#991b1b" />
            <line x1="50" y1="78" x2="50" y2="96" stroke="#451a03" strokeWidth="1.5" />
            <circle cx="50" cy="83" r="1.2" fill="#fde047" />
            <circle cx="50" cy="89" r="1.2" fill="#fde047" />
          </g>
        )}

        {outfit === 'alchemist_robe' && (
          <g>
            <path d="M 22 96 C 22 75, 33 70, 50 70 C 67 70, 78 75, 78 96 Z" fill="#4c1d95" stroke="#6d28d9" strokeWidth="1" />
            <path d="M 40 70 L 50 82 L 60 70" fill="none" stroke="#fbbf24" strokeWidth="1.8" />
            <line x1="50" y1="82" x2="50" y2="96" stroke="#fbbf24" strokeWidth="1.2" />
          </g>
        )}
      </g>

      {/* ─── LAYER 4: Facial Expressions & Eyes ─── */}
      <g className="avatar-face-features">
        {/* Eyebrows */}
        {reaction === 'thinking' ? (
          <>
            <path d="M 38 37 Q 43 33 46 38" stroke="#334155" strokeWidth="1.6" fill="none" strokeLinecap="round" />
            <path d="M 54 39 Q 58 39 63 38" stroke="#334155" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          </>
        ) : reaction === 'celebrating' || reaction === 'happy' ? (
          <>
            <path d="M 37 36 Q 42 34 46 37" stroke="#334155" strokeWidth="1.6" fill="none" strokeLinecap="round" />
            <path d="M 54 37 Q 58 34 63 36" stroke="#334155" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          </>
        ) : (
          <>
            <path d="M 37 38 Q 42 37 46 38" stroke="#334155" strokeWidth="1.5" fill="none" strokeLinecap="round" />
            <path d="M 54 38 Q 58 37 63 38" stroke="#334155" strokeWidth="1.5" fill="none" strokeLinecap="round" />
          </>
        )}

        {/* Eyes / Reactions */}
        {reaction === 'celebrating' ? (
          // Happy closed eyes (^ ^)
          <g>
            <path d="M 38 46 Q 42 41 46 46" fill="none" stroke="#0f172a" strokeWidth="2.2" strokeLinecap="round" />
            <path d="M 54 46 Q 58 41 62 46" fill="none" stroke="#0f172a" strokeWidth="2.2" strokeLinecap="round" />
          </g>
        ) : eyes === 'winking' || reaction === 'happy' ? (
          // Winking or joyful
          <g>
            <circle cx="42" cy="46" r="3.8" fill="#0f172a" />
            <circle cx="43.2" cy="44.8" r="1.2" fill="#ffffff" />
            <path d="M 54 46 Q 58 43 62 46" fill="none" stroke="#0f172a" strokeWidth="2.2" strokeLinecap="round" />
          </g>
        ) : eyes === 'starry' ? (
          // Star pupils
          <g>
            <polygon points="42,42 43.5,45 46.5,46 43.5,47 42,50 40.5,47 37.5,46 40.5,45" fill="#f59e0b" />
            <polygon points="58,42 59.5,45 62.5,46 59.5,47 58,50 56.5,47 53.5,46 56.5,45" fill="#f59e0b" />
          </g>
        ) : eyes === 'goggles' ? (
          // Chemistry Safety Goggles
          <g>
            {/* Strap */}
            <path d="M 24 45 L 76 45" stroke="#0f172a" strokeWidth="2.5" />
            {/* Goggle Frames */}
            <circle cx="42" cy="45" r="7.5" fill="rgba(56, 189, 248, 0.25)" stroke="#0284c7" strokeWidth="1.8" />
            <circle cx="58" cy="45" r="7.5" fill="rgba(56, 189, 248, 0.25)" stroke="#0284c7" strokeWidth="1.8" />
            {/* Bridge */}
            <line x1="49.5" y1="45" x2="50.5" y2="45" stroke="#0284c7" strokeWidth="2" />
            {/* Pupils through lens */}
            <circle cx="42" cy="45" r="3" fill="#0f172a" />
            <circle cx="58" cy="45" r="3" fill="#0f172a" />
            <circle cx="43" cy="44" r="1" fill="#ffffff" />
            <circle cx="59" cy="44" r="1" fill="#ffffff" />
          </g>
        ) : eyes === 'focused' ? (
          // Focused/Determined
          <g>
            <ellipse cx="42" cy="46" rx="3.5" ry="2.8" fill="#0f172a" />
            <ellipse cx="58" cy="46" rx="3.5" ry="2.8" fill="#0f172a" />
            <circle cx="43" cy="45" r="1" fill="#ffffff" />
            <circle cx="59" cy="45" r="1" fill="#ffffff" />
          </g>
        ) : (
          // Standard / Curious eyes
          <g>
            <circle cx="42" cy="46" r="3.6" fill="#0f172a" />
            <circle cx="58" cy="46" r="3.6" fill="#0f172a" />
            <circle cx="43.2" cy="44.8" r="1.2" fill="#ffffff" />
            <circle cx="59.2" cy="44.8" r="1.2" fill="#ffffff" />
          </g>
        )}

        {/* Nose */}
        <path d="M 49 48 L 51 51 L 49.5 52" fill="none" stroke="#94a3b8" strokeWidth="1.2" strokeLinecap="round" />

        {/* Mouth */}
        {reaction === 'celebrating' ? (
          <path d="M 44 55 Q 50 63 56 55 Z" fill="#e11d48" stroke="#9f1239" strokeWidth="1" />
        ) : reaction === 'happy' ? (
          <path d="M 45 55 Q 50 61 55 55" fill="none" stroke="#0f172a" strokeWidth="1.8" strokeLinecap="round" />
        ) : reaction === 'wrong' ? (
          <g>
            <path d="M 46 58 Q 50 54 54 58" fill="none" stroke="#0f172a" strokeWidth="1.8" strokeLinecap="round" />
            {/* Sweat drop on cheek */}
            <path d="M 68 46 C 68 49, 70 51, 68 53 C 66 51, 68 49, 68 46 Z" fill="#38bdf8" />
          </g>
        ) : reaction === 'thinking' ? (
          <path d="M 47 57 Q 50 56 54 57" fill="none" stroke="#0f172a" strokeWidth="1.6" strokeLinecap="round" />
        ) : (
          <path d="M 46 56 Q 50 59 54 56" fill="none" stroke="#0f172a" strokeWidth="1.6" strokeLinecap="round" />
        )}
      </g>

      {/* ─── LAYER 5: Hair & Headwear ─── */}
      <g className="avatar-hair-layer">
        {hair === 'curly_brunette' && (
          <g fill="#451a03">
            <circle cx="38" cy="27" r="9" />
            <circle cx="50" cy="24" r="10" />
            <circle cx="62" cy="27" r="9" />
            <circle cx="31" cy="35" r="7" />
            <circle cx="69" cy="35" r="7" />
            <path d="M 31 32 C 34 26, 44 26, 50 28 C 56 26, 66 26, 69 32 C 65 37, 35 37, 31 32 Z" />
          </g>
        )}

        {hair === 'short_fade' && (
          <g fill="#1e293b">
            <path d="M 30 40 C 30 26, 40 24, 50 24 C 60 24, 70 26, 70 40 C 67 36, 60 32, 50 32 C 40 32, 33 36, 30 40 Z" />
          </g>
        )}

        {hair === 'messy_scientist' && (
          <g fill="#f8fafc" stroke="#cbd5e1" strokeWidth="1">
            {/* Wild unruly spikes */}
            <path d="M 30 38 L 22 26 L 32 30 L 36 16 L 44 24 L 50 14 L 56 24 L 64 16 L 68 30 L 78 26 L 70 38 Z" />
          </g>
        )}

        {hair === 'long_braids' && (
          <g fill="#172554">
            <path d="M 31 36 C 33 26, 42 24, 50 24 C 58 24, 67 26, 69 36 Z" />
            {/* Left Braid */}
            <circle cx="26" cy="46" r="4.5" />
            <circle cx="25" cy="54" r="4" />
            <circle cx="24" cy="62" r="3.5" />
            <circle cx="23" cy="70" r="3" fill="#8abf44" />
            {/* Right Braid */}
            <circle cx="74" cy="46" r="4.5" />
            <circle cx="75" cy="54" r="4" />
            <circle cx="76" cy="62" r="3.5" />
            <circle cx="77" cy="70" r="3" fill="#8abf44" />
          </g>
        )}

        {hair === 'hijab_navy' && (
          <g>
            {/* Wrap contour around head down to shoulders */}
            <path
              d="M 26 44 C 26 24, 40 20, 50 20 C 60 20, 74 24, 74 44 C 74 65, 68 76, 50 78 C 32 76, 26 65, 26 44 Z"
              fill="#1e3a8a"
            />
            {/* Inner face cutout */}
            <ellipse cx="50" cy="48" rx="17" ry="20" fill={skin} />
            {/* Inner cloth framing */}
            <path d="M 33 46 C 35 34, 44 32, 50 32 C 56 32, 65 34, 67 46" fill="none" stroke="#2563eb" strokeWidth="2.5" />
          </g>
        )}

        {hair === 'slick_back' && (
          <g fill="#292524">
            <path d="M 29 42 C 30 26, 38 23, 50 23 C 62 23, 70 26, 71 42 C 68 34, 60 30, 50 30 C 40 30, 32 34, 29 42 Z" />
          </g>
        )}
      </g>

      {/* ─── LAYER 6: Held Prop / Chemistry Tool ─── */}
      <g className="avatar-prop-layer">
        {prop === 'erlenmeyer_flask' && (
          <g transform="translate(62, 68)">
            {/* Flask Body */}
            <path d="M 10 2 L 14 2 L 14 8 L 22 22 C 23 24, 21 26, 18 26 L 6 26 C 3 26, 1 24, 2 22 L 10 8 Z" fill="rgba(241, 245, 249, 0.7)" stroke="#64748b" strokeWidth="1" />
            {/* Bubbling Solution */}
            <path d="M 4 22 L 20 22 C 21 24, 19 25.5, 17 25.5 L 7 25.5 C 5 25.5, 3 24, 4 22 Z" fill={`url(#flask-grad-${size})`} />
            <circle cx="12" cy="18" r="1.5" fill="#8abf44" opacity="0.8" />
            <circle cx="10" cy="14" r="1" fill="#38bdf8" opacity="0.8" />
          </g>
        )}

        {prop === 'test_tube_rack' && (
          <g transform="translate(60, 72)">
            {/* Base Rack */}
            <rect x="2" y="16" width="22" height="6" rx="1.5" fill="#78350f" />
            {/* 3 Tubes with colored reagents */}
            <rect x="5" y="4" width="4" height="13" rx="2" fill="#ef4444" opacity="0.85" stroke="#475569" strokeWidth="0.8" />
            <rect x="11" y="2" width="4" height="15" rx="2" fill="#3b82f6" opacity="0.85" stroke="#475569" strokeWidth="0.8" />
            <rect x="17" y="5" width="4" height="12" rx="2" fill="#10b981" opacity="0.85" stroke="#475569" strokeWidth="0.8" />
          </g>
        )}

        {prop === 'bunsen_burner' && (
          <g transform="translate(64, 68)">
            {/* Base & Barrel */}
            <rect x="6" y="20" width="14" height="5" rx="1" fill="#475569" />
            <rect x="11" y="8" width="4" height="13" fill="#94a3b8" />
            {/* Blue Inner & Outer Flame */}
            <path d="M 13 8 C 11 4, 11 0, 13 -2 C 15 0, 15 4, 13 8 Z" fill="#38bdf8" />
            <path d="M 13 8 C 12 5, 12 2, 13 1 C 14 2, 14 5, 13 8 Z" fill="#60a5fa" />
          </g>
        )}

        {prop === 'molecule_ball' && (
          <g transform="translate(62, 68)">
            {/* Carbon Center & Hydrogens */}
            <line x1="12" y1="12" x2="4" y2="6" stroke="#475569" strokeWidth="1.8" />
            <line x1="12" y1="12" x2="20" y2="6" stroke="#475569" strokeWidth="1.8" />
            <line x1="12" y1="12" x2="12" y2="22" stroke="#475569" strokeWidth="1.8" />
            <circle cx="12" cy="12" r="5" fill="#1e293b" />
            <circle cx="4" cy="6" r="3.2" fill="#ffffff" stroke="#94a3b8" strokeWidth="0.8" />
            <circle cx="20" cy="6" r="3.2" fill="#ffffff" stroke="#94a3b8" strokeWidth="0.8" />
            <circle cx="12" cy="22" r="3.2" fill="#ffffff" stroke="#94a3b8" strokeWidth="0.8" />
          </g>
        )}

        {prop === 'periodic_chart' && (
          <g transform="translate(60, 68)">
            <rect x="3" y="4" width="20" height="18" rx="1" fill="#fef3c7" stroke="#b45309" strokeWidth="1" />
            <line x1="6" y1="8" x2="20" y2="8" stroke="#d97706" strokeWidth="0.8" />
            <line x1="6" y1="12" x2="20" y2="12" stroke="#d97706" strokeWidth="0.8" />
            <line x1="6" y1="16" x2="18" y2="16" stroke="#d97706" strokeWidth="0.8" />
          </g>
        )}

        {prop === 'gold_trophy' && (
          <g transform="translate(62, 68)">
            <path d="M 6 4 L 18 4 L 16 14 C 15 17, 9 17, 8 14 Z" fill="#fbbf24" stroke="#d97706" strokeWidth="1" />
            <rect x="10" y="15" width="4" height="6" fill="#f59e0b" />
            <rect x="7" y="21" width="10" height="4" rx="1" fill="#78350f" />
            {/* Handles */}
            <path d="M 6 6 Q 2 9 6 12" fill="none" stroke="#d97706" strokeWidth="1.2" />
            <path d="M 18 6 Q 22 9 18 12" fill="none" stroke="#d97706" strokeWidth="1.2" />
          </g>
        )}
      </g>
    </svg>
  );
}
