# Route & Navigation Architecture

The ICM Exam Platform uses state-driven and URL search-parameter-synchronized client routing in `src/App.tsx`, paired with mode switches for specialized execution surfaces.

## Modes (`AppMode`)

| Mode | Trigger / Parameter | Component | Layout / Gate | Description |
|---|---|---|---|---|
| `portal` | Default root route (`?`), or `onExit()` | `src/pages/PortalLandingPage.tsx` | Minimalist Dual Split Shell | Institutional portal for students to enter exam tokens or check results, and entry point for educators. |
| `student_quiz` | `?quiz=<code>` or `?code=<code>` or launching from builder/manager | `src/components/StudentQuizDispatcher.tsx` -> `src/pages/StudentQuizRunner.tsx` | Fullscreen Lockdown Exam Shell | Timed Cambridge examination environment with KaTeX rendering, audio alerts, periodic table, and proctor violation trackers. |
| `game_host` | Teacher launching live multiplayer session from `QuizManagerPage` | `src/pages/GameHostController.tsx` | Live Host Controller Screen | Real-time classroom arena leaderboards and multiplayer proctoring. |
| `teacher` | Clicking "Enter Teacher Suite" on portal | `src/App.tsx` (inner layout) | `PinGate` (6-digit PIN) + `AppNav` + `AppFooter` | Authoring, question banking, test assembling, AI past paper ingestion, and gradebook management. |

---

## Teacher Suite Sub-Pages (`Page` state in `teacher` mode)

| Page Key | Title / Navigation Tab | Component File | Summary |
|---|---|---|---|
| `home` | **Dashboard** | `HomePage` in `src/App.tsx` | Hero introduction, 4-step Cambridge examination workflow pipeline, platform statistics ribbon, and quick actions. |
| `bank` | **Question Bank** | `src/pages/QuestionBankPage.tsx` | Filterable database of past exam questions, formula search, tag hierarchies, bulk audio generation, and question editing. |
| `builder` | **Test Builder** | `src/pages/TestBuilderPage.tsx` | Exam assembler with Assessment Objective (AO1/AO2/AO3) mark balancer, syllabus coverage meters, live test run previews, and Word/PDF export. |
| `saved` | **Saved Tests** | `src/pages/SavedTestsPage.tsx` | Local and cloud catalog of assembled tests with instant reload into builder, clone, and export operations. |
| `quizzes` | **Interactive Quizzes** | `src/pages/QuizManagerPage.tsx` | Published test tokens, live proctoring dashboard, response submissions, remarking overrides, and multi-sheet Excel gradebook export. |
| `upload` | **Upload Papers** | `src/pages/UploadPage.tsx` | Multimodal past paper PDF ingestion pipeline powered by Gemini AI with automated question splitting and diagram bounding box cropper. |
| `advanced_settings` | **Advanced Settings** | `src/pages/AdvancedSettingsPage.tsx` | Supabase cloud credentials, Google Drive backup sync, school class roster sync, and invigilator master PIN configuration. |

---

## Router / App Shell Logic (`src/App.tsx` snippet)

```tsx
export type Page = 'home' | 'bank' | 'builder' | 'saved' | 'quizzes' | 'upload' | 'advanced_settings';
export type AppMode = 'portal' | 'teacher' | 'student_quiz' | 'game_host';

function App() {
  const [appMode, setAppMode] = useState<AppMode>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('quiz') || params.get('code')) return 'student_quiz';
    return 'portal';
  });

  const [currentPage, setCurrentPage] = useState<Page>(() => {
    const params = new URLSearchParams(window.location.search);
    if (
      params.get('page') === 'advanced-settings' ||
      params.get('page') === 'advanced' ||
      window.location.hash === '#advanced-settings'
    ) {
      return 'advanced_settings';
    }
    return 'home';
  });

  // Mode 1: Minimalist Portal Landing Page
  if (appMode === 'portal') {
    return (
      <PortalLandingPage
        onJoinQuiz={(code) => {
          setActiveQuizCode(code);
          setTestRunInitialMode('exam');
          setAppMode('student_quiz');
        }}
        onEnterTeacherSuite={() => setAppMode('teacher')}
      />
    );
  }

  // Mode 2: Student Interactive Quiz Runner
  if (appMode === 'student_quiz') {
    return (
      <ErrorBoundary onReset={() => setAppMode('portal')}>
        <StudentQuizDispatcher
          codeOrId={activeQuizCode}
          onExit={() => setAppMode('portal')}
        />
      </ErrorBoundary>
    );
  }

  // Mode 3: Teacher Multi-Page Suite (PIN Protected)
  return (
    <PinGate onBackToPortal={() => setAppMode('portal')}>
      <div className="app-root">
        <nav className="navbar">...</nav>
        <main className="main-content">
          {currentPage === 'home' && <HomePage onNavigate={setCurrentPage} />}
          {currentPage === 'bank' && <QuestionBankPage />}
          {currentPage === 'builder' && <TestBuilderPage />}
          {currentPage === 'saved' && <SavedTestsPage />}
          {currentPage === 'quizzes' && <QuizManagerPage />}
          {currentPage === 'upload' && <UploadPage />}
          {currentPage === 'advanced_settings' && <AdvancedSettingsPage />}
        </main>
        <footer className="app-footer">...</footer>
      </div>
    </PinGate>
  );
}
```
