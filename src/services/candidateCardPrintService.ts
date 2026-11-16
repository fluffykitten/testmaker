// ─── Candidate Desk Card Print Service ─────────────────────────────────────────
// Generates print-ready 2x3 A4 (6 slips/page) Candidate Profile + 4-Digit PIN cards
// with institutional ICM & Cambridge logos (aspect-ratio preserved) and optional
// horizontally mirrored duplex reverse-side Examination Schedules.

import { DEFAULT_CAMBRIDGE_LOGO, DEFAULT_SCHOOL_LOGO } from '../assets/logoConstants';
import {
  type DeskCardSortMode,
  type ExamScheduleEntry,
  filterScheduleForClass,
  sortStudentsForDeskCards,
} from '../lib/examSchedule';
import type { RosterStudent } from './studentRosterService';

export type DuplexFlipEdge = 'long' | 'short';

export interface CandidateDeskCardRenderOptions {
  includeScheduleBack?: boolean;
  duplexFlip?: DuplexFlipEdge;
  sortMode?: DeskCardSortMode;
  examTitle?: string;
  schoolName?: string;
}

export function escapeHtml(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Pads a front page chunk of up to 6 slots cleanly and returns the matching
 * 6 reverse-side slots mirrored for duplex printing:
 * - 'long' (standard A4 portrait book-flip): swaps left & right columns per row [1,0, 3,2, 5,4].
 * - 'short' (vertical top-edge tumble): swaps rows top-to-bottom [4,5, 2,3, 0,1].
 */
export function mirrorDeskCardSlots<T>(
  frontPageStudents: T[],
  flipEdge: DuplexFlipEdge = 'long'
): Array<T | null> {
  const padded: Array<T | null> = Array.from({ length: 6 }, (_, i) => frontPageStudents[i] ?? null);
  if (flipEdge === 'short') {
    return [padded[4], padded[5], padded[2], padded[3], padded[0], padded[1]];
  }
  return [padded[1], padded[0], padded[3], padded[2], padded[5], padded[4]];
}

function formatSpacedPin(pin: string): string {
  const digits = String(pin || '').trim().split('');
  return digits.map((d) => escapeHtml(d)).join(' ');
}

function renderFrontCardSlot(
  student: RosterStudent | null,
  schoolName: string,
  examTitle: string
): string {
  if (!student) {
    return '<div class="desk-card-slot desk-card-slot--empty" aria-hidden="true"></div>';
  }

  const cleanRoom = student.room?.trim() || 'Room TBA';
  const cleanSeat = student.seatNumber?.trim() || '-';
  const cleanCandNum = student.candidateNumber?.trim() || '-';
  const spacedPin = formatSpacedPin(student.pin || '----');

  return `
    <div class="desk-card-slot">
      <div class="desk-card desk-card--front">
        <div class="card-header">
          <img src="${DEFAULT_SCHOOL_LOGO}" alt="ICM Logo" class="card-logo card-logo--icm" />
          <div class="card-header-center">
            <div class="card-kicker">${escapeHtml(schoolName)}</div>
            <div class="card-title">CANDIDATE CARD</div>
            <div class="card-sub">${escapeHtml(examTitle)}</div>
          </div>
          <img src="${DEFAULT_CAMBRIDGE_LOGO}" alt="Cambridge International Logo" class="card-logo card-logo--cambridge" />
        </div>

        <div class="card-location-bar">
          <div class="loc-pill loc-pill--room">
            <span class="loc-label">ROOM</span>
            <span class="loc-val">${escapeHtml(cleanRoom)}</span>
          </div>
          <div class="loc-pill loc-pill--seat">
            <span class="loc-label">SEAT</span>
            <span class="loc-val">#${escapeHtml(cleanSeat)}</span>
          </div>
        </div>

        <div class="card-profile">
          <div class="profile-row profile-row--name">
            <span class="profile-label">CANDIDATE NAME</span>
            <span class="profile-name">${escapeHtml(student.name)}</span>
          </div>
          <div class="profile-meta-grid">
            <div class="profile-meta-item">
              <span class="profile-label">CLASS</span>
              <span class="profile-val">${escapeHtml(student.class)}</span>
            </div>
            <div class="profile-meta-item">
              <span class="profile-label">CANDIDATE # / NIS</span>
              <span class="profile-val profile-val--mono">${escapeHtml(cleanCandNum)}</span>
            </div>
          </div>
        </div>

        <div class="card-pin-box">
          <div class="pin-box-left">
            <span class="pin-box-label">PERSONAL EXAM PIN</span>
            <span class="pin-box-note">Keep confidential &bull; Enter at lobby</span>
          </div>
          <div class="pin-box-digits">${spacedPin}</div>
        </div>
      </div>
    </div>
  `.trim();
}

function renderBackCardSlot(
  student: RosterStudent | null,
  scheduleEntries: ExamScheduleEntry[],
  examTitle: string
): string {
  if (!student) {
    return '<div class="desk-card-slot desk-card-slot--empty" aria-hidden="true"></div>';
  }

  const matchedEntries = filterScheduleForClass(scheduleEntries, student.class);
  const rowsHtml =
    matchedEntries.length === 0
      ? `<tr><td colspan="3" class="sched-empty">No scheduled sessions match class ${escapeHtml(student.class)}.</td></tr>`
      : matchedEntries
          .map((entry) => {
            const isPractical =
              entry.category === 'practical' || /^practical\s*:/i.test(entry.subject);
            const cleanSubj = entry.subject.replace(/^practical\s*:\s*/i, '');
            const durSuffix = entry.duration ? ` (${entry.duration})` : '';
            const badgeHtml = isPractical ? '<span class="sched-badge-prac">PRAC</span> ' : '';
            return `
              <tr class="${isPractical ? 'sched-row--prac' : ''}">
                <td class="sched-date">${escapeHtml(entry.date)}</td>
                <td class="sched-time">${escapeHtml(entry.time)}</td>
                <td class="sched-subj">${badgeHtml}${escapeHtml(cleanSubj)}${escapeHtml(durSuffix)}</td>
              </tr>
            `.trim();
          })
          .join('');

  const locationSummary = [
    student.class,
    student.room ? student.room : null,
    student.seatNumber ? `Seat #${student.seatNumber}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return `
    <div class="desk-card-slot desk-card-slot--back">
      <div class="desk-card desk-card--back">
        <div class="back-header">
          <div class="back-title-wrap">
            <span class="back-title">EXAMINATION SCHEDULE</span>
            <span class="back-subtitle">${escapeHtml(examTitle)}</span>
          </div>
          <span class="back-class-pill">${escapeHtml(student.class)}</span>
        </div>

        <div class="back-candidate-strip">
          <span class="back-cand-name">${escapeHtml(student.name)}</span>
          <span class="back-cand-loc">${escapeHtml(locationSummary)}</span>
        </div>

        <table class="sched-table">
          <thead>
            <tr>
              <th style="width: 32%;">Day / Date</th>
              <th style="width: 29%;">Time</th>
              <th style="width: 39%;">Subject (Dur.)</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    </div>
  `.trim();
}

/**
 * Renders a complete print-ready HTML document formatted strictly in 2x3 A4 portrait grids
 * (6 cards per page) with optional horizontally mirrored duplex schedule back pages.
 */
export function renderCandidateDeskCardsHtml(
  students: RosterStudent[],
  scheduleEntries: ExamScheduleEntry[],
  options: CandidateDeskCardRenderOptions = {}
): string {
  const includeBack = options.includeScheduleBack ?? true;
  const duplexFlip: DuplexFlipEdge = options.duplexFlip || 'long';
  const sortMode: DeskCardSortMode = options.sortMode || 'room_seat';
  const examTitle = options.examTitle?.trim() || '1st Semester Exam • A.Y. 2026/2027';
  const schoolName = options.schoolName?.trim() || 'SMA INSAN CENDEKIA MADANI';

  const sortedStudents = sortStudentsForDeskCards(students, sortMode);
  const pages = chunkArray(sortedStudents, 6);

  const sheetsHtml = pages
    .map((pageStudents, pageIdx) => {
      const frontSlots: Array<RosterStudent | null> = Array.from(
        { length: 6 },
        (_, i) => pageStudents[i] ?? null
      );
      const frontCardsHtml = frontSlots
        .map((st) => renderFrontCardSlot(st, schoolName, examTitle))
        .join('\n');

      const frontSheet = `
        <section class="desk-card-sheet desk-card-sheet--front" data-sheet-index="${pageIdx + 1}">
          ${frontCardsHtml}
        </section>
      `;

      if (!includeBack) return frontSheet;

      const backSlots = mirrorDeskCardSlots(pageStudents, duplexFlip);
      const backCardsHtml = backSlots
        .map((st) => renderBackCardSlot(st, scheduleEntries, examTitle))
        .join('\n');

      const backSheet = `
        <section class="desk-card-sheet desk-card-sheet--back" data-sheet-index="${pageIdx + 1}">
          ${backCardsHtml}
        </section>
      `;

      return `${frontSheet}\n${backSheet}`;
    })
    .join('\n');

  const frontPageCount = pages.length;
  const totalPaperCount = includeBack ? frontPageCount * 2 : frontPageCount;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Candidate Desk Cards (${sortedStudents.length}) — ${escapeHtml(examTitle)}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 7mm;
    }

    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }

    body {
      margin: 0;
      padding: 0;
      font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
      background: #e2e8f0;
      color: #0f172a;
    }

    .print-toolbar {
      position: sticky;
      top: 0;
      z-index: 100;
      background: #0f172a;
      color: #f8fafc;
      padding: 10px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      flex-wrap: wrap;
      box-shadow: 0 4px 14px rgba(15, 23, 42, 0.25);
    }

    .toolbar-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .toolbar-title {
      font-size: 14px;
      font-weight: 800;
      letter-spacing: 0.01em;
    }

    .toolbar-meta {
      font-size: 12px;
      color: #cbd5e1;
    }

    .toolbar-controls {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .toolbar-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.16);
      color: #f8fafc;
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 12px;
      font-weight: 600;
    }

    .toolbar-btn {
      background: #4f46e5;
      color: #ffffff;
      border: none;
      border-radius: 8px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
    }

    .toolbar-btn:hover {
      background: #4338ca;
    }

    .sheets-container {
      padding: 16px 0 32px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
    }

    .desk-card-sheet {
      width: 196mm;
      height: 282mm;
      background: #ffffff;
      padding: 1mm;
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      grid-template-rows: repeat(3, 1fr);
      gap: 3mm;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14);
      page-break-after: always;
      break-after: page;
    }

    .desk-card-sheet:last-child {
      page-break-after: auto;
      break-after: auto;
    }

    .desk-card-slot {
      border: 1px dashed #94a3b8;
      border-radius: 6px;
      padding: 2.2mm;
      display: flex;
      background: #ffffff;
      overflow: hidden;
    }

    .desk-card-slot--empty {
      border-color: #e2e8f0;
      background: transparent;
    }

    .desk-card {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      border: 1px solid #cbd5e1;
      border-radius: 5px;
      padding: 2.6mm 3mm;
      overflow: hidden;
    }

    /* ── Front Card ── */
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
      padding-bottom: 1.8mm;
      border-bottom: 1.5px solid #1e3a8a;
    }

    .card-logo {
      display: block;
      width: auto;
      object-fit: contain;
      flex-shrink: 0;
    }

    .card-logo--icm {
      height: 18px;
      max-width: 58px;
    }

    .card-logo--cambridge {
      height: 16px;
      max-width: 56px;
    }

    .card-header-center {
      text-align: center;
      flex: 1;
      min-width: 0;
    }

    .card-kicker {
      font-size: 5.5pt;
      font-weight: 700;
      letter-spacing: 0.04em;
      color: #475569;
      text-transform: uppercase;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .card-title {
      font-size: 8.2pt;
      font-weight: 900;
      color: #1e3a8a;
      letter-spacing: 0.03em;
      line-height: 1.15;
    }

    .card-sub {
      font-size: 5.8pt;
      font-weight: 600;
      color: #64748b;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .card-location-bar {
      display: flex;
      align-items: stretch;
      gap: 5px;
      margin-top: 1.5mm;
    }

    .loc-pill {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      padding: 3.5px 8px;
      border-radius: 4px;
      font-size: 7.5pt;
      line-height: 1.1;
    }

    .loc-pill--room {
      flex: 1;
      background: #ffffff;
      border: 1px solid #cbd5e1;
      color: #0f172a;
    }

    .loc-pill--seat {
      background: #ffffff;
      border: 1px solid #1e3a8a;
      color: #1e3a8a;
      min-width: 60px;
    }

    .loc-label {
      font-size: 6pt;
      font-weight: 800;
      letter-spacing: 0.05em;
      color: #475569;
      white-space: nowrap;
    }

    .loc-val {
      font-weight: 800;
      white-space: nowrap;
      color: #0f172a;
    }

    .loc-pill--seat .loc-val {
      color: #1e3a8a;
    }

    .card-profile {
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 3px;
      padding: 1.5mm 0;
    }

    .profile-row--name {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .profile-label {
      font-size: 5.6pt;
      font-weight: 700;
      letter-spacing: 0.05em;
      color: #64748b;
      text-transform: uppercase;
    }

    .profile-name {
      font-size: 10pt;
      font-weight: 800;
      color: #0f172a;
      line-height: 1.15;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .profile-meta-grid {
      display: grid;
      grid-template-columns: 1fr 1.1fr;
      gap: 6px;
      padding-top: 2px;
      border-top: 1px dashed #e2e8f0;
    }

    .profile-meta-item {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .profile-val {
      font-size: 8.3pt;
      font-weight: 700;
      color: #1e293b;
    }

    .profile-val--mono {
      font-family: ui-monospace, 'Cascadia Mono', 'Consolas', monospace;
      letter-spacing: 0.02em;
    }

    .card-pin-box {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      background: #eef2ff;
      border: 1.5px solid #6366f1;
      border-radius: 5px;
      padding: 3.5px 8px;
    }

    .pin-box-left {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .pin-box-label {
      font-size: 6.2pt;
      font-weight: 800;
      color: #3730a3;
      letter-spacing: 0.04em;
    }

    .pin-box-note {
      font-size: 5.5pt;
      color: #4f46e5;
    }

    .pin-box-digits {
      font-family: ui-monospace, 'Cascadia Mono', 'Consolas', monospace;
      font-size: 14.5pt;
      font-weight: 900;
      letter-spacing: 2px;
      color: #1e1b4b;
      background: #ffffff;
      border: 1px solid #c7d2fe;
      border-radius: 4px;
      padding: 2px 8px;
      white-space: nowrap;
    }

    /* ── Back Card (Duplex Timetable) ── */
    .desk-card--back {
      justify-content: flex-start;
      gap: 3px;
      padding: 2.2mm 2.5mm;
    }

    .back-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding-bottom: 2px;
      border-bottom: 1.5px solid #1e3a8a;
    }

    .back-title-wrap {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .back-title {
      font-size: 7.4pt;
      font-weight: 900;
      color: #1e3a8a;
      letter-spacing: 0.03em;
    }

    .back-subtitle {
      font-size: 5.6pt;
      font-weight: 600;
      color: #64748b;
    }

    .back-class-pill {
      font-size: 6.8pt;
      font-weight: 800;
      color: #1e3a8a;
      background: #e0e7ff;
      border: 1px solid #c7d2fe;
      border-radius: 4px;
      padding: 1.5px 6px;
      white-space: nowrap;
    }

    .back-candidate-strip {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-size: 5.8pt;
      color: #334155;
      background: #f8fafc;
      padding: 1.5px 4px;
      border-radius: 3px;
      border: 1px solid #e2e8f0;
    }

    .back-cand-name {
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 48%;
    }

    .back-cand-loc {
      font-weight: 600;
      color: #475569;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .sched-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 6.2pt;
      line-height: 1.16;
      table-layout: fixed;
    }

    .sched-table th {
      background: #1e293b;
      color: #ffffff;
      font-weight: 700;
      text-align: left;
      padding: 2px 3px;
      font-size: 5.8pt;
      letter-spacing: 0.02em;
    }

    .sched-table td {
      padding: 1.5px 3px;
      border-bottom: 1px solid #e2e8f0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: #0f172a;
    }

    .sched-table tbody tr:nth-child(even) td {
      background: #f8fafc;
    }

    .sched-row--prac td {
      background: #eff6ff !important;
      color: #1e3a8a;
      font-weight: 600;
    }

    .sched-badge-prac {
      display: inline-block;
      background: #2563eb;
      color: #ffffff;
      font-size: 4.8pt;
      font-weight: 800;
      padding: 0.5px 2.5px;
      border-radius: 2px;
      vertical-align: middle;
    }

    .sched-empty {
      text-align: center;
      color: #64748b;
      padding: 12px 4px !important;
      white-space: normal !important;
    }

    @media print {
      body {
        background: #ffffff;
      }
      .no-print {
        display: none !important;
      }
      .sheets-container {
        padding: 0;
        gap: 0;
      }
      .desk-card-sheet {
        box-shadow: none;
        margin: 0;
      }
    }
  </style>
</head>
<body>
  <div class="print-toolbar no-print">
    <div class="toolbar-info">
      <div class="toolbar-title">🪪 Printable Examination Candidate Desk Cards (2 &times; 3 A4 Grid)</div>
      <div class="toolbar-meta">
        ${sortedStudents.length} candidate${sortedStudents.length === 1 ? '' : 's'} &middot;
        ${totalPaperCount} printable A4 page${totalPaperCount === 1 ? '' : 's'}
        (${includeBack ? `Duplex ${duplexFlip === 'short' ? 'Short-Edge' : 'Long-Edge'} Mirrored` : 'Front Side Only'})
      </div>
    </div>
    <div class="toolbar-controls">
      <span class="toolbar-pill">Sort: ${sortMode === 'room_seat' ? 'Room & Seat #' : 'Class & Cand #'}</span>
      <span class="toolbar-pill">Tip: Print A4 Portrait at 100% Scale${includeBack ? ` (${duplexFlip === 'short' ? 'Flip on Short Edge' : 'Flip on Long Edge'})` : ''}</span>
      <button type="button" class="toolbar-btn" onclick="window.print()">🖨️ Print Desk Cards</button>
    </div>
  </div>

  <main class="sheets-container">
    ${sheetsHtml}
  </main>
</body>
</html>`;
}

/**
 * Opens the print preview window with the formatted 2x3 A4 Candidate Desk Cards.
 */
export function openCandidateDeskCardsPrintWindow(
  students: RosterStudent[],
  scheduleEntries: ExamScheduleEntry[],
  options: CandidateDeskCardRenderOptions = {}
): { ok: boolean; error?: string } {
  if (!students || students.length === 0) {
    return { ok: false, error: 'No candidates match the selected filter to print.' };
  }

  const html = renderCandidateDeskCardsHtml(students, scheduleEntries, options);
  const printWin = window.open('', '_blank', 'width=1050,height=850');
  if (!printWin) {
    return {
      ok: false,
      error: 'Pop-up window was blocked by your browser. Please allow pop-ups for this site and try again.',
    };
  }

  printWin.document.open();
  printWin.document.write(html);
  printWin.document.close();
  printWin.focus();
  return { ok: true };
}
