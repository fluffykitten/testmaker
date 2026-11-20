import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import type { ExamScheduleEntry } from '../lib/examSchedule';
import { resolveEffectiveQuizStatus, type EffectiveQuizStatus } from '../lib/examSessionSchedule';
import {
  UNSCHEDULED_DAY_KEY,
  computeDayWarmSummary,
  extractScheduleDayPresets,
  formatExamDayDateLabel,
  getWarmedQuizTimestamps,
  groupQuizzesByExamDay,
  normalizeExamDayKey,
  resolveQuizExamDayKey,
  type SemesterDayGroup,
} from '../lib/semesterDayOrganizer';
import {
  activateExamDayQuizzes,
  assignQuizzesToExamDay,
  getPublishedQuizzes,
  pauseQuizzesBatch,
  prewarmExamPaperCache,
  toggleQuizActiveStatus,
  type PublishedQuiz,
} from '../services/quizManagerService';
import './SemesterDayOrganizerModal.css';

interface SemesterDayOrganizerModalProps {
  isOpen: boolean;
  onClose: () => void;
  quizzes: PublishedQuiz[];
  scheduleEntries: ExamScheduleEntry[];
  nowMs?: number;
  onQuizzesChanged: (next: PublishedQuiz[]) => void;
  onNotify?: (type: 'success' | 'warning', message: string) => void;
}

const STATUS_BADGE_MAP: Record<EffectiveQuizStatus, { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'sdo-status--active' },
  scheduled: { label: 'Scheduled', cls: 'sdo-status--scheduled' },
  paused: { label: 'Paused', cls: 'sdo-status--paused' },
  closed: { label: 'Closed', cls: 'sdo-status--closed' },
};

