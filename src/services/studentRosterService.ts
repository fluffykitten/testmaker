// ─── School Student Roster Service ─────────────────────────────────────────────
// Manages the centralized student directory, class assignments, room/seat allocation,
// and 4-digit exam PINs. Synchronizes with Supabase app_config (school_roster).

import { supabase } from '../lib/supabase';
import * as XLSX from 'xlsx';
import { exportFileUniversal } from './fileExportBridge';
import {
  type ExamScheduleEntry,
  formatRoomWithGender,
  normalizeClassLabel,
  sortClassNames,
} from '../lib/examSchedule';

export interface RosterStudent {
  id: string;               // Unique ID
  name: string;             // Candidate full name
  class: string;            // e.g. "X IPA 1", "X IPS 2", "10-A"
  candidateNumber?: string; // Candidate / Roll number / NIS (optional)
  room?: string;            // Exam room allocation (e.g. "Room 1 - Akhwat")
  seatNumber?: string;      // Desk / Seat number inside the room (e.g. "13")
  pin: string;              // 4-digit PIN (e.g. "4821")
  createdAt?: string;
}

export interface PublicRosterStudent {
  id: string;
  name: string;
  class: string;
  candidateNumber?: string;
}

export interface AutoPlacementNote {
  name: string;
  class: string;
  candidateNumber?: string;
  room: string;
  seatNumber: string;
}

export interface ExcelRosterParseResult {
  students: RosterStudent[];
  detectedClasses: string[];
  format: 'icm_workbook' | 'tabular';
  sourceSummary?: string;
  autoPlacements?: AutoPlacementNote[];
  detectedSchedule?: ExamScheduleEntry[];
}

export interface RosterImportPlan {
  syncedRosterPruned: RosterStudent[];
  mergedRosterKeepExtras: RosterStudent[];
  preservedPinCount: number;
  addedStudents: RosterStudent[];
  updatedRoomSeatCount: number;
  extraStudentsToPrune: RosterStudent[];
  normalizedClasses: string[];
  addedClasses: string[];
  renamedClasses: Array<{ from: string; to: string }>;
}

const ROSTER_STORAGE_KEY = 'testmaker_school_student_roster';

/**
 * Generates a random 4-digit PIN between 1000 and 9999
 */
export function generateRandom4DigitPin(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/**
 * Reads the cached student roster from localStorage.
 */
export function getSchoolRoster(): RosterStudent[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(ROSTER_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error('Failed to load local student roster:', err);
    return [];
  }
}

/**
 * Saves student roster locally and syncs to Supabase app_config cloud store.
 */
export async function saveSchoolRoster(roster: RosterStudent[]): Promise<boolean> {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(ROSTER_STORAGE_KEY, JSON.stringify(roster));
    } catch (err) {
      console.warn('Failed to cache student roster to localStorage:', err);
    }
  }

  try {
    const { error } = await (supabase.from('app_config' as any) as any).upsert({
      key: 'school_roster',
      value: JSON.stringify(roster),
    });

    if (error) {
      console.warn('Cloud sync error for school_roster:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Network error while saving school_roster:', err);
    return false;
  }
}

/**
 * Loads student roster from Supabase cloud if available, updating the local cache.
 */
export async function loadAndSyncSchoolRoster(): Promise<RosterStudent[]> {
  const localRoster = getSchoolRoster();

  try {
    const { data, error } = (await (supabase.from('app_config' as any) as any)
      .select('value')
      .eq('key', 'school_roster')
      .maybeSingle()) as { data: { value: string } | null; error: any };

    if (!error && data?.value) {
      const parsed = JSON.parse(data.value);
      if (Array.isArray(parsed)) {
        const cleaned: RosterStudent[] = parsed
          .map((item) => ({
            id: String(item.id || crypto.randomUUID()),
            name: String(item.name || '').trim(),
            class: String(item.class || '').trim(),
            candidateNumber: item.candidateNumber ? String(item.candidateNumber).trim() : undefined,
            room: item.room ? String(item.room).trim() : undefined,
            seatNumber: item.seatNumber ? String(item.seatNumber).trim() : undefined,
            pin: String(item.pin || generateRandom4DigitPin()).trim(),
            createdAt: item.createdAt || new Date().toISOString(),
          }))
          .filter((s) => s.name.length > 0);

        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(ROSTER_STORAGE_KEY, JSON.stringify(cleaned));
        }
        return cleaned;
      }
    }
  } catch (err) {
    console.warn('Could not fetch school roster from cloud, using local cache:', err);
  }

  return localRoster;
}

/**
 * Fetches the public student directory (names, classes, candidate numbers) WITHOUT PINs.
 * Used by the student lobby for autocomplete.
 */
