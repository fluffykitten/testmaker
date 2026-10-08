# Shared Layout Components

This document contains the shared layout structures, shells, and persistent wrappers across the application.

---

## 1. App Shell & Navigation Header (`src/App.tsx` Shell)
- **File**: `src/App.tsx`
- **Description**: The primary application layout shell for educators, featuring dual-logo Cambridge & ICM branding, view-switching navigation tabs, test builder count badge, mobile safe-area paddings, and footer credentials.

```tsx
<div className="app-root">
  {/* Onboarding Tutorial Overlay */}
  <OnboardingTutorial restartSignal={tutorialRestartSignal} />

  {/* Settings Modal */}
  <SettingsModal
    isOpen={isSettingsOpen}
    onClose={() => setIsSettingsOpen(false)}
    onRestartTutorial={() => setTutorialRestartSignal((s) => s + 1)}
    onLockApp={handleLockApp}
    onOpenAdvancedSettings={() => setCurrentPage('advanced_settings')}
  />

  {/* Top Navigation Bar */}
  <nav className="navbar">
    <div className="navbar-inner">
      <div className="nav-logo" onClick={() => setCurrentPage('home')} style={{ cursor: 'pointer' }}>
        <div className="nav-brand-logos">
          <div className="nav-logo-badge" title="Insan Cendekia Madani">
            <img src={ICM_LOGO_PATH} alt="ICM" className="nav-logo-img" />
          </div>
          <div className="nav-logo-badge" title="Cambridge Assessment International Education">
            <img src={CAMBRIDGE_LOGO_PATH} alt="Cambridge" className="nav-logo-img" />
          </div>
        </div>
        <div className="nav-brand-text">
          <span className="nav-title">ICM Exam Platform</span>
          <span className="nav-subtitle">Cambridge International School</span>
        </div>
      </div>

      <div className="nav-center">
        <button
          className={`nav-tab ${currentPage === 'home' ? 'nav-tab--active' : ''}`}
          onClick={() => setCurrentPage('home')}
          id="nav-home"
        >
          Dashboard
        </button>
        <button
          className={`nav-tab ${currentPage === 'bank' ? 'nav-tab--active' : ''}`}
          onClick={() => setCurrentPage('bank')}
          id="nav-bank"
        >
          Question Bank
        </button>
        <button
          className={`nav-tab ${currentPage === 'builder' ? 'nav-tab--active' : ''}`}
          onClick={() => setCurrentPage('builder')}
          id="nav-builder"
        >
          Test Builder
          {selectedCount > 0 && <span className="nav-tab-badge">{selectedCount}</span>}
        </button>
        <button
          className={`nav-tab ${currentPage === 'saved' ? 'nav-tab--active' : ''}`}
          onClick={() => setCurrentPage('saved')}
          id="nav-saved"
        >
          Saved Tests
        </button>
        <button
          className={`nav-tab ${currentPage === 'quizzes' ? 'nav-tab--active' : ''}`}
          onClick={() => setCurrentPage('quizzes')}
          id="nav-quizzes"
        >
          Interactive Quizzes
        </button>
        <button
          className={`nav-tab ${currentPage === 'upload' ? 'nav-tab--active' : ''}`}
          onClick={() => setCurrentPage('upload')}
          id="nav-upload"
        >
          Upload Papers
        </button>
      </div>

      <div className="nav-right">
        <button
          type="button"
          className="nav-portal-switch-btn"
          onClick={() => setAppMode('portal')}
          title="Switch to Student Quiz Portal"
        >
          🎓 Student Portal
        </button>

        <div className="nav-institution-pill" title="Insan Cendekia Madani • Cambridge International School">
          <span className="nav-institution-icon">🏛️</span>
          <span className="nav-institution-name">ICM • Cambridge Centre</span>
        </div>

        <button
          type="button"
          className="nav-settings-btn"
          onClick={() => setIsSettingsOpen(true)}
          title="Settings & Appearance"
        >
          ⚙️
        </button>

        <ConnectionStatus />
      </div>
    </div>
  </nav>

  {/* Dynamic Page Routed Surface */}
  <main className="main-content">
    {/* Page components rendered here */}
  </main>

  {/* Institutional Footer */}
  <footer className="app-footer">
    <div className="footer-inner">
      <div className="footer-brand">
        <div className="footer-logos">
          <img src={ICM_LOGO_PATH} alt="ICM" className="footer-logo-img" />
          <div className="footer-logo-divider" />
          <img src={CAMBRIDGE_LOGO_PATH} alt="Cambridge Assessment" className="footer-logo-img" />
        </div>
        <p className="footer-text">
          <strong>ICM Exam Platform</strong> • Cambridge International School ID395
          <br />
          Integrated assessment authoring, live proctoring & AI examiner suite for Insan Cendekia Madani.
        </p>
      </div>
    </div>
  </footer>
</div>
```

---

## 2. Institutional Invigilator Access Gate (`PinGate`)
- **File**: `src/components/PinGate.tsx`
- **Description**: Security gateway layout wrapper protecting teacher authoring features with 6-digit PIN verification, brute-force lockout safeguards, and fallback back-to-portal navigation.

```tsx
interface PinGateProps {
  children: ReactNode;
  onBackToPortal?: () => void;
}
```

Provides a centered institutional card with dual ICM/Cambridge branding badges, numeric keypad or text inputs, auto-focus next digit, and automatic prefetch of access credentials.
