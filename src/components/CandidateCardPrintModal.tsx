import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import {
  type DeskCardSortMode,
  type ExamScheduleEntry,
  normalizeClassLabel,
  sortClassNames,
} from '../lib/examSchedule';
import {
  type CardPrintLayout,
  type CardPrintType,
  type DuplexFlipEdge,
  openCandidateDeskCardsPrintWindow,
} from '../services/candidateCardPrintService';
import {
  getExamSchedule,
  loadAndSyncExamSchedule,
} from '../services/examScheduleService';
import {
  type RosterStudent,
  getSchoolRoster,
  loadAndSyncSchoolRoster,
  saveSchoolRoster,
} from '../services/studentRosterService';
import {
  exportRosterPinSheetDocx,
  prepareRosterForPinExport,
} from '../services/rosterPinDocxService';

interface CandidateCardPrintModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialClassFilter?: string;
  initialExamTitle?: string;
  rosterOverride?: RosterStudent[];
  scheduleOverride?: ExamScheduleEntry[];
}

export function CandidateCardPrintModal({
  isOpen,
  onClose,
  initialClassFilter = 'ALL',
  initialExamTitle = '1st Semester Exam • A.Y. 2026/2027',
  rosterOverride,
  scheduleOverride,
}: CandidateCardPrintModalProps) {
  const [roster, setRoster] = useState<RosterStudent[]>(() => rosterOverride || getSchoolRoster());
  const [schedule, setSchedule] = useState<ExamScheduleEntry[]>(() => scheduleOverride || getExamSchedule());
  const [isSyncing, setIsSyncing] = useState(false);

  const [scopeType, setScopeType] = useState<'all' | 'class' | 'room'>(() =>
    initialClassFilter && initialClassFilter !== 'ALL' ? 'class' : 'all'
  );
  const [selectedClass, setSelectedClass] = useState<string>(() =>
    initialClassFilter && initialClassFilter !== 'ALL' ? initialClassFilter : ''
  );
  const [selectedRoom, setSelectedRoom] = useState<string>('');
  const [sortMode, setSortMode] = useState<DeskCardSortMode>('room_seat');
  const [cardType, setCardType] = useState<CardPrintType>('candidate_card');
  const [printLayout, setPrintLayout] = useState<CardPrintLayout>('side_by_side');
  const [duplexFlip, setDuplexFlip] = useState<DuplexFlipEdge>('long');
  const [examTitle, setExamTitle] = useState<string>(initialExamTitle);
  const [printError, setPrintError] = useState<string | null>(null);
  const [isExportingDocx, setIsExportingDocx] = useState<boolean>(false);

  const backdropDismiss = useBackdropDismiss(onClose);

  useEffect(() => {
    if (!isOpen) return;
    setPrintError(null);
    if (initialClassFilter && initialClassFilter !== 'ALL') {
      setScopeType('class');
      setSelectedClass(initialClassFilter);
    }
    if (initialExamTitle) {
      setExamTitle(initialExamTitle);
    }

    if (rosterOverride) {
      setRoster(rosterOverride);
    }
    if (scheduleOverride) {
      setSchedule(scheduleOverride);
    }

    if (!rosterOverride || !scheduleOverride) {
      setIsSyncing(true);
      Promise.all([
        rosterOverride ? Promise.resolve(rosterOverride) : loadAndSyncSchoolRoster(),
        scheduleOverride ? Promise.resolve(scheduleOverride) : loadAndSyncExamSchedule(),
      ])
        .then(([syncedRoster, syncedSchedule]) => {
          setRoster(syncedRoster);
          setSchedule(syncedSchedule);
        })
        .catch(() => {})
        .finally(() => setIsSyncing(false));
    }
  }, [isOpen, initialClassFilter, initialExamTitle, rosterOverride, scheduleOverride]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  const availableClasses = useMemo(() => {
    const set = new Set<string>();
    for (const s of roster) {
      if (s.class) set.add(s.class.trim());
    }
    return sortClassNames(Array.from(set));
  }, [roster]);

  const availableRooms = useMemo(() => {
    const set = new Set<string>();
    for (const s of roster) {
      if (s.room?.trim()) set.add(s.room.trim());
    }
    return Array.from(set).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    );
  }, [roster]);

  useEffect(() => {
    if (!selectedClass && availableClasses.length > 0) {
      setSelectedClass(availableClasses[0]);
    }
  }, [availableClasses, selectedClass]);

  useEffect(() => {
    if (!selectedRoom && availableRooms.length > 0) {
      setSelectedRoom(availableRooms[0]);
    }
  }, [availableRooms, selectedRoom]);

  const targetStudents = useMemo(() => {
    if (scopeType === 'class' && selectedClass) {
      const normSelected = normalizeClassLabel(selectedClass).toLowerCase();
      return roster.filter(
        (s) =>
          s.class === selectedClass ||
          normalizeClassLabel(s.class).toLowerCase() === normSelected
      );
    }
    if (scopeType === 'room' && selectedRoom) {
      return roster.filter((s) => (s.room || '').trim() === selectedRoom);
    }
    return roster;
  }, [roster, scopeType, selectedClass, selectedRoom]);

  if (!isOpen) return null;

  const totalSheetCount =
    printLayout === 'side_by_side'
      ? Math.ceil(targetStudents.length / 2)
      : printLayout === 'duplex_back'
        ? Math.ceil(targetStudents.length / 6) * 2
        : Math.ceil(targetStudents.length / 6);
  const duplexFrontCount = Math.ceil(targetStudents.length / 6);

  const handleOpenPrintPreview = () => {
    setPrintError(null);
    const res = openCandidateDeskCardsPrintWindow(targetStudents, schedule, {
      cardType,
      layout: printLayout,
      includeScheduleBack: printLayout === 'duplex_back',
      duplexFlip,
      sortMode,
      examTitle,
    });
    if (!res.ok) {
      setPrintError(res.error || 'Could not open print preview.');
      return;
    }
    onClose();
  };

  const handleExportPinSheetDocx = async () => {
    if (targetStudents.length === 0 || isExportingDocx) return;
    setPrintError(null);
    setIsExportingDocx(true);
    try {
      const { updatedRoster, assignedCount } = prepareRosterForPinExport(roster);
      if (assignedCount > 0) {
        setRoster(updatedRoster);
        await saveSchoolRoster(updatedRoster);
      }
      const updatedById = new Map(updatedRoster.map((s) => [s.id, s]));
      const scopedStudents = targetStudents.map((s) => updatedById.get(s.id) || s);
      const scopeLabel =
        scopeType === 'class' && selectedClass
          ? selectedClass
          : scopeType === 'room' && selectedRoom
            ? selectedRoom
            : 'All_Classes';
      await exportRosterPinSheetDocx(scopedStudents, {
        scopeLabel,
      });
    } catch (err: any) {
      setPrintError(err?.message || 'Could not export PIN sheet (.docx).');
    } finally {
      setIsExportingDocx(false);
    }
  };

  return createPortal(
    <div
      {...backdropDismiss}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10050,
        backgroundColor: 'rgba(15, 23, 42, 0.65)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '580px',
          background: 'var(--color-surface, #ffffff)',
          color: 'var(--color-text-primary, #0f172a)',
          border: '1px solid var(--color-border, #e2e8f0)',
          borderRadius: '16px',
          boxShadow: '0 24px 48px rgba(15, 23, 42, 0.28)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--color-border, #e2e8f0)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '1.5rem' }}>🪪</span>
            <div>
              <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 800 }}>
                Print Candidate Desk Cards (2 &times; 3 A4)
              </h2>
              <p style={{ margin: '2px 0 0', fontSize: '0.78rem', color: 'var(--color-text-secondary, #64748b)' }}>
                ICM &amp; Cambridge dual-logo slips with PIN, room, seat, and duplex exam timetable.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: '1.1rem',
              color: 'var(--color-text-secondary, #64748b)',
              cursor: 'pointer',
              padding: '4px 8px',
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* Card Type Picker */}
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary, #64748b)', marginBottom: '6px' }}>
              1. Card Type
            </label>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {[
                { key: 'candidate_card', label: '🪪 Candidate Card (With PIN)' },
                { key: 'desk_card', label: '🪧 Desk Card (No PIN)' },
              ].map((opt) => {
                const active = cardType === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setCardType(opt.key as CardPrintType)}
                    style={{
                      padding: '7px 12px',
                      borderRadius: '8px',
                      border: `1.5px solid ${active ? '#4f46e5' : 'var(--color-border, #cbd5e1)'}`,
                      background: active ? 'rgba(79, 70, 229, 0.1)' : 'transparent',
                      color: active ? '#4f46e5' : 'var(--color-text-primary, #0f172a)',
                      fontWeight: 700,
                      fontSize: '0.82rem',
                      cursor: 'pointer',
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Scope Picker */}
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary, #64748b)', marginBottom: '6px' }}>
              2. Candidate Print Scope {isSyncing ? '(Syncing latest roster...)' : ''}
            </label>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: scopeType === 'all' ? 0 : '8px' }}>
              {[
                { key: 'all', label: `All Candidates (${roster.length})` },
                { key: 'class', label: `By Class (${availableClasses.length})` },
                { key: 'room', label: `By Exam Room (${availableRooms.length})` },
              ].map((opt) => {
                const active = scopeType === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    disabled={opt.key === 'room' && availableRooms.length === 0}
                    onClick={() => setScopeType(opt.key as 'all' | 'class' | 'room')}
                    style={{
                      padding: '7px 12px',
                      borderRadius: '8px',
                      border: `1.5px solid ${active ? '#4f46e5' : 'var(--color-border, #cbd5e1)'}`,
                      background: active ? 'rgba(79, 70, 229, 0.1)' : 'transparent',
                      color: active ? '#4f46e5' : 'var(--color-text-primary, #0f172a)',
                      fontWeight: 700,
                      fontSize: '0.82rem',
                      cursor: opt.key === 'room' && availableRooms.length === 0 ? 'not-allowed' : 'pointer',
                      opacity: opt.key === 'room' && availableRooms.length === 0 ? 0.5 : 1,
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {scopeType === 'class' && (
              <select
                value={selectedClass}
                onChange={(e) => setSelectedClass(e.target.value)}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--color-border, #cbd5e1)',
                  background: 'var(--color-surface-sunken, #f8fafc)',
                  color: 'var(--color-text-primary, #0f172a)',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                }}
              >
                {availableClasses.map((cls) => (
                  <option key={cls} value={cls}>
                    {cls} ({roster.filter((s) => s.class === cls).length} students)
                  </option>
                ))}
              </select>
            )}

            {scopeType === 'room' && (
              <select
                value={selectedRoom}
                onChange={(e) => setSelectedRoom(e.target.value)}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--color-border, #cbd5e1)',
                  background: 'var(--color-surface-sunken, #f8fafc)',
                  color: 'var(--color-text-primary, #0f172a)',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                }}
              >
                {availableRooms.map((rm) => (
                  <option key={rm} value={rm}>
                    {rm} ({roster.filter((s) => (s.room || '').trim() === rm).length} seats)
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Card Header Title & Sort Order */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--color-text-secondary, #64748b)', marginBottom: '4px' }}>
                Card Exam Subtitle
              </label>
              <input
                type="text"
                value={examTitle}
                onChange={(e) => setExamTitle(e.target.value)}
                placeholder="e.g. 1st Semester Exam • A.Y. 2026/2027"
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: '8px',
                  border: '1px solid var(--color-border, #cbd5e1)',
                  background: 'var(--color-surface-sunken, #f8fafc)',
                  color: 'var(--color-text-primary, #0f172a)',
                  fontSize: '0.82rem',
                }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--color-text-secondary, #64748b)', marginBottom: '4px' }}>
                Desk Distribution Order
              </label>
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as DeskCardSortMode)}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: '8px',
                  border: '1px solid var(--color-border, #cbd5e1)',
                  background: 'var(--color-surface-sunken, #f8fafc)',
                  color: 'var(--color-text-primary, #0f172a)',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                }}
              >
                <option value="room_seat">Room &rarr; Seat # &rarr; Name</option>
                <option value="class_seat">Class &rarr; Cand # / NIS &rarr; Name</option>
              </select>
            </div>
          </div>

          {/* Print Layout Picker */}
          <div
            style={{
              padding: '12px 14px',
              borderRadius: '10px',
              border: '1px solid var(--color-border, #cbd5e1)',
              background: 'var(--color-surface-sunken, #f8fafc)',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary, #64748b)' }}>
              3. Print Layout
            </label>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {[
                { key: 'side_by_side', label: '📖 Side-by-Side Foldable (2/page · 13×9.5 cm)' },
                { key: 'duplex_back', label: '🔄 Duplex Mirrored Back (6/page)' },
                { key: 'front_only', label: '📄 Front Only (6/page)' },
              ].map((opt) => {
                const active = printLayout === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setPrintLayout(opt.key as CardPrintLayout)}
                    style={{
                      padding: '6px 10px',
                      borderRadius: '8px',
                      border: `1.5px solid ${active ? '#4f46e5' : 'var(--color-border, #cbd5e1)'}`,
                      background: active ? 'rgba(79, 70, 229, 0.1)' : 'var(--color-surface, #ffffff)',
                      color: active ? '#4f46e5' : 'var(--color-text-primary, #0f172a)',
                      fontWeight: 700,
                      fontSize: '0.78rem',
                      cursor: 'pointer',
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {printLayout !== 'front_only' && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', paddingTop: '2px' }}>
                <span style={{ fontSize: '0.76rem', color: 'var(--color-text-secondary, #64748b)' }}>
                  {schedule.length} schedule session{schedule.length === 1 ? '' : 's'} active &middot;{' '}
                  {printLayout === 'side_by_side'
                    ? 'Left = Schedule, Right = Card Front (cut & fold)'
                    : 'Filtered per candidate class/grade'}
                </span>
                {printLayout === 'duplex_back' && (
                  <select
                    value={duplexFlip}
                    onChange={(e) => setDuplexFlip(e.target.value as DuplexFlipEdge)}
                    style={{
                      padding: '5px 8px',
                      borderRadius: '6px',
                      border: '1px solid var(--color-border, #cbd5e1)',
                      fontSize: '0.76rem',
                      fontWeight: 600,
                      background: 'var(--color-surface, #ffffff)',
                      color: 'var(--color-text-primary, #0f172a)',
                    }}
                  >
                    <option value="long">Duplex: Flip Long Edge (Standard)</option>
                    <option value="short">Duplex: Flip Short Edge</option>
                  </select>
                )}
              </div>
            )}
          </div>

          {/* Summary Box */}
          <div
            style={{
              padding: '10px 14px',
              borderRadius: '10px',
              background: 'rgba(79, 70, 229, 0.08)',
              border: '1px solid rgba(79, 70, 229, 0.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '10px',
              fontSize: '0.82rem',
              fontWeight: 600,
              color: '#4338ca',
            }}
          >
            <span>
              Ready to generate {targetStudents.length} {cardType === 'desk_card' ? 'desk' : 'candidate'} card{targetStudents.length === 1 ? '' : 's'} ({cardType === 'desk_card' ? 'no PIN' : 'with PIN'})
            </span>
            <span>
              {totalSheetCount} A4 page{totalSheetCount === 1 ? '' : 's'}
              {printLayout === 'duplex_back' && duplexFrontCount > 0
                ? ` (${duplexFrontCount} front + ${duplexFrontCount} mirrored back)`
                : printLayout === 'side_by_side' && totalSheetCount > 0
                  ? ' (single-sided, cut & fold)'
                  : ''}
            </span>
          </div>

          {printError && (
            <div
              style={{
                padding: '9px 12px',
                borderRadius: '8px',
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.35)',
                color: '#dc2626',
                fontSize: '0.82rem',
                fontWeight: 600,
              }}
            >
              ⚠️ {printError}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '14px 20px',
            borderTop: '1px solid var(--color-border, #e2e8f0)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '10px',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              border: '1px solid var(--color-border, #cbd5e1)',
              background: 'transparent',
              color: 'var(--color-text-primary, #0f172a)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={targetStudents.length === 0 || isExportingDocx}
            onClick={handleExportPinSheetDocx}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              border: '1px solid #0284c7',
              background: targetStudents.length === 0 ? 'transparent' : 'rgba(2, 132, 199, 0.08)',
              color: targetStudents.length === 0 ? '#94a3b8' : '#0369a1',
              fontWeight: 700,
              cursor: targetStudents.length === 0 || isExportingDocx ? 'not-allowed' : 'pointer',
            }}
          >
            {isExportingDocx ? '⏳ Exporting...' : `📄 Export PINs (.docx)`}
          </button>
          <button
            type="button"
            disabled={targetStudents.length === 0}
            onClick={handleOpenPrintPreview}
            style={{
              padding: '8px 18px',
              borderRadius: '8px',
              border: 'none',
              background: targetStudents.length === 0 ? '#94a3b8' : '#4f46e5',
              color: '#ffffff',
              fontWeight: 700,
              cursor: targetStudents.length === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            🪪 Open Print Sheet ({targetStudents.length})
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
