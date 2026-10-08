import React from 'react';

/**
 * Subtle school and academic vector doodles for the ICM Exam Platform background.
 * Rendered with ultra-delicate emerald line art that sits unobtrusively behind portal cards.
 */
export const SchoolDoodlesBackground: React.FC = () => {
  return (
    <div className="portal-doodles-layer" aria-hidden="true">
      {/* 1. Mortarboard Cap (Top Left) */}
      <div className="portal-doodle portal-doodle--cap portal-doodle--float-1" style={{ top: '5%', left: '4%' }}>
        <svg width="68" height="68" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
          <path d="M6 12v5c3 3 9 3 12 0v-5" />
        </svg>
      </div>

      {/* 2. Chemistry Flask (Top Right) */}
      <div className="portal-doodle portal-doodle--flask portal-doodle--float-2" style={{ top: '7%', right: '5%' }}>
        <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 2v5.5L4.5 19A2 2 0 0 0 6.2 22h11.6a2 2 0 0 0 1.7-3L14 7.5V2" />
          <path d="M8.5 2h7M7 16h10" />
          <circle cx="10" cy="18.5" r="0.8" fill="currentColor" />
          <circle cx="13" cy="15" r="0.6" fill="currentColor" />
          <circle cx="14.5" cy="18" r="0.8" fill="currentColor" />
        </svg>
      </div>

      {/* 3. Atom Physics Orbit (Upper Left) */}
      <div className="portal-doodle portal-doodle--atom portal-doodle--float-2" style={{ top: '24%', left: '2%' }}>
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="2" fill="currentColor" />
          <ellipse cx="12" cy="12" rx="9.5" ry="4" transform="rotate(30 12 12)" />
          <ellipse cx="12" cy="12" rx="9.5" ry="4" transform="rotate(-30 12 12)" />
          <ellipse cx="12" cy="12" rx="9.5" ry="4" transform="rotate(90 12 12)" />
        </svg>
      </div>

      {/* 4. Set Square Geometry Triangle (Upper Right) */}
      <div className="portal-doodle portal-doodle--ruler portal-doodle--float-1" style={{ top: '26%', right: '3%' }}>
        <svg width="58" height="58" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 21h18L3 3v18z" />
          <path d="M7 17h6L7 11v6z" />
          <path d="M7 21v-2M11 21v-2M15 21v-2M3 17h2M3 13h2M3 9h2" />
        </svg>
      </div>

      {/* 5. Open Textbook (Middle Left) */}
      <div className="portal-doodle portal-doodle--book portal-doodle--float-1" style={{ top: '48%', left: '3%' }}>
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
          <path d="M6 7h2M6 11h2M16 7h2M16 11h2" />
        </svg>
      </div>

      {/* 6. Microscope (Middle Right) */}
      <div className="portal-doodle portal-doodle--microscope portal-doodle--float-2" style={{ top: '49%', right: '2%' }}>
        <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 18h12M9 22h6M12 18v4" />
          <path d="M9 14a5 5 0 0 0 6-6" />
          <path d="M12 3l4 4-2.5 2.5-4-4L12 3z" />
          <circle cx="9" cy="8" r="1.5" />
          <path d="M7 14h6" />
        </svg>
      </div>

      {/* 7. Pencil & Drafting Tool (Lower Mid Left) */}
      <div className="portal-doodle portal-doodle--pencil portal-doodle--float-2" style={{ top: '70%', left: '3.5%' }}>
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
          <path d="M15 5l4 4" />
          <path d="M9 11l4 4" />
        </svg>
      </div>

      {/* 8. Math Formula (Sigma & Pi) (Lower Mid Right) */}
      <div className="portal-doodle portal-doodle--math portal-doodle--float-1" style={{ top: '68%', right: '3.5%' }}>
        <svg width="62" height="62" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 5h8l-5 7 5 7H4" />
          <path d="M15 11h7M17 11v8M20 11v8" />
          <circle cx="16" cy="6" r="0.7" fill="currentColor" />
          <path d="M18 5l2 2" />
        </svg>
      </div>

      {/* 9. Lightbulb of Discovery (Bottom Left) */}
      <div className="portal-doodle portal-doodle--bulb portal-doodle--float-1" style={{ bottom: '4%', left: '6%' }}>
        <svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18h6M10 22h4" />
          <path d="M15 14c.8-1 1.5-2 1.5-3.5A4.5 4.5 0 0 0 12 6a4.5 4.5 0 0 0-4.5 4.5c0 1.5.7 2.5 1.5 3.5h6z" />
          <path d="M12 2v2M4.9 4.9l1.4 1.4M19.1 4.9l-1.4 1.4" />
        </svg>
      </div>

      {/* 10. Study Globe (Bottom Right) */}
      <div className="portal-doodle portal-doodle--globe portal-doodle--float-2" style={{ bottom: '4%', right: '6%' }}>
        <svg width="58" height="58" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="10" r="6.5" />
          <path d="M12 3.5a6.5 6.5 0 0 0 0 13M5.5 10h13" />
          <path d="M12 16.5v4M8 20.5h8" />
        </svg>
      </div>
    </div>
  );
};
