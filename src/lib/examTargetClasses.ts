import { normalizeClassLabel } from './examSchedule';

/**
 * Normalizes a class/cohort label for case- and spacing-insensitive matching
 * while delegating ICM-style spacing cleanup (e.g. "X IPA3" -> "X IPA 3") to normalizeClassLabel.
 */
export function normalizeTargetClassKey(cls?: string | null): string {
  return normalizeClassLabel(String(cls || ''))
    .trim()
    .toLowerCase();
}

/**
 * Parses a comma-separated `PublishedQuiz.targetClass` string into unique class labels.
 * Empty/blank or "ALL" means no restriction (all school classes are eligible).
 */
export function parseTargetClassList(targetClass?: string | null): string[] {
  const raw = String(targetClass || '').trim();
  if (!raw) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const part of raw.split(',')) {
    const cleaned = normalizeClassLabel(part).trim();
    if (!cleaned || cleaned.toUpperCase() === 'ALL') continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }

  return result;
}

/**
 * Serializes selected target classes back into the compact `PublishedQuiz.targetClass` string.
 * Returns empty string when unconstrained.
 */
export function serializeTargetClassList(classes: string[]): string {
  return parseTargetClassList(classes.join(',')).join(', ');
}

/**
 * Toggles a class name in/out of a serialized `targetClass` list.
 */
export function toggleTargetClassSelection(
  currentTargetClass: string | undefined | null,
  cls: string
): string {
  const cleanTarget = normalizeClassLabel(cls).trim();
  if (!cleanTarget) return String(currentTargetClass || '');

  const current = parseTargetClassList(currentTargetClass);
  const targetKey = cleanTarget.toLowerCase();
  const exists = current.some((c) => c.toLowerCase() === targetKey);

  const next = exists
    ? current.filter((c) => c.toLowerCase() !== targetKey)
    : [...current, cleanTarget];

  return serializeTargetClassList(next);
}

/**
 * Resolves which classes should appear in the student exam dropdown.
 * If no target classes are selected, returns all configured `schoolClasses`.
 */
export function resolveAvailableExamClasses(
  schoolClasses: string[],
  targetClass?: string | null
): string[] {
  const targets = parseTargetClassList(targetClass);
  if (targets.length === 0) return schoolClasses;

  const targetKeyMap = new Map<string, string>();
  targets.forEach((t) => targetKeyMap.set(t.toLowerCase(), t));

  const ordered: string[] = [];
  const usedKeys = new Set<string>();

  for (const schoolCls of schoolClasses) {
    const key = normalizeTargetClassKey(schoolCls);
    if (targetKeyMap.has(key) && !usedKeys.has(key)) {
      ordered.push(schoolCls);
      usedKeys.add(key);
    }
  }

  for (const t of targets) {
    const key = t.toLowerCase();
    if (!usedKeys.has(key)) {
      ordered.push(t);
      usedKeys.add(key);
    }
  }

  return ordered;
}

/**
 * Filters public candidate roster suggestions to match selected exam target classes.
 * When no target classes are set, returns the full roster unchanged.
 */
export function filterRosterByTargetClasses<T extends { class?: string }>(
  roster: T[],
  targetClass?: string | null
): T[] {
  const targets = parseTargetClassList(targetClass);
  if (targets.length === 0) return roster;

  const allowedKeys = new Set(targets.map((t) => normalizeTargetClassKey(t)));
  return roster.filter((student) => allowedKeys.has(normalizeTargetClassKey(student.class)));
}

/**
 * Computes the Live Proctor sidebar class tabs:
 * - In 'focus' (single-exam) mode when the exam targets specific classes, scopes the sidebar
 *   to those selected classes plus any class where a student has joined/submitted live.
 * - Otherwise includes all configured school classes plus any live-discovered classes.
 */
export function resolveProctorSidebarClasses(params: {
  schoolClasses: string[];
  monitoredTargetClasses: Array<string | undefined | null>;
  liveStudentClasses: string[];
  scope: 'focus' | 'all';
}): string[] {
  const { schoolClasses, monitoredTargetClasses, liveStudentClasses, scope } = params;
  const classesSet = new Set<string>();

  const schoolCanonicalByKey = new Map<string, string>();
  for (const sc of schoolClasses) {
    const trimmed = sc.trim();
    if (!trimmed) continue;
    schoolCanonicalByKey.set(normalizeTargetClassKey(trimmed), trimmed);
  }

  const resolvedTargets: string[] = [];
  for (const rawTarget of monitoredTargetClasses) {
    for (const t of parseTargetClassList(rawTarget)) {
      const canonical = schoolCanonicalByKey.get(normalizeTargetClassKey(t)) || t;
      resolvedTargets.push(canonical);
    }
  }

  if (scope === 'focus' && resolvedTargets.length > 0) {
    resolvedTargets.forEach((cls) => classesSet.add(cls));
  } else {
    schoolClasses.forEach((cls) => {
      const trimmed = cls.trim();
      if (trimmed) classesSet.add(trimmed);
    });
  }

  for (const liveCls of liveStudentClasses) {
    const trimmed = liveCls.trim() || 'Unassigned';
    classesSet.add(trimmed);
  }

  const list = Array.from(classesSet)
    .filter((c) => c !== 'Unassigned')
    .sort((a, b) => a.localeCompare(b));

  if (classesSet.has('Unassigned')) {
    list.push('Unassigned');
  }

  return list;
}