function formatShortTime(tsMs: number): string {
  try {
    return new Date(tsMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function SemesterDayOrganizerModal({
  isOpen,
  onClose,
  quizzes,
  scheduleEntries,
  nowMs: externalNowMs,
  onQuizzesChanged,
  onNotify,
}: SemesterDayOrganizerModalProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [subjectFilter, setSubjectFilter] = useState<string>('all');
  const [customDayKeys, setCustomDayKeys] = useState<string[]>([]);
  const [newDayInput, setNewDayInput] = useState<string>('');
  const [collapsedDays, setCollapsedDays] = useState<Record<string, boolean>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkTargetDay, setBulkTargetDay] = useState<string>(UNSCHEDULED_DAY_KEY);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [busyQuizRowIds, setBusyQuizRowIds] = useState<Record<string, boolean>>({});
  const [banner, setBanner] = useState<{ type: 'success' | 'warning'; text: string } | null>(null);
  const [warmMap, setWarmMap] = useState<Record<string, number>>(() => getWarmedQuizTimestamps());
  const [localNowMs, setLocalNowMs] = useState<number>(() => externalNowMs || Date.now());

  const effectiveNowMs = externalNowMs || localNowMs;
  const isModalBusy = Boolean(busyAction);

  const backdropDismiss = useBackdropDismiss(() => {
    if (!isModalBusy) onClose();
  });

  useEffect(() => {
    if (!isOpen) return;
    setWarmMap(getWarmedQuizTimestamps());
    setBanner(null);
    setLocalNowMs(Date.now());
    const interval = setInterval(() => {
      setLocalNowMs(Date.now());
      setWarmMap(getWarmedQuizTimestamps());
    }, 30_000);
    return () => clearInterval(interval);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isModalBusy) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, isModalBusy, onClose]);

  const examQuizzes = useMemo(
    () => (quizzes || []).filter((q) => q && q.quizMode !== 'game'),
    [quizzes]
  );

  // Prune stale selections when quizzes list changes
  useEffect(() => {
    const validSet = new Set(examQuizzes.map((q) => q.id));
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (validSet.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [examQuizzes]);

  const subjectOptions = useMemo(() => {
    const set = new Set<string>();
    for (const q of examQuizzes) {
      const sub = (q.subject || q.headerConfig?.subject || '').trim();
      if (sub) set.add(sub);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [examQuizzes]);

  const schedulePresets = useMemo(
    () => extractScheduleDayPresets(scheduleEntries),
    [scheduleEntries]
  );

  const filteredQuizzes = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return examQuizzes.filter((q) => {
      const subj = (q.subject || q.headerConfig?.subject || 'General').trim();
      if (subjectFilter !== 'all' && subj.toLowerCase() !== subjectFilter.toLowerCase()) {
        return false;
      }
      if (!query) return true;
      return (
        q.quizCode.toLowerCase().includes(query) ||
        q.title.toLowerCase().includes(query) ||
        subj.toLowerCase().includes(query) ||
        String(q.targetClass || '').toLowerCase().includes(query)
      );
    });
  }, [examQuizzes, searchQuery, subjectFilter]);

  const isFiltered = Boolean(searchQuery.trim() || subjectFilter !== 'all');

  const { days: groupedDays, unscheduled } = useMemo(
    () =>
      groupQuizzesByExamDay(
        filteredQuizzes,
        scheduleEntries,
        isFiltered ? [] : customDayKeys,
        effectiveNowMs
      ),
    [filteredQuizzes, scheduleEntries, customDayKeys, isFiltered, effectiveNowMs]
  );

  // Full unfiltered day list (used for Day selector dropdowns & schedule quick-add chips)
  const { days: allDaysUnfiltered } = useMemo(
    () => groupQuizzesByExamDay(examQuizzes, scheduleEntries, customDayKeys, effectiveNowMs),
    [examQuizzes, scheduleEntries, customDayKeys, effectiveNowMs]
  );

  const allDayDropdownOptions = useMemo(() => {
    const map = new Map<string, { dayKey: string; label: string }>();
    allDaysUnfiltered.forEach((d) => {
      map.set(d.dayKey, { dayKey: d.dayKey, label: `Day ${d.dayNumber} · ${d.label}` });
    });
    schedulePresets.forEach((p) => {
      if (!map.has(p.dayKey)) {
        const subjHint = p.subjects.length > 0 ? ` (${p.subjects.slice(0, 2).join(', ')})` : '';
        map.set(p.dayKey, { dayKey: p.dayKey, label: `${p.label}${subjHint}` });
      }
    });
    return Array.from(map.values()).sort((a, b) => a.dayKey.localeCompare(b.dayKey));
  }, [allDaysUnfiltered, schedulePresets]);

  const unaddedSchedulePresets = useMemo(() => {
    const existingSet = new Set(allDaysUnfiltered.map((d) => d.dayKey));
    return schedulePresets.filter((p) => !existingSet.has(p.dayKey));
  }, [allDaysUnfiltered, schedulePresets]);

  useEffect(() => {
    if (
      bulkTargetDay === UNSCHEDULED_DAY_KEY &&
      allDayDropdownOptions.length > 0
    ) {
      setBulkTargetDay(allDayDropdownOptions[0].dayKey);
    }
  }, [allDayDropdownOptions, bulkTargetDay]);

  const metrics = useMemo(() => {
    let active = 0;
    let scheduled = 0;
    let paused = 0;
    for (const q of examQuizzes) {
      const s = resolveEffectiveQuizStatus(q, effectiveNowMs);
      if (s === 'active') active++;
      else if (s === 'scheduled') scheduled++;
      else paused++;
    }
    return {
      total: examQuizzes.length,
      days: allDaysUnfiltered.length,
      active,
      scheduled,
      paused,
    };
  }, [examQuizzes, allDaysUnfiltered.length, effectiveNowMs]);

  if (!isOpen) return null;

  const pushBanner = (type: 'success' | 'warning', text: string) => {
    setBanner({ type, text });
    onNotify?.(type, text);
  };

  const refreshWarmMap = () => setWarmMap(getWarmedQuizTimestamps());

  const handleAddDayKey = (rawDate: string) => {
    const dayKey = normalizeExamDayKey(rawDate);
    if (!dayKey) {
      pushBanner('warning', 'Please choose a valid date to add an Exam Day.');
      return;
    }
    setCustomDayKeys((prev) => (prev.includes(dayKey) ? prev : [...prev, dayKey]));
    setBulkTargetDay(dayKey);
    setNewDayInput('');
  };

  const handleActivateDay = async (group: SemesterDayGroup) => {
    if (isModalBusy || group.quizzes.length === 0) return;
    const isDated = group.dayKey !== UNSCHEDULED_DAY_KEY;
    const dayLabel = isDated ? `Day ${group.dayNumber} (${group.label})` : 'selected unscheduled exams';
    setBusyAction(`activate:${group.dayKey}`);
    try {
      const { batch, warm } = await activateExamDayQuizzes(
        group.quizzes.map((q) => q.id),
        isDated ? group.dayKey : null
      );
      onQuizzesChanged(batch.quizzes);
      refreshWarmMap();

      if (batch.ok && warm.ok) {
        pushBanner(
          'success',
          `Activated ${batch.updatedQuizzes.length} exam(s) for ${dayLabel} and warmed ${warm.warmedCount} cache(s) for ${warm.ttlMinutes} min.`
        );
      } else if (batch.codeIndexSynced) {
        pushBanner(
          'warning',
          `Activated ${batch.updatedQuizzes.length} exam(s) for students, with a warning: ${
            warm.error || batch.error || 'partial cloud sync/warm notice'
          }`
        );
      } else {
        pushBanner(
          'warning',
          `Cloud sync failed while activating ${dayLabel}: ${batch.error || 'please retry'}`
        );
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handlePauseDay = async (group: SemesterDayGroup) => {
    if (isModalBusy || group.quizzes.length === 0) return;
    const isDated = group.dayKey !== UNSCHEDULED_DAY_KEY;
    const dayLabel = isDated ? `Day ${group.dayNumber} (${group.label})` : 'Unscheduled Exams';
    setBusyAction(`pause:${group.dayKey}`);
    try {
      const batch = await pauseQuizzesBatch(group.quizzes.map((q) => q.id));
      onQuizzesChanged(batch.quizzes);
      refreshWarmMap();

      if (batch.ok) {
        pushBanner('success', `Paused ${batch.updatedQuizzes.length} exam(s) in ${dayLabel}.`);
      } else {
        pushBanner(
          'warning',
          `Paused locally, but cloud sync had a notice: ${batch.error || 'please retry'}`
        );
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleWarmDay = async (group: SemesterDayGroup) => {
    if (isModalBusy) return;
    const warmableCodes = group.quizzes
      .filter((q) => {
        const eff = resolveEffectiveQuizStatus(q, effectiveNowMs);
        return eff === 'active' || eff === 'scheduled';
      })
      .map((q) => q.quizCode)
      .filter(Boolean);

    if (warmableCodes.length === 0) {
      pushBanner('warning', 'Activate or schedule at least one exam in this group before warming cache.');
      return;
    }

    setBusyAction(`warm:${group.dayKey}`);
    try {
      const warm = await prewarmExamPaperCache(warmableCodes);
      refreshWarmMap();
      if (warm.ok) {
        pushBanner(
          'success',
          `Warmed ${warm.warmedCount} exam cache(s) for ${group.label} (${warm.ttlMinutes} min TTL).`
        );
      } else {
        pushBanner(
          'warning',
          `Could not warm cache for ${group.label}: ${warm.error || 'ensure Migration 037 is applied'}`
        );
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handlePauseOtherDays = async (group: SemesterDayGroup) => {
    if (isModalBusy || group.dayKey === UNSCHEDULED_DAY_KEY) return;
    const otherActiveIds = examQuizzes
      .filter((q) => {
        const qDay = resolveQuizExamDayKey(q);
        if (qDay === group.dayKey) return false;
        const eff = resolveEffectiveQuizStatus(q, effectiveNowMs);
        return eff === 'active' || eff === 'scheduled';
      })
      .map((q) => q.id);

    if (otherActiveIds.length === 0) {
      pushBanner('warning', 'All exams outside this Day are already paused or closed.');
      return;
    }

    const ok = window.confirm(
      `Pause ${otherActiveIds.length} active/scheduled exam(s) outside Day ${group.dayNumber} (${group.label})? Ongoing student submits still save, but new entry/resume will lock until reactivated.`
    );
    if (!ok) return;

    setBusyAction(`pause-others:${group.dayKey}`);
    try {
      const batch = await pauseQuizzesBatch(otherActiveIds);
      onQuizzesChanged(batch.quizzes);
      refreshWarmMap();
      if (batch.ok) {
        pushBanner(
          'success',
          `Paused ${batch.updatedQuizzes.length} exam(s) outside Day ${group.dayNumber}.`
        );
      } else {
        pushBanner('warning', `Paused other days with cloud notice: ${batch.error || 'retry'}`);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handlePauseAllExams = async () => {
    if (isModalBusy) return;
    const activeIds = examQuizzes
      .filter((q) => {
        const eff = resolveEffectiveQuizStatus(q, effectiveNowMs);
        return eff === 'active' || eff === 'scheduled';
      })
      .map((q) => q.id);

    if (activeIds.length === 0) {
      pushBanner('warning', 'All formal exams are already paused or closed.');
      return;
    }

    const ok = window.confirm(
      `Pause all ${activeIds.length} active/scheduled formal exam(s) across every Day?`
    );
    if (!ok) return;

    setBusyAction('pause-all');
    try {
      const batch = await pauseQuizzesBatch(activeIds);
      onQuizzesChanged(batch.quizzes);
      refreshWarmMap();
      if (batch.ok) {
        pushBanner('success', `Paused all ${batch.updatedQuizzes.length} active/scheduled exam(s).`);
      } else {
        pushBanner('warning', `Paused with cloud warning: ${batch.error || 'please retry'}`);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleMoveQuizzesToDay = async (quizIds: string[], targetKey: string) => {
    if (isModalBusy || quizIds.length === 0) return;
    const nextDay = targetKey === UNSCHEDULED_DAY_KEY ? null : normalizeExamDayKey(targetKey);
    if (targetKey !== UNSCHEDULED_DAY_KEY && !nextDay) return;

    setBusyAction('move-day');
    try {
      const batch = await assignQuizzesToExamDay(quizIds, nextDay);
      onQuizzesChanged(batch.quizzes);
      if (nextDay) {
        setCustomDayKeys((prev) => (prev.includes(nextDay) ? prev : [...prev, nextDay]));
      }
      setSelectedIds((prev) => {
        if (quizIds.length === 1) return prev;
        return new Set();
      });

      const destLabel = nextDay ? formatExamDayDateLabel(nextDay) : 'Unscheduled Exams';
      if (batch.ok) {
        pushBanner('success', `Moved ${batch.updatedQuizzes.length} exam(s) to ${destLabel}.`);
      } else {
        pushBanner(
          'warning',
          `Moved locally to ${destLabel}, but cloud sync had a notice: ${batch.error || 'retry'}`
        );
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleBulkActivateSelected = async () => {
    if (isModalBusy || selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    const chosenDay =
      bulkTargetDay !== UNSCHEDULED_DAY_KEY ? normalizeExamDayKey(bulkTargetDay) : null;

    setBusyAction('bulk-activate');
    try {
      const { batch, warm } = await activateExamDayQuizzes(ids, chosenDay);
      onQuizzesChanged(batch.quizzes);
      refreshWarmMap();
      setSelectedIds(new Set());
      if (batch.ok && warm.ok) {
        pushBanner(
          'success',
          `Activated ${batch.updatedQuizzes.length} selected exam(s) and warmed ${warm.warmedCount} cache(s).`
        );
      } else {
        pushBanner(
          'warning',
          `Activated ${batch.updatedQuizzes.length} exam(s) (${warm.error || batch.error || 'check warm/sync'}).`
        );
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleBulkPauseSelected = async () => {
    if (isModalBusy || selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    setBusyAction('bulk-pause');
    try {
      const batch = await pauseQuizzesBatch(ids);
      onQuizzesChanged(batch.quizzes);
      refreshWarmMap();
      setSelectedIds(new Set());
      if (batch.ok) {
        pushBanner('success', `Paused ${batch.updatedQuizzes.length} selected exam(s).`);
      } else {
        pushBanner('warning', `Paused selected exams with cloud notice: ${batch.error || 'retry'}`);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleSingleRowToggle = async (quiz: PublishedQuiz) => {
    if (isModalBusy || busyQuizRowIds[quiz.id]) return;
    setBusyQuizRowIds((prev) => ({ ...prev, [quiz.id]: true }));
    try {
      const updated = await toggleQuizActiveStatus(quiz.id);
      onQuizzesChanged(getPublishedQuizzes());
      if (updated?.isActive && updated.quizCode) {
        await prewarmExamPaperCache([updated.quizCode]);
      }
      refreshWarmMap();
    } finally {
      setBusyQuizRowIds((prev) => {
        const next = { ...prev };
        delete next[quiz.id];
        return next;
      });
    }
  };

  const toggleSelectId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectGroup = (group: SemesterDayGroup) => {
    if (group.quizzes.length === 0) return;
    const allInGroupSelected = group.quizzes.every((q) => selectedIds.has(q.id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const q of group.quizzes) {
        if (allInGroupSelected) next.delete(q.id);
        else next.add(q.id);
      }
      return next;
    });
  };

  const renderDayCard = (group: SemesterDayGroup) => {
    const isDated = group.dayKey !== UNSCHEDULED_DAY_KEY;
    const isCollapsed = Boolean(collapsedDays[group.dayKey]);
    const dayCodes = group.quizzes.map((q) => q.quizCode);
    const warmSummary = computeDayWarmSummary(dayCodes, warmMap, effectiveNowMs);
    const warmableCount = group.activeCount + group.scheduledCount;

    const otherActiveOrScheduledCount = isDated
      ? examQuizzes.filter((q) => {
          const qDay = resolveQuizExamDayKey(q);
          if (qDay === group.dayKey) return false;
          const eff = resolveEffectiveQuizStatus(q, effectiveNowMs);
          return eff === 'active' || eff === 'scheduled';
        }).length
      : 0;

    const allSelectedInGroup =
      group.quizzes.length > 0 && group.quizzes.every((q) => selectedIds.has(q.id));

    return (
      <section key={group.dayKey} className={`sdo-day-card ${!isDated ? 'sdo-day-card--unscheduled' : ''}`}>
        <div className="sdo-day-header">
          <div className="sdo-day-title-area">
            <button
              type="button"
              className="sdo-collapse-btn"
              onClick={() =>
                setCollapsedDays((prev) => ({ ...prev, [group.dayKey]: !prev[group.dayKey] }))
              }
              title={isCollapsed ? 'Expand day exams' : 'Collapse day exams'}
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? '▶' : '▼'}
            </button>

            <div className="sdo-day-heading-stack">
              <div className="sdo-day-heading-row">
                <h3 className="sdo-day-title">
                  {isDated ? `Day ${group.dayNumber} · ${group.label}` : group.label}
                </h3>
                <span className="sdo-count-pill">{group.quizzes.length} exam{group.quizzes.length === 1 ? '' : 's'}</span>

                {group.scheduleSubjects.length > 0 && (
                  <div className="sdo-schedule-subjects">
                    {group.scheduleSubjects.map((sub) => (
                      <span key={sub} className="sdo-subject-chip">
                        {sub}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="sdo-day-status-row">
                {group.activeCount > 0 && (
                  <span className="sdo-mini-badge sdo-mini-badge--active">
                    ● {group.activeCount} Active
                  </span>
                )}
                {group.scheduledCount > 0 && (
                  <span className="sdo-mini-badge sdo-mini-badge--scheduled">
                    ⏱ {group.scheduledCount} Scheduled
                  </span>
                )}
                {group.pausedCount > 0 && (
                  <span className="sdo-mini-badge sdo-mini-badge--paused">
                    ⏸ {group.pausedCount} Paused
                  </span>
                )}
                {group.closedCount > 0 && (
                  <span className="sdo-mini-badge sdo-mini-badge--closed">
                    🔒 {group.closedCount} Closed
                  </span>
                )}

                {group.quizzes.length > 0 && (
                  <span
                    className={`sdo-warm-badge sdo-warm-badge--${warmSummary.status}`}
                    title={
                      warmSummary.lastWarmedAt
                        ? `Last warmed locally at ${formatShortTime(warmSummary.lastWarmedAt)} (~${warmSummary.minutesRemaining}m left in 90m TTL)`
                        : 'Click Warm Up or Activate & Warm to compile exam papers in Supabase cache'
                    }
                  >
                    {warmSummary.status === 'warm' && warmSummary.lastWarmedAt
                      ? `⚡ Warmed · ${warmSummary.minutesRemaining}m left (${formatShortTime(
                          warmSummary.lastWarmedAt
                        )})`
                      : warmSummary.status === 'partial'
                        ? `⚡ Partial ${warmSummary.warmedCount}/${warmSummary.totalCount}`
                        : `❄️ Cold (${warmSummary.totalCount})`}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="sdo-day-actions">
            <button
              type="button"
              className="sdo-btn sdo-btn--activate"
              disabled={isModalBusy || group.quizzes.length === 0}
              onClick={() => handleActivateDay(group)}
              title="Open all exams in this Day immediately (clears schedule start, keeps Day assignment) and pre-warm Supabase cache"
            >
              {busyAction === `activate:${group.dayKey}` ? 'Activating…' : '▶ Activate & Warm'}
            </button>

            <button
              type="button"
              className="sdo-btn sdo-btn--pause"
              disabled={isModalBusy || group.quizzes.length === 0 || warmableCount === 0}
              onClick={() => handlePauseDay(group)}
              title="Pause all exams in this Day"
            >
              {busyAction === `pause:${group.dayKey}` ? 'Pausing…' : '⏸ Pause Day'}
            </button>

            <button
              type="button"
              className="sdo-btn sdo-btn--warm"
              disabled={isModalBusy || warmableCount === 0}
              onClick={() => handleWarmDay(group)}
              title={
                warmableCount === 0
                  ? 'Activate or schedule at least 1 exam in this Day to warm its cache'
                  : `Pre-warm ${warmableCount} active/scheduled exam(s) in Supabase cache (90 min)`
              }
            >
              {busyAction === `warm:${group.dayKey}` ? 'Warming…' : '⚡ Warm Up'}
            </button>

            {isDated && otherActiveOrScheduledCount > 0 && (
              <button
                type="button"
                className="sdo-btn sdo-btn--danger-outline"
                disabled={isModalBusy}
                onClick={() => handlePauseOtherDays(group)}
                title={`Pause ${otherActiveOrScheduledCount} active/scheduled exam(s) outside this Day`}
              >
                {busyAction === `pause-others:${group.dayKey}`
                  ? 'Pausing…'
                  : `⏸ Pause Others (${otherActiveOrScheduledCount})`}
              </button>
            )}
          </div>
        </div>

        {!isCollapsed && (
          <div className="sdo-day-body">
            {group.quizzes.length === 0 ? (
              <div className="sdo-day-empty">
                No exams assigned to this Day yet. Use any row’s Day dropdown or checkboxes below to move exams here.
              </div>
            ) : (
              <div className="sdo-table-wrap">
                <table className="sdo-table">
                  <thead>
                    <tr>
                      <th className="sdo-col-check">
                        <input
                          type="checkbox"
                          checked={allSelectedInGroup}
                          onChange={() => toggleSelectGroup(group)}
                          aria-label={`Select all exams in ${group.label}`}
                        />
                      </th>
                      <th>Code</th>
                      <th>Assessment Title</th>
                      <th>Subject &amp; Class</th>
                      <th>Status</th>
                      <th>Exam Day</th>
                      <th className="sdo-col-toggle">Quick</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.quizzes.map((quiz) => {
                      const eff = resolveEffectiveQuizStatus(quiz, effectiveNowMs);
                      const badge = STATUS_BADGE_MAP[eff];
                      const currentDayValue = resolveQuizExamDayKey(quiz) || UNSCHEDULED_DAY_KEY;
                      const isRowBusy = Boolean(busyQuizRowIds[quiz.id]);

                      return (
                        <tr
                          key={quiz.id}
                          className={selectedIds.has(quiz.id) ? 'sdo-row--selected' : ''}
                        >
                          <td className="sdo-col-check">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(quiz.id)}
                              onChange={() => toggleSelectId(quiz.id)}
                              aria-label={`Select ${quiz.quizCode}`}
                            />
                          </td>
                          <td>
                            <span className="sdo-code-pill">{quiz.quizCode}</span>
                          </td>
                          <td>
                            <div className="sdo-quiz-title">{quiz.title}</div>
                          </td>
                          <td>
                            <div className="sdo-meta-pills">
                              <span className="sdo-subj-pill">
                                {quiz.subject || quiz.headerConfig?.subject || 'General'}
                              </span>
                              {quiz.targetClass && (
                                <span className="sdo-class-pill">{quiz.targetClass}</span>
                              )}
                            </div>
                          </td>
                          <td>
                            <span className={`sdo-status-pill ${badge.cls}`}>{badge.label}</span>
                          </td>
                          <td>
                            <select
                              className="sdo-day-select"
                              value={currentDayValue}
                              disabled={isModalBusy}
                              aria-label={`Assign Day for ${quiz.quizCode}`}
                              onChange={(e) => handleMoveQuizzesToDay([quiz.id], e.target.value)}
                            >
                              <option value={UNSCHEDULED_DAY_KEY}>Unscheduled</option>
                              {allDayDropdownOptions.map((opt) => (
                                <option key={opt.dayKey} value={opt.dayKey}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="sdo-col-toggle">
                            <button
                              type="button"
                              className={`sdo-mini-toggle ${
                                quiz.isActive ? 'sdo-mini-toggle--pause' : 'sdo-mini-toggle--play'
                              }`}
                              disabled={isModalBusy || isRowBusy}
                              onClick={() => handleSingleRowToggle(quiz)}
                              title={
                                quiz.isActive
                                  ? `Pause ${quiz.quizCode}`
                                  : `Activate & warm ${quiz.quizCode}`
                              }
                            >
                              {isRowBusy ? '…' : quiz.isActive ? '⏸' : '▶'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>
    );
  };

  return createPortal(
    <div
      className="sdo-backdrop"
      onMouseDown={backdropDismiss.onMouseDown}
      onClick={backdropDismiss.onClick}
    >
      <div className="sdo-modal" role="dialog" aria-modal="true" aria-labelledby="sdo-modal-title">
        {/* Header */}
        <header className="sdo-header">
          <div>
            <h2 id="sdo-modal-title" className="sdo-title">
              📅 Semester Exam Day Organizer
            </h2>
            <p className="sdo-subtitle">
              Group exams by day, immediately open &amp; warm cache for an entire day, or pause other days cleanly.
              {' · '}
              <strong>{metrics.total}</strong> exam{metrics.total === 1 ? '' : 's'} across{' '}
              <strong>{metrics.days}</strong> day{metrics.days === 1 ? '' : 's'} ({metrics.active} active,{' '}
              {metrics.scheduled} scheduled, {metrics.paused} paused)
            </p>
          </div>

          <div className="sdo-header-actions">
            <button
              type="button"
              className="sdo-btn sdo-btn--danger-outline"
              disabled={isModalBusy || metrics.active + metrics.scheduled === 0}
              onClick={handlePauseAllExams}
              title="Safely pause every active and scheduled exam across all days"
            >
              {busyAction === 'pause-all'
                ? 'Pausing All…'
                : `⏸ Pause All (${metrics.active + metrics.scheduled})`}
            </button>
            <button
              type="button"
              className="qm-modal-close"
              disabled={isModalBusy}
              onClick={onClose}
              aria-label="Close Semester Exam Day Organizer"
            >
              ✕
            </button>
          </div>
        </header>

        {/* Toolbar */}
        <div className="sdo-toolbar">
          <div className="sdo-toolbar-filters">
            <div className="sdo-search-wrap">
              <input
                type="text"
                className="sdo-input"
                placeholder="Search code (e.g. ICM-1), title, class, or subject…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="sdo-search-clear"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search"
                >
                  ✕
                </button>
              )}
            </div>

            <select
              className="sdo-select"
              value={subjectFilter}
              onChange={(e) => setSubjectFilter(e.target.value)}
              aria-label="Filter by subject"
            >
              <option value="all">All Subjects ({examQuizzes.length})</option>
              {subjectOptions.map((sub) => (
                <option key={sub} value={sub}>
                  {sub}
                </option>
              ))}
            </select>
          </div>

          <div className="sdo-add-day-wrap">
            <label htmlFor="sdo-new-day-date" className="sdo-add-day-label">
              + Add Exam Day:
            </label>
            <input
              id="sdo-new-day-date"
              type="date"
              className="sdo-date-input"
              value={newDayInput}
              onChange={(e) => setNewDayInput(e.target.value)}
            />
            <button
              type="button"
              className="sdo-btn sdo-btn--secondary"
              disabled={!newDayInput || isModalBusy}
              onClick={() => handleAddDayKey(newDayInput)}
            >
              Add Day
            </button>
          </div>
        </div>

        {/* Schedule Preset Quick-Add Chips */}
        {unaddedSchedulePresets.length > 0 && (
          <div className="sdo-preset-strip">
            <span className="sdo-preset-label">From Exam Schedule:</span>
            <div className="sdo-preset-chips">
              {unaddedSchedulePresets.map((preset) => (
                <button
                  key={preset.dayKey}
                  type="button"
                  className="sdo-preset-chip"
                  disabled={isModalBusy}
                  onClick={() => handleAddDayKey(preset.dayKey)}
                  title={`Add ${preset.label} (${preset.subjects.join(', ')})`}
                >
                  + {preset.label}
                  {preset.subjects.length > 0 && (
                    <span className="sdo-preset-chip-sub">
                      {' · '}
                      {preset.subjects.slice(0, 2).join(', ')}
                      {preset.subjects.length > 2 ? '…' : ''}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Inline Feedback Banner */}
        {banner && (
          <div
            className={`sdo-banner ${
              banner.type === 'success' ? 'sdo-banner--success' : 'sdo-banner--warning'
            }`}
            role="status"
          >
            <span>{banner.type === 'success' ? '✓' : '⚠'}</span>
            <span>{banner.text}</span>
          </div>
        )}

        {/* Sticky Multi-Select Bulk Action Bar */}
        {selectedIds.size > 0 && (
          <div className="sdo-bulk-bar">
            <span className="sdo-bulk-count">{selectedIds.size} selected</span>

            <div className="sdo-bulk-controls">
              <select
                className="sdo-select sdo-select--compact"
                value={bulkTargetDay}
                disabled={isModalBusy}
                onChange={(e) => setBulkTargetDay(e.target.value)}
                aria-label="Bulk target day"
              >
                <option value={UNSCHEDULED_DAY_KEY}>Unscheduled</option>
                {allDayDropdownOptions.map((opt) => (
                  <option key={opt.dayKey} value={opt.dayKey}>
                    {opt.label}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="sdo-btn sdo-btn--secondary"
                disabled={isModalBusy}
                onClick={() => handleMoveQuizzesToDay(Array.from(selectedIds), bulkTargetDay)}
              >
                {busyAction === 'move-day' ? 'Moving…' : 'Move to Day'}
              </button>

              <button
                type="button"
                className="sdo-btn sdo-btn--activate"
                disabled={isModalBusy}
                onClick={handleBulkActivateSelected}
              >
                {busyAction === 'bulk-activate' ? 'Activating…' : '▶ Activate & Warm'}
              </button>

              <button
                type="button"
                className="sdo-btn sdo-btn--pause"
                disabled={isModalBusy}
                onClick={handleBulkPauseSelected}
              >
                {busyAction === 'bulk-pause' ? 'Pausing…' : '⏸ Pause'}
              </button>

              <button
                type="button"
                className="sdo-btn sdo-btn--ghost"
                disabled={isModalBusy}
                onClick={() => setSelectedIds(new Set())}
              >
                Clear
              </button>
            </div>
          </div>
        )}

        {/* Scrollable Day Cards Body */}
        <div className="sdo-body">
          {examQuizzes.length === 0 ? (
            <div className="sdo-empty-state">
              No published formal exams found yet. Publish an exam from Quiz Manager first, then organize it by Day here.
            </div>
          ) : groupedDays.length === 0 && unscheduled.quizzes.length === 0 ? (
            <div className="sdo-empty-state">
              No exams match your current search/subject filter.
            </div>
          ) : (
            <div className="sdo-days-stack">
              {groupedDays.map((day) => renderDayCard(day))}
              {(unscheduled.quizzes.length > 0 || groupedDays.length === 0) &&
                renderDayCard(unscheduled)}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
