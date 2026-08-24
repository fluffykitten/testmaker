// ─── Standalone Offline HTML Quiz Export Service ────────────────────────────
// Bundles the entire exam into a single, self-contained interactive .html file
// that students can open in any browser offline without internet or server access.

import { saveAs } from 'file-saver';
import type { Question } from '../types/database';
import type { ExamHeaderConfig } from './testBuilderService';

export function exportOfflineInteractiveHtmlQuiz(
  headerConfig: ExamHeaderConfig,
  questions: Question[]
): void {
  const safeTitle = (headerConfig.title || 'Interactive_Quiz').replace(/[^a-zA-Z0-9_-]/g, '_');
  const duration = headerConfig.durationMinutes || 45;
  const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);

  const serializedQuestions = JSON.stringify(
    questions.map((q, idx) => ({
      id: q.id || `q_${idx + 1}`,
      number: idx + 1,
      text: q.question_text || '',
      options: q.options || [],
      subQuestions: q.sub_questions || [],
      marks: q.marks || 1,
      topic: q.topic || 'General',
      subTopic: q.sub_topic || '',
      diagramUrl: q.diagram_url || '',
      markScheme: q.mark_scheme,
      guidance: q.mark_scheme?.guidance || [],
      misconceptions: q.mark_scheme?.common_misconceptions || [],
    }))
  );

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${headerConfig.title || 'Interactive Assessment'}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css" />
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/contrib/auto-render.min.js"></script>
  <style>
    :root {
      --primary: #4f46e5;
      --primary-hover: #4338ca;
      --bg: #0f172a;
      --surface: #1e293b;
      --surface-elevated: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --border: #334155;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; min-height: 100vh; display: flex; flex-direction: column; }
    
    /* Top Bar */
    .header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 24px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 50; }
    .header-title { font-size: 1.125rem; font-weight: 800; color: var(--text); }
    .header-sub { font-size: 0.8125rem; color: var(--text-muted); }
    .timer-badge { background: #fee2e2; color: #991b1b; padding: 6px 14px; border-radius: 999px; font-weight: 800; font-size: 1rem; display: flex; align-items: center; gap: 6px; }
    .timer-badge.normal { background: rgba(99, 102, 241, 0.15); color: #818cf8; }

    /* Layout */
    .main-layout { display: grid; grid-template-columns: 1fr 300px; gap: 20px; max-width: 1200px; margin: 20px auto; padding: 0 20px; width: 100%; flex: 1; }
    @media (max-width: 860px) { .main-layout { grid-template-columns: 1fr; } }

    /* Card */
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 24px; }
    .q-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
    .q-badge { background: rgba(99, 102, 241, 0.15); color: #818cf8; padding: 4px 10px; border-radius: 8px; font-weight: 700; font-size: 0.8125rem; }
    .q-marks { font-weight: 700; color: var(--text-muted); font-size: 0.875rem; }
    .q-text { font-size: 1.0625rem; margin-bottom: 20px; line-height: 1.6; }
    
    /* MCQ Choices */
    .choice-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }
    .choice-btn { background: var(--surface-elevated); border: 1.5px solid var(--border); color: var(--text); padding: 12px 16px; border-radius: 10px; text-align: left; font-size: 0.9375rem; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 10px; }
    .choice-btn:hover { border-color: var(--primary); background: rgba(79, 70, 229, 0.1); }
    .choice-btn.selected { border-color: var(--primary); background: rgba(79, 70, 229, 0.2); font-weight: 600; }
    
    /* Structured Answer Box */
    .text-ans-area { width: 100%; min-height: 120px; background: var(--surface-elevated); border: 1px solid var(--border); border-radius: 10px; padding: 12px; color: var(--text); font-family: inherit; font-size: 0.9375rem; resize: vertical; margin-bottom: 20px; }
    
    /* Navigation Bar */
    .nav-actions { display: flex; justify-content: space-between; align-items: center; margin-top: 20px; }
    .btn { padding: 10px 18px; border-radius: 10px; font-weight: 700; font-size: 0.875rem; cursor: pointer; border: none; transition: all 0.2s; }
    .btn-primary { background: var(--primary); color: white; }
    .btn-primary:hover { background: var(--primary-hover); }
    .btn-secondary { background: var(--surface-elevated); color: var(--text); border: 1px solid var(--border); }
    .btn-flag { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }

    /* Navigator Sidebar */
    .nav-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-top: 14px; }
    .nav-cell { aspect-ratio: 1; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.875rem; cursor: pointer; background: var(--surface-elevated); border: 1px solid var(--border); color: var(--text-muted); }
    .nav-cell.current { border-color: var(--primary); box-shadow: 0 0 0 2px var(--primary); }
    .nav-cell.answered { background: var(--primary); color: white; border-color: var(--primary); }
    .nav-cell.flagged { border-color: #fbbf24; color: #fbbf24; }

    /* Results Screen */
    .results-wrap { max-width: 800px; margin: 40px auto; padding: 30px; background: var(--surface); border-radius: 20px; border: 1px solid var(--border); text-align: center; }
    .score-circle { width: 140px; height: 140px; border-radius: 50%; border: 6px solid var(--primary); display: flex; flex-direction: column; align-items: center; justify-content: center; margin: 20px auto; }
    .score-num { font-size: 2.25rem; font-weight: 900; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="header-title">${headerConfig.title || 'Interactive Assessment'}</div>
      <div class="header-sub">${headerConfig.subject || 'General'} • ${questions.length} Questions • ${totalMarks} Marks</div>
    </div>
    <div id="timerBadge" class="timer-badge normal">⏱️ <span id="timerText">45:00</span></div>
  </div>

  <div id="quizContainer" class="main-layout">
    <!-- Main Question View -->
    <div class="card">
      <div class="q-header">
        <span id="qBadge" class="q-badge">Question 1</span>
        <span id="qMarks" class="q-marks">1 mark</span>
      </div>
      <div id="qText" class="q-text">Loading question...</div>
      <div id="qInputs"></div>

      <div class="nav-actions">
        <button id="prevBtn" class="btn btn-secondary" onclick="prevQuestion()">← Previous</button>
        <button id="flagBtn" class="btn btn-flag" onclick="toggleFlag()">⭐ Flag</button>
        <button id="nextBtn" class="btn btn-primary" onclick="nextQuestion()">Next →</button>
      </div>
    </div>

    <!-- Question Navigator Grid -->
    <div class="card" style="height: fit-content;">
      <h3 style="font-size: 0.9375rem; font-weight: 800; margin-bottom: 6px;">Question Navigator</h3>
      <div id="navigatorGrid" class="nav-grid"></div>
      <button onclick="submitExam()" class="btn btn-primary" style="width: 100%; margin-top: 20px; background: #10b981;">Submit Assessment</button>
    </div>
  </div>

  <div id="resultsContainer" class="results-wrap" style="display: none;">
    <h2 style="font-size: 1.75rem; font-weight: 900; margin-bottom: 8px;">Assessment Completed! 🎉</h2>
    <p style="color: var(--text-muted);">Here is your performance summary:</p>
    <div class="score-circle">
      <span id="resScore" class="score-num">0%</span>
      <span id="resFraction" style="font-size: 0.8125rem; color: var(--text-muted);">0 / 0 marks</span>
    </div>
    <button onclick="window.location.reload()" class="btn btn-primary" style="margin-top: 10px;">Retry Assessment</button>
  </div>

  <script>
    const questions = ${serializedQuestions};
    let currentIndex = 0;
    const answers = {};
    const flags = new Set();
    let timeLeft = ${duration} * 60;

    function init() {
      renderNavigator();
      showQuestion(0);
      startTimer();
    }

    function renderNavigator() {
      const grid = document.getElementById('navigatorGrid');
      grid.innerHTML = '';
      questions.forEach((q, idx) => {
        const cell = document.createElement('div');
        cell.className = 'nav-cell' + (idx === currentIndex ? ' current' : '') + (answers[idx] !== undefined ? ' answered' : '') + (flags.has(idx) ? ' flagged' : '');
        cell.innerText = idx + 1;
        cell.onclick = () => showQuestion(idx);
        grid.appendChild(cell);
      });
    }

    function showQuestion(idx) {
      currentIndex = idx;
      const q = questions[idx];
      document.getElementById('qBadge').innerText = 'Question ' + (idx + 1) + ' of ' + questions.length;
      document.getElementById('qMarks').innerText = '[' + q.marks + ' mark' + (q.marks > 1 ? 's' : '') + ']';
      document.getElementById('qText').innerHTML = q.text;

      const container = document.getElementById('qInputs');
      container.innerHTML = '';

      if (q.options && q.options.length > 0) {
        const list = document.createElement('div');
        list.className = 'choice-list';
        q.options.forEach((opt, oIdx) => {
          const btn = document.createElement('button');
          btn.className = 'choice-btn' + (answers[idx] === oIdx ? ' selected' : '');
          btn.innerHTML = '<strong>' + String.fromCharCode(65 + oIdx) + '</strong> ' + opt;
          btn.onclick = () => { answers[idx] = oIdx; showQuestion(idx); };
          list.appendChild(btn);
        });
        container.appendChild(list);
      } else {
        const ta = document.createElement('textarea');
        ta.className = 'text-ans-area';
        ta.placeholder = 'Type your solution or answer here...';
        ta.value = answers[idx] || '';
        ta.oninput = (e) => { answers[idx] = e.target.value; renderNavigator(); };
        container.appendChild(ta);
      }

      document.getElementById('prevBtn').style.visibility = idx === 0 ? 'hidden' : 'visible';
      document.getElementById('nextBtn').innerText = idx === questions.length - 1 ? 'Finish →' : 'Next →';

      renderNavigator();
      if (window.renderMathInElement) {
        renderMathInElement(document.getElementById('qText'), { delimiters: [{left: '$$', right: '$$', display: true}, {left: '$', right: '$', display: false}] });
        renderMathInElement(container, { delimiters: [{left: '$$', right: '$$', display: true}, {left: '$', right: '$', display: false}] });
      }
    }

    function nextQuestion() {
      if (currentIndex < questions.length - 1) showQuestion(currentIndex + 1);
      else submitExam();
    }

    function prevQuestion() {
      if (currentIndex > 0) showQuestion(currentIndex - 1);
    }

    function toggleFlag() {
      if (flags.has(currentIndex)) flags.delete(currentIndex);
      else flags.add(currentIndex);
      renderNavigator();
    }

    function startTimer() {
      setInterval(() => {
        if (timeLeft <= 0) return;
        timeLeft--;
        const m = Math.floor(timeLeft / 60);
        const s = timeLeft % 60;
        document.getElementById('timerText').innerText = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
      }, 1000);
    }

    function submitExam() {
      if (!confirm('Are you ready to submit your assessment?')) return;
      document.getElementById('quizContainer').style.display = 'none';
      document.getElementById('timerBadge').style.display = 'none';
      document.getElementById('resultsContainer').style.display = 'block';

      let mcqScore = 0;
      let totalMcq = 0;
      questions.forEach((q, idx) => {
        if (q.options && q.options.length > 0) {
          totalMcq += (q.marks || 1);
          if (answers[idx] !== undefined) mcqScore += (q.marks || 1);
        }
      });

      const pct = totalMcq > 0 ? Math.round((mcqScore / totalMcq) * 100) : 100;
      document.getElementById('resScore').innerText = pct + '%';
      document.getElementById('resFraction').innerText = mcqScore + ' / ' + totalMcq + ' marks (MCQ Verified)';
    }

    window.onload = init;
  </script>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  saveAs(blob, `${safeTitle}_Interactive_Offline.html`);
}