export async function fetchPublicRosterDirectory(): Promise<PublicRosterStudent[]> {
  try {
    // 1. Try Postgres RPC first (Direct, 0ms cold start, natively runs inside Supabase)
    const { data: rpcData, error: rpcError } = await (supabase as any).rpc('get_public_roster_directory');
    if (!rpcError && Array.isArray(rpcData)) {
      return rpcData;
    }

    // 2. Try Supabase Edge Function fallback
    const { data: edgeData, error: edgeError } = await supabase.functions.invoke('verify-student-pin', {
      body: { action: 'get-roster-directory' },
    });

    if (!edgeError && edgeData?.students && Array.isArray(edgeData.students) && edgeData.students.length > 0 && !edgeData.unconfigured) {
      return edgeData.students;
    }
  } catch (err) {
    console.warn('Network error fetching public roster directory:', err);
  }

  // 3. Fallback to local cache (Offline / Dev mode fallback)
  // Strip PINs locally just in case
  const localRoster = getSchoolRoster();
  return localRoster.map((s) => ({
    id: s.id,
    name: s.name,
    class: s.class,
    candidateNumber: s.candidateNumber,
  }));
}

/**
 * Securely verifies a student PIN server-side.
 */
export async function verifyStudentPin(
  name: string,
  studentClass: string,
  pin: string
): Promise<{ valid: boolean; error?: string; student?: PublicRosterStudent }> {
  const cleanName = name.trim().replace(/\s+/g, ' ');
  const cleanClass = normalizeClassLabel(studentClass);
  const cleanPin = pin.trim();

  try {
    // 1. Try Postgres RPC first (Direct, zero cold start, natively runs inside Supabase)
    const { data: rpcData, error: rpcError } = await (supabase as any).rpc('verify_student_pin', {
      p_name: cleanName,
      p_class: cleanClass,
      p_pin: cleanPin,
    });

    if (!rpcError && rpcData) {
      if (!rpcData.unconfigured) {
        return rpcData;
      }
      console.warn('Cloud roster unconfigured in Postgres RPC, attempting Edge function or local fallback.');
    }

    // 2. Try Supabase Edge Function fallback
    const { data: edgeData, error: edgeError } = await supabase.functions.invoke('verify-student-pin', {
      body: { name: cleanName, class: cleanClass, pin: cleanPin },
    });

    if (!edgeError && edgeData) {
      if (!edgeData.unconfigured) {
        return edgeData;
      }
      console.warn('Cloud roster unconfigured in Edge function, attempting local fallback.');
    }
  } catch (err) {
    console.warn('Network error verifying student PIN:', err);
  }

  // 3. Fallback to local cache (Offline / Dev mode fallback)
  console.warn('⚠️ Falling back to local offline roster validation.');
  const localRoster = getSchoolRoster();
  if (localRoster.length === 0) {
    return {
      valid: false,
      error:
        'Could not verify PIN with the exam server and no offline roster is cached on this device. Please check your connection or contact your invigilator.',
    };
  }

  const normalizedQueryClass = cleanClass.toLowerCase();
  const foundCandidate = localRoster.find(
    (s) =>
      s.name.trim().replace(/\s+/g, ' ').toLowerCase() === cleanName.toLowerCase() &&
      (!cleanClass || normalizeClassLabel(s.class).toLowerCase() === normalizedQueryClass)
  );

  if (!foundCandidate) {
    return {
      valid: false,
      error: `Candidate "${cleanName}" was not found in the local offline roster. Please verify with your teacher.`,
    };
  }

  if (foundCandidate.pin.trim() !== cleanPin) {
    return {
      valid: false,
      error: `❌ Incorrect 4-digit PIN for ${foundCandidate.name}. Please verify with your teacher.`,
    };
  }

  return {
    valid: true,
    student: {
      id: foundCandidate.id,
      name: foundCandidate.name,
      class: foundCandidate.class,
      candidateNumber: foundCandidate.candidateNumber,
    },
  };
}

/**
 * Allocates a 4-digit numeric PIN unique across the entire school roster.
 * Preserves `preferredPin` when valid and unclaimed; falls back to sequential scan
 * if random draws are saturated (> 8900 entries).
 */
function allocateUniqueSchoolPin(usedPins: Set<string>, preferredPin?: string): string {
  const cleanPreferred = String(preferredPin || '').trim();
  const isValid4Digit = cleanPreferred.length === 4 && /^\d{4}$/.test(cleanPreferred);

  if (isValid4Digit && (usedPins.size >= 9000 || !usedPins.has(cleanPreferred))) {
    usedPins.add(cleanPreferred);
    return cleanPreferred;
  }

  if (usedPins.size < 9000) {
    for (let attempt = 0; attempt < 64; attempt++) {
      const candidate = generateRandom4DigitPin();
      if (!usedPins.has(candidate)) {
        usedPins.add(candidate);
        return candidate;
      }
    }
    for (let code = 1000; code <= 9999; code++) {
      const candidate = String(code);
      if (!usedPins.has(candidate)) {
        usedPins.add(candidate);
        return candidate;
      }
    }
  }

  const fallback = generateRandom4DigitPin();
  usedPins.add(fallback);
  return fallback;
}

/**
 * Ensures all students have a valid 4-digit PIN unique across the school,
 * generating or de-duplicating PINs when missing, malformed, or colliding.
 */
export function assignMissingPins(roster: RosterStudent[]): RosterStudent[] {
  const usedPins = new Set<string>();

  return roster.map((student) => ({
    ...student,
    pin: allocateUniqueSchoolPin(usedPins, student.pin),
  }));
}

/**
 * Regenerates brand new 4-digit PINs unique across the entire school roster.
 */
export function regenerateAllPins(roster: RosterStudent[]): RosterStudent[] {
  const usedPins = new Set<string>();

  return roster.map((student) => ({
    ...student,
    pin: allocateUniqueSchoolPin(usedPins),
  }));
}

/**
 * Normalizes class spacing (e.g. "X IPA3" -> "X IPA 3") across an existing roster and class list.
 */
export function normalizeRosterAndClasses(
  roster: RosterStudent[],
  classes: string[]
): {
  roster: RosterStudent[];
  classes: string[];
  renamedClasses: Array<{ from: string; to: string }>;
} {
  const renamedMap = new Map<string, string>();
  const normalizedClassSet = new Set<string>();

  for (const raw of classes) {
    const clean = String(raw || '').trim();
    if (!clean) continue;
    const normalized = normalizeClassLabel(clean);
    if (clean !== normalized) {
      renamedMap.set(clean, normalized);
    }
    normalizedClassSet.add(normalized);
  }

  const nextRoster = roster.map((s) => {
    const cleanCls = String(s.class || '').trim();
    const normalizedCls = normalizeClassLabel(cleanCls) || 'General';
    if (cleanCls && cleanCls !== normalizedCls) {
      renamedMap.set(cleanCls, normalizedCls);
    }
    if (normalizedCls !== 'General') {
      normalizedClassSet.add(normalizedCls);
    }
    const normalizedRoom = s.room ? formatRoomWithGender(s.room) : undefined;
    return {
      ...s,
      class: normalizedCls,
      room: normalizedRoom || s.room,
      seatNumber: s.seatNumber ? String(s.seatNumber).trim() : undefined,
    };
  });

  const renamedClasses = Array.from(renamedMap.entries()).map(([from, to]) => ({ from, to }));
  return {
    roster: nextRoster,
    classes: sortClassNames(Array.from(normalizedClassSet)),
    renamedClasses,
  };
}

/**
 * Parses raw copied text (from Excel, Google Sheets, or CSV) into roster students.
 * Supports:
 * - Tab-separated / CSV: Name, Class, CandidateNumber, PIN, Room, Seat
 */
export function parseBulkRosterText(rawText: string, defaultClass: string = '10-A'): RosterStudent[] {
  if (!rawText || !rawText.trim()) return [];

  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const results: RosterStudent[] = [];
  const usedPins = new Set<string>();

  for (const line of lines) {
    if (/^(name|student\s*name|candidate|nama)/i.test(line)) continue;

    let parts: string[] = [];
    if (line.includes('\t')) {
      parts = line.split('\t').map((p) => p.trim());
    } else if (line.includes(',')) {
      parts = line.split(',').map((p) => p.trim());
    } else if (line.includes(';')) {
      parts = line.split(';').map((p) => p.trim());
    } else {
      parts = [line];
    }

    const name = (parts[0] || '').trim();
    if (!name) continue;

    const studentClass = normalizeClassLabel(parts[1] || defaultClass || 'General') || 'General';
    const candidateNumber = parts[2]?.trim() || undefined;
    const rawCol4 = (parts[3] || '').trim();
    const digitsOnlyPin = rawCol4.replace(/\D/g, '');
    const preferredPin = digitsOnlyPin.length === 4 ? digitsOnlyPin : '';
    const room = parts[4]?.trim() ? formatRoomWithGender(parts[4]) : undefined;
    const seatNumber = parts[5]?.trim() || undefined;
    const pin = allocateUniqueSchoolPin(usedPins, preferredPin);

    results.push({
      id: crypto.randomUUID(),
      name,
      class: studentClass,
      candidateNumber,
      room,
      seatNumber,
      pin,
      createdAt: new Date().toISOString(),
    });
  }

  return results;
}

/**
 * Exports the student roster, room/seat assignments, and PIN slips as an Excel (.xlsx) file.
 */
export function exportRosterToExcel(roster: RosterStudent[], classFilter?: string): void {
  const filtered =
    classFilter && classFilter !== 'ALL'
      ? roster.filter((s) => normalizeClassLabel(s.class) === normalizeClassLabel(classFilter))
      : roster;

  if (filtered.length === 0) return;

  const data = filtered.map((s, idx) => ({
    'No.': idx + 1,
    'Class / Cohort': s.class,
    'Candidate Full Name': s.name,
    'Candidate Number': s.candidateNumber || '-',
    'Room': s.room || '-',
    'Seat #': s.seatNumber || '-',
    '4-Digit Exam PIN': s.pin,
  }));

  const worksheet = XLSX.utils.json_to_sheet(data);
  worksheet['!cols'] = [
    { wch: 6 },
    { wch: 16 },
    { wch: 30 },
    { wch: 16 },
    { wch: 20 },
    { wch: 10 },
    { wch: 16 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Class Roster & PINs');

  const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([excelBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  const fileName =
    classFilter && classFilter !== 'ALL'
      ? `Student_Roster_${classFilter.replace(/[^a-zA-Z0-9]/g, '_')}_PINs.xlsx`
      : `School_Student_Roster_All_Classes_PINs.xlsx`;

  exportFileUniversal(blob, fileName);
}

function normalizePersonName(name: string): string {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function findColumnKey(keys: string[], patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const hit = keys.find((k) => pattern.test(k.trim()));
    if (hit) return hit;
  }
  return undefined;
}

function formatExcelDateCell(rawDate: string): string {
  const trimmed = String(rawDate || '').trim();
  if (!trimmed) return '';
  // Shorten "Monday, 30 November 2026" -> "Mon, 30 Nov 2026" for compact desk cards
  const fullDateMatch = trimmed.match(/^([A-Za-z]+),?\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (fullDateMatch) {
    const dayShort = fullDateMatch[1].slice(0, 3);
    const dayNum = fullDateMatch[2];
    const monShort = fullDateMatch[3].slice(0, 3);
    const yr = fullDateMatch[4];
    return `${dayShort}, ${dayNum} ${monShort} ${yr}`;
  }
  return trimmed;
}

function normalizeSubjectLabel(rawSubject: string): string {
  const cleaned = String(rawSubject || '').trim();
  if (/^physic$/i.test(cleaned)) return 'Physics';
  if (/^bio$/i.test(cleaned)) return 'Biology';
  if (/^geo$/i.test(cleaned)) return 'Geography';
  if (/^chem$/i.test(cleaned)) return 'Chemistry';
  return cleaned;
}

function parseIcmTimetableWorksheet(worksheet: XLSX.WorkSheet): ExamScheduleEntry[] {
  const rows: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', raw: false });
  const practical: ExamScheduleEntry[] = [];
  const written: ExamScheduleEntry[] = [];

  let pracDate = '';
  let writDate = '';
  let seq = 0;

  for (const row of rows) {
    // Practical section sits in columns 1..4 (Day & Date, Time, Subject, Duration)
    const pDateCell = String(row[1] || '').trim();
    const pTimeCell = String(row[2] || '').trim();
    const pSubjCell = String(row[3] || '').trim();
    const pDurCell = String(row[4] || '').trim();

    if (/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\d)/i.test(pDateCell)) {
      pracDate = formatExcelDateCell(pDateCell);
    }
    if (pracDate && pSubjCell && !/^subject$/i.test(pSubjCell) && !/break\s*time/i.test(pSubjCell)) {
      seq++;
      practical.push({
        id: `icm-prac-${seq}`,
        date: pracDate,
        time: '07.30 / 09.00 / 10.30',
        subject: `Practical: ${normalizeSubjectLabel(pSubjCell)}`,
        duration: pDurCell || "60'",
        targetClass: 'X IPA',
        category: 'practical',
      });
    } else if (pracDate && pTimeCell && !pSubjCell && practical.length > 0 && !/time/i.test(pTimeCell)) {
      // Subsequent shift slot under the same practical day already summarized above
    }

    // Written section sits in columns 7..10 (Day & Date, Time, Subject, Duration)
    const wDateCell = String(row[7] || '').trim();
    const wTimeCell = String(row[8] || '').trim();
    const wSubjCell = String(row[9] || '').trim();
    const wDurCell = String(row[10] || '').trim();

    if (/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\d)/i.test(wDateCell)) {
      writDate = formatExcelDateCell(wDateCell);
    }
    if (
      writDate &&
      wTimeCell &&
      wSubjCell &&
      !/^subject$/i.test(wSubjCell) &&
      !/break\s*time/i.test(wSubjCell)
    ) {
      const normalizedTime = wTimeCell.replace(/\s*[–—-]\s*/g, ' - ');
      const durationNorm = wDurCell ? (/['’]$/.test(wDurCell) ? wDurCell.replace(/’/g, "'") : `${wDurCell}'`) : '';

      if (wSubjCell.includes('/')) {
        const parts = wSubjCell.split('/').map((p) => normalizeSubjectLabel(p));
        if (parts[0]) {
          seq++;
          written.push({
            id: `icm-writ-${seq}`,
            date: writDate,
            time: normalizedTime,
            subject: parts[0],
            duration: durationNorm,
            targetClass: 'IPA',
            category: 'written',
          });
        }
        if (parts[1]) {
          seq++;
          written.push({
            id: `icm-writ-${seq}`,
            date: writDate,
            time: normalizedTime,
            subject: parts[1],
            duration: durationNorm,
            targetClass: 'IPS',
            category: 'written',
          });
        }
      } else {
        seq++;
        const isGrade10Only = /\bg\.?\s*10\b|\bgrade\s*10\b/i.test(wSubjCell);
        written.push({
          id: `icm-writ-${seq}`,
          date: writDate,
          time: normalizedTime,
          subject: normalizeSubjectLabel(wSubjCell),
          duration: durationNorm,
          targetClass: isGrade10Only ? 'X' : 'ALL',
          category: 'written',
        });
      }
    }
  }

  return [...practical, ...written];
}

function parseIcmMultiSheetWorkbook(workbook: XLSX.WorkBook): ExcelRosterParseResult | null {
  const rosterSheetName = workbook.SheetNames.find((n) => /daftar.*siswa.*26.?27/i.test(n));
  if (!rosterSheetName) return null;

  const rosterRows: any[][] = XLSX.utils.sheet_to_json(workbook.Sheets[rosterSheetName], {
    header: 1,
    defval: '',
    raw: false,
  });

  const baseStudents: Array<{
    name: string;
    class: string;
    candidateNumber: string;
  }> = [];
  const seenNis = new Set<string>();
  const detectedClassesSet = new Set<string>();

  for (const r of rosterRows) {
    const no = String(r[0] || '').trim();
    const nis = String(r[1] || '').trim();
    const rawCls = String(r[2] || '').trim();
    const name = String(r[3] || '').trim().replace(/\s+/g, ' ');
    if (/^\d+$/.test(no) && /^\d{6,12}$/.test(nis) && rawCls && name) {
      if (seenNis.has(nis)) continue;
      seenNis.add(nis);
      const cls = normalizeClassLabel(rawCls);
      detectedClassesSet.add(cls);
      baseStudents.push({ name, class: cls, candidateNumber: nis });
    }
  }

  if (baseStudents.length === 0) return null;

  // Build authoritative Room + Seat lookup from "Copy of PEMBAGIAN RUANGAN"
  const roomByNis = new Map<string, { room: string; seatNumber: string; cls: string }>();
  const roomByName = new Map<string, { room: string; seatNumber: string; cls: string }>();
  const usedSeatsByRoom = new Map<string, Set<number>>();
  const classGenderRooms = new Map<string, Set<string>>();

  const recordRoomAssignment = (
    roomLabel: string,
    seatStr: string,
    nis: string,
    name: string,
    cls: string
  ) => {
    const cleanRoom = formatRoomWithGender(roomLabel);
    const cleanSeat = String(parseInt(seatStr, 10) || seatStr).trim();
    if (!cleanRoom || !cleanSeat) return;

    const payload = { room: cleanRoom, seatNumber: cleanSeat, cls: normalizeClassLabel(cls) };
    if (nis && !roomByNis.has(nis)) {
      roomByNis.set(nis, payload);
    }
    const nameKey = normalizePersonName(name);
    if (nameKey && !roomByName.has(nameKey)) {
      roomByName.set(nameKey, payload);
    }

    const seatNum = parseInt(cleanSeat, 10);
    if (!Number.isNaN(seatNum)) {
      if (!usedSeatsByRoom.has(cleanRoom)) usedSeatsByRoom.set(cleanRoom, new Set());
      usedSeatsByRoom.get(cleanRoom)!.add(seatNum);
    }

    const normCls = normalizeClassLabel(cls);
    if (normCls) {
      if (!classGenderRooms.has(normCls)) classGenderRooms.set(normCls, new Set());
      classGenderRooms.get(normCls)!.add(cleanRoom);
    }
  };

  const pembagianSheetName = workbook.SheetNames.find((n) =>
    /copy of pembagian ruangan|pembagian ruangan/i.test(n)
  );
  if (pembagianSheetName) {
    const pRows: any[][] = XLSX.utils.sheet_to_json(workbook.Sheets[pembagianSheetName], {
      header: 1,
      defval: '',
      raw: false,
    });
    let leftHeaderCol = -1;
    let rightHeaderCol = -1;
    let leftRoom = '';
    let rightRoom = '';

    for (const r of pRows) {
      for (let c = 0; c < r.length; c++) {
        const val = String(r[c] || '').trim();
        if (/^ruang\s*\d+/i.test(val)) {
          if (c < 6) {
            leftRoom = formatRoomWithGender(val);
            leftHeaderCol = c;
          } else {
            rightRoom = formatRoomWithGender(val);
            rightHeaderCol = c;
          }
        }
      }

      const lBase = leftHeaderCol >= 0 ? leftHeaderCol : 1;
      const lNo = String(r[lBase] || '').trim();
      const lNis = String(r[lBase + 1] || '').trim();
      const lName = String(r[lBase + 2] || '').trim();
      const lCls = String(r[lBase + 3] || '').trim();
      if (leftRoom && /^\d+$/.test(lNo) && /^\d{6,12}$/.test(lNis) && lName) {
        recordRoomAssignment(leftRoom, lNo, lNis, lName, lCls);
      }

      const rBase = rightHeaderCol >= 0 ? rightHeaderCol : 8;
      const rNo = String(r[rBase] || '').trim();
      const rNis = String(r[rBase + 1] || '').trim();
      const rName = String(r[rBase + 2] || '').trim();
      const rCls = String(r[rBase + 3] || '').trim();
      if (rightRoom && /^\d+$/.test(rNo) && /^\d{6,12}$/.test(rNis) && rName) {
        recordRoomAssignment(rightRoom, rNo, rNis, rName, rCls);
      }
    }
  }

  // Fill any missing room assignments from ROOM 1..11 left tables (strictly rows < 35 to avoid 2025/2026 copies)
  const roomArrangementSheets = workbook.SheetNames.filter((n) => /^room\s+\d+\s+seating/i.test(n));
  for (const rn of roomArrangementSheets) {
    const roomNumMatch = rn.match(/^room\s+(\d+)/i);
    const roomNum = roomNumMatch ? parseInt(roomNumMatch[1], 10) : 0;
    if (!roomNum) continue;
    const inferredGender = roomNum <= 5 ? 'Akhwat' : 'Ikhwan';
    const roomLabel = `Room ${roomNum} - ${inferredGender}`;
    const rRows: any[][] = XLSX.utils.sheet_to_json(workbook.Sheets[rn], {
      header: 1,
      defval: '',
      raw: false,
    });
    for (let i = 0; i < Math.min(35, rRows.length); i++) {
      const r = rRows[i];
      const no = String(r[0] || '').trim();
      const nis = String(r[1] || '').trim();
      const name = String(r[2] || '').trim();
      const cls = String(r[3] || '').trim();
      if (/^\d+$/.test(no) && /^\d{6,12}$/.test(nis) && name && !roomByNis.has(nis)) {
        recordRoomAssignment(roomLabel, no, nis, name, cls);
      }
    }
  }

  const knownRoomsOrdered = Array.from(usedSeatsByRoom.keys()).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  );

  const autoPlacements: AutoPlacementNote[] = [];
  const usedPins = new Set<string>();
  const students: RosterStudent[] = [];

  for (const item of baseStudents) {
    const matchedRoom = roomByNis.get(item.candidateNumber) || roomByName.get(normalizePersonName(item.name));
    let room = matchedRoom?.room;
    let seatNumber = matchedRoom?.seatNumber;

    // Auto-place any unassigned student into the least-full room for their class gender group
    if (!room || !seatNumber) {
      const peerRooms = Array.from(classGenderRooms.get(item.class) || []);
      const isAkhwatClass = peerRooms.some((pr) => /akhwat/i.test(pr));
      const isIkhwanClass = peerRooms.some((pr) => /ikhwan/i.test(pr));
      const candidateRooms = knownRoomsOrdered.filter((rm) => {
        if (isAkhwatClass && !isIkhwanClass) return /akhwat/i.test(rm);
        if (isIkhwanClass && !isAkhwatClass) return /ikhwan/i.test(rm);
        return peerRooms.length > 0 ? peerRooms.includes(rm) : true;
      });

      const targetRooms = candidateRooms.length > 0 ? candidateRooms : knownRoomsOrdered;
      let chosenRoom = '';
      let minOccupancy = Number.MAX_SAFE_INTEGER;
      for (const rm of targetRooms) {
        const occ = usedSeatsByRoom.get(rm)?.size || 0;
        if (occ < minOccupancy) {
          minOccupancy = occ;
          chosenRoom = rm;
        }
      }

      if (chosenRoom) {
        const seats = usedSeatsByRoom.get(chosenRoom) || new Set<number>();
        let nextSeat = 1;
        while (seats.has(nextSeat)) nextSeat++;
        seats.add(nextSeat);
        usedSeatsByRoom.set(chosenRoom, seats);
        room = chosenRoom;
        seatNumber = String(nextSeat);
        autoPlacements.push({
          name: item.name,
          class: item.class,
          candidateNumber: item.candidateNumber,
          room,
          seatNumber,
        });
      }
    }

    const pin = allocateUniqueSchoolPin(usedPins);

    students.push({
      id: crypto.randomUUID(),
      name: item.name,
      class: item.class,
      candidateNumber: item.candidateNumber,
      room,
      seatNumber,
      pin,
      createdAt: new Date().toISOString(),
    });
  }

  const timetableSheetName = workbook.SheetNames.find((n) => /time\s*table/i.test(n));
  const detectedSchedule = timetableSheetName
    ? parseIcmTimetableWorksheet(workbook.Sheets[timetableSheetName])
    : undefined;

  return {
    students,
    detectedClasses: sortClassNames(Array.from(detectedClassesSet)),
    format: 'icm_workbook',
    sourceSummary: `Parsed ICM workbook "${rosterSheetName}" (${students.length} candidates across ${detectedClassesSet.size} classes).`,
    autoPlacements,
    detectedSchedule: detectedSchedule && detectedSchedule.length > 0 ? detectedSchedule : undefined,
  };
}

/**
 * Synchronous workbook parser supporting both standard flat tabular rosters
 * (Name, Class, Candidate #, Room, Seat #, PIN) and multi-sheet ICM exam workbooks.
 */
export function parseExcelRosterWorkbook(data: ArrayBuffer | Uint8Array): ExcelRosterParseResult {
  const workbook = XLSX.read(data, { type: 'array' });

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error('The uploaded Excel file contains no worksheets.');
  }

  // 1. Auto-detect multi-sheet ICM workbook first
  const icmResult = parseIcmMultiSheetWorkbook(workbook);
  if (icmResult) {
    return icmResult;
  }

  // 2. Fallback to standard flat worksheet parsing
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  const rawRows: any[] = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

  if (!rawRows || rawRows.length === 0) {
    throw new Error('No data rows found in the uploaded worksheet.');
  }

  const detectedClassesSet = new Set<string>();
  const students: RosterStudent[] = [];
  const usedPins = new Set<string>();

  for (const row of rawRows) {
    const keys = Object.keys(row);

    const nameKey = findColumnKey(keys, [
      /^(student.*name|candidate.*name|full.*name|candidate|name|nama.*siswa|nama.*lengkap|nama|murid|peserta)$/i,
      /^(student.*name|candidate.*name|full.*name|candidate|name|nama)/i,
    ]);
    const classKey = findColumnKey(keys, [
      /^(class.*cohort|class|kelas|cohort|section|grade|tingkat|rombel)$/i,
      /^(class.*cohort|class|kelas|cohort|section|grade)/i,
    ]);
    const numberKey = findColumnKey(keys, [
      /^(candidate.*no|candidate.*num|candidate.*number|cand.*#|roll.*no|roll.*num|no.*peserta|id.*siswa|student.*id|nisn|nis)$/i,
      /^(candidate.*#|student.*number|id|no\.?)$/i,
    ]);
    const roomKey = findColumnKey(keys, [
      /^(exam.*room|room|ruang|ruangan|hall|venue)$/i,
      /^(exam.*room|room|ruang)/i,
    ]);
    const seatKey = findColumnKey(keys, [
      /^(seat.*no|seat.*num|seat.*#|seat|desk.*#|desk|kursi|no.*kursi|meja)$/i,
      /^(seat|desk|kursi)/i,
    ]);
    const pinKey = findColumnKey(keys, [
      /^(4.*digit.*pin|exam.*pin|pin|password|passcode)$/i,
      /(?:^|\b)(4.*digit.*pin|exam.*pin|pin)(?:\b|$)/i,
    ]);

    const nameVal = nameKey ? String(row[nameKey]).trim().replace(/\s+/g, ' ') : '';
    if (!nameVal) continue;

    const rawClassVal = classKey ? String(row[classKey]).trim() : 'General';
    const classVal = normalizeClassLabel(rawClassVal) || 'General';
    const numberVal = numberKey && numberKey !== seatKey ? String(row[numberKey]).trim() : undefined;
    const rawRoomVal = roomKey ? String(row[roomKey]).trim() : '';
    const roomVal = rawRoomVal && rawRoomVal !== '-' ? formatRoomWithGender(rawRoomVal) : undefined;
    const rawSeatVal = seatKey ? String(row[seatKey]).trim() : '';
    const seatVal = rawSeatVal && rawSeatVal !== '-' ? rawSeatVal : undefined;
    const rawPinDigits = pinKey ? String(row[pinKey]).replace(/\D/g, '').slice(0, 4) : '';

    if (classVal && classVal !== 'General') {
      detectedClassesSet.add(classVal);
    }

    const pinVal = allocateUniqueSchoolPin(usedPins, rawPinDigits);

    students.push({
      id: crypto.randomUUID(),
      name: nameVal,
      class: classVal,
      candidateNumber: numberVal && numberVal !== '-' ? numberVal : undefined,
      room: roomVal,
      seatNumber: seatVal,
      pin: pinVal,
      createdAt: new Date().toISOString(),
    });
  }

  return {
    students,
    detectedClasses: sortClassNames(Array.from(detectedClassesSet)),
    format: 'tabular',
    sourceSummary: `Parsed "${firstSheetName}" (${students.length} candidates across ${detectedClassesSet.size} classes).`,
  };
}

/**
 * Reads an uploaded Excel file (.xlsx, .xls, .csv) and extracts classes, students, rooms, seats, and PINs.
 */
export async function parseExcelRosterFile(file: File): Promise<ExcelRosterParseResult> {
  const buffer = await file.arrayBuffer();
  return parseExcelRosterWorkbook(buffer);
}

/**
 * Computes a PIN-preserving merge plan between the existing DB roster/classes and a parsed Excel import.
 * Existing students matched by Candidate # (NIS) or normalized Name retain their exact PIN and ID.
 */
export function planRosterExcelImport(
  existingRoster: RosterStudent[],
  existingClasses: string[],
  parseResult: ExcelRosterParseResult
): RosterImportPlan {
  const normState = normalizeRosterAndClasses(existingRoster, existingClasses);

  const byNis = new Map<string, RosterStudent>();
  const byNameClass = new Map<string, RosterStudent>();
  const byNameOnly = new Map<string, RosterStudent[]>();

  for (const existing of normState.roster) {
    const nisKey = String(existing.candidateNumber || '').trim();
    if (nisKey && !byNis.has(nisKey)) {
      byNis.set(nisKey, existing);
    }
    const nameKey = normalizePersonName(existing.name);
    const clsKey = normalizeClassLabel(existing.class).toLowerCase();
    byNameClass.set(`${clsKey}::${nameKey}`, existing);
    if (!byNameOnly.has(nameKey)) byNameOnly.set(nameKey, []);
    byNameOnly.get(nameKey)!.push(existing);
  }

  const matchedExistingIds = new Set<string>();
  const reservedPins = new Set<string>();
  const addedStudents: RosterStudent[] = [];
  const incomingMapped: RosterStudent[] = [];
  let preservedPinCount = 0;
  let updatedRoomSeatCount = 0;

  // Claim unique existing matched PINs first so newly generated or de-duplicated PINs never collide
  const matchedPairs: Array<{ incoming: RosterStudent; match?: RosterStudent; keepPin?: string }> = [];
  for (const incoming of parseResult.students) {
    const nisKey = String(incoming.candidateNumber || '').trim();
    const nameKey = normalizePersonName(incoming.name);
    const clsKey = normalizeClassLabel(incoming.class).toLowerCase();

    let match =
      (nisKey ? byNis.get(nisKey) : undefined) || byNameClass.get(`${clsKey}::${nameKey}`);
    if (!match) {
      const sameNameMatches = byNameOnly.get(nameKey) || [];
      if (sameNameMatches.length === 1 && !matchedExistingIds.has(sameNameMatches[0].id)) {
        match = sameNameMatches[0];
      }
    }

    if (match && !matchedExistingIds.has(match.id)) {
      matchedExistingIds.add(match.id);
      const rawExistingPin = match.pin?.trim() || '';
      const canReserve = rawExistingPin.length === 4 && /^\d{4}$/.test(rawExistingPin) && !reservedPins.has(rawExistingPin);
      if (canReserve) {
        reservedPins.add(rawExistingPin);
      }
      matchedPairs.push({ incoming, match, keepPin: canReserve ? rawExistingPin : undefined });
    } else {
      matchedPairs.push({ incoming });
    }
  }

  for (const { incoming, match, keepPin } of matchedPairs) {
    const normCls = normalizeClassLabel(incoming.class) || 'General';
    const normRoom = incoming.room ? formatRoomWithGender(incoming.room) : undefined;
    const cleanSeat = incoming.seatNumber ? String(incoming.seatNumber).trim() : undefined;

    if (match) {
      let pin = keepPin || '';
      if (pin) {
        preservedPinCount++;
      } else {
        pin = allocateUniqueSchoolPin(reservedPins);
      }

      if (match.room !== normRoom || match.seatNumber !== cleanSeat) {
        updatedRoomSeatCount++;
      }

      incomingMapped.push({
        id: match.id,
        name: incoming.name,
        class: normCls,
        candidateNumber: incoming.candidateNumber || match.candidateNumber,
        room: normRoom ?? match.room,
        seatNumber: cleanSeat ?? match.seatNumber,
        pin,
        createdAt: match.createdAt || incoming.createdAt || new Date().toISOString(),
      });
    } else {
      const preferredNewPin = incoming.pin && /^\d{4}$/.test(incoming.pin.trim()) ? incoming.pin.trim() : undefined;
      const pin = allocateUniqueSchoolPin(reservedPins, preferredNewPin);

      const added: RosterStudent = {
        ...incoming,
        class: normCls,
        room: normRoom,
        seatNumber: cleanSeat,
        pin,
      };
      addedStudents.push(added);
      incomingMapped.push(added);
    }
  }

  const extraStudentsToPrune = normState.roster.filter((s) => !matchedExistingIds.has(s.id));
  const mergedRosterKeepExtras = assignMissingPins([...incomingMapped, ...extraStudentsToPrune]);
  const syncedRosterPruned = assignMissingPins(incomingMapped);

  const existingClassSet = new Set(normState.classes);
  const addedClasses = parseResult.detectedClasses.filter(
    (cls) => cls && !existingClassSet.has(normalizeClassLabel(cls))
  );
  const normalizedClasses = sortClassNames(
    Array.from(new Set([...normState.classes, ...parseResult.detectedClasses.map(normalizeClassLabel)]))
  );

  return {
    syncedRosterPruned,
    mergedRosterKeepExtras,
    preservedPinCount,
    addedStudents,
    updatedRoomSeatCount,
    extraStudentsToPrune,
    normalizedClasses,
    addedClasses,
    renamedClasses: normState.renamedClasses,
  };
}

/**
 * Downloads a sample Excel template for importing classes, students, rooms, seats, and PINs.
 */
export function downloadSampleExcelTemplate(): void {
  const sampleData = [
    {
      'Class / Cohort': 'X IPA 1',
      'Candidate Full Name': 'Amando Saktika Ardhani',
      'Candidate Number': '262710066',
      'Room': 'Room 6 - Ikhwan',
      'Seat #': '1',
      '4-Digit PIN (Optional)': '4821',
    },
    {
      'Class / Cohort': 'X IPA 2',
      'Candidate Full Name': 'Carissa Zhafira Ziaramadhan',
      'Candidate Number': '262710014',
      'Room': 'Room 1 - Akhwat',
      'Seat #': '1',
      '4-Digit PIN (Optional)': '5934',
    },
    {
      'Class / Cohort': 'X IPS 2',
      'Candidate Full Name': 'Alya Murti Noor Ramadhianti',
      'Candidate Number': '262710004',
      'Room': 'Room 1 - Akhwat',
      'Seat #': '4',
      '4-Digit PIN (Optional)': '',
    },
  ];

  const worksheet = XLSX.utils.json_to_sheet(sampleData);
  worksheet['!cols'] = [
    { wch: 16 },
    { wch: 28 },
    { wch: 18 },
    { wch: 18 },
    { wch: 10 },
    { wch: 22 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Students & Classes Template');

  const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([excelBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  exportFileUniversal(blob, 'Students_and_Classes_Template.xlsx');
}
