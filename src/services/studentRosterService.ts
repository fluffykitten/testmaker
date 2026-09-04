// ─── School Student Roster Service ─────────────────────────────────────────────
// Manages the centralized student directory, class assignments, and 4-digit exam PINs.
// Synchronizes with Supabase app_config (school_roster) with local storage caching.

import { supabase } from '../lib/supabase';
import * as XLSX from 'xlsx';
import { exportFileUniversal } from './fileExportBridge';

export interface RosterStudent {
  id: string;               // Unique ID
  name: string;             // Candidate full name
  class: string;            // e.g. "10-A", "11-B"
  candidateNumber?: string; // Candidate / Roll number (optional)
  pin: string;              // 4-digit PIN (e.g. "4821")
  createdAt?: string;
}

export interface PublicRosterStudent {
  id: string;
  name: string;
  class: string;
  candidateNumber?: string;
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
  try {
    localStorage.setItem(ROSTER_STORAGE_KEY, JSON.stringify(roster));
  } catch (err) {
    console.warn('Failed to cache student roster to localStorage:', err);
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
        const cleaned: RosterStudent[] = parsed.map((item) => ({
          id: String(item.id || crypto.randomUUID()),
          name: String(item.name || '').trim(),
          class: String(item.class || '').trim(),
          candidateNumber: item.candidateNumber ? String(item.candidateNumber).trim() : undefined,
          pin: String(item.pin || generateRandom4DigitPin()).trim(),
          createdAt: item.createdAt || new Date().toISOString(),
        })).filter((s) => s.name.length > 0);

        localStorage.setItem(ROSTER_STORAGE_KEY, JSON.stringify(cleaned));
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
    if (!rpcError && Array.isArray(rpcData) && rpcData.length > 0) {
      return rpcData;
    }

    // 2. Try Supabase Edge Function fallback
    const { data: edgeData, error: edgeError } = await supabase.functions.invoke('verify-student-pin', {
      body: { action: 'get-roster-directory' }
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
  return localRoster.map(s => ({
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
  const cleanClass = studentClass.trim().replace(/\s+/g, ' ');
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
      body: { name: cleanName, class: cleanClass, pin: cleanPin }
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
  
  const foundCandidate = localRoster.find(
    (s) =>
      s.name.trim().replace(/\s+/g, ' ').toLowerCase() === cleanName.toLowerCase() &&
      (!cleanClass || s.class.trim().replace(/\s+/g, ' ').toLowerCase() === cleanClass.toLowerCase())
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
    }
  };
}

/**
 * Ensures all students have a valid 4-digit PIN, generating one if missing or malformed.
 */
export function assignMissingPins(roster: RosterStudent[]): RosterStudent[] {
  const usedPins = new Set<string>();

  return roster.map((student) => {
    let pin = student.pin ? student.pin.trim() : '';
    if (!pin || pin.length !== 4 || isNaN(Number(pin)) || usedPins.has(`${student.class}_${pin}`)) {
      do {
        pin = generateRandom4DigitPin();
      } while (usedPins.has(`${student.class}_${pin}`));
    }
    usedPins.add(`${student.class}_${pin}`);

    return {
      ...student,
      pin,
    };
  });
}

/**
 * Regenerates brand new 4-digit PINs for all students in the roster.
 */
export function regenerateAllPins(roster: RosterStudent[]): RosterStudent[] {
  const usedPins = new Set<string>();

  return roster.map((student) => {
    let pin = '';
    do {
      pin = generateRandom4DigitPin();
    } while (usedPins.has(`${student.class}_${pin}`));
    usedPins.add(`${student.class}_${pin}`);

    return {
      ...student,
      pin,
    };
  });
}

/**
 * Parses raw copied text (from Excel, Google Sheets, or CSV) into roster students.
 * Supports:
 * - Tab-separated (Excel paste): Name \t Class \t CandidateNumber \t PIN
 * - Comma-separated: Name, Class, CandidateNumber, PIN
 * - Line-separated names with default class
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
    // Skip header lines
    if (/^(name|student\s*name|candidate|nama)/i.test(line)) continue;

    // Detect delimiter: tab vs comma vs semicolon
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

    const name = parts[0] || '';
    if (!name) continue;

    const studentClass = parts[1] || defaultClass || 'General';
    const candidateNumber = parts[2] || undefined;
    let pin = parts[3] ? parts[3].replace(/\D/g, '').slice(0, 4) : '';

    if (!pin || pin.length !== 4) {
      do {
        pin = generateRandom4DigitPin();
      } while (usedPins.has(`${studentClass}_${pin}`));
    }
    usedPins.add(`${studentClass}_${pin}`);

    results.push({
      id: crypto.randomUUID(),
      name,
      class: studentClass,
      candidateNumber,
      pin,
      createdAt: new Date().toISOString(),
    });
  }

  return results;
}

/**
 * Exports the student roster and PIN slips as an Excel (.xlsx) file.
 */
export function exportRosterToExcel(roster: RosterStudent[], classFilter?: string): void {
  const filtered = classFilter && classFilter !== 'ALL'
    ? roster.filter((s) => s.class === classFilter)
    : roster;

  if (filtered.length === 0) return;

  const data = filtered.map((s, idx) => ({
    'No.': idx + 1,
    'Class / Cohort': s.class,
    'Candidate Full Name': s.name,
    'Candidate Number': s.candidateNumber || '-',
    '4-Digit Exam PIN': s.pin,
  }));

  const worksheet = XLSX.utils.json_to_sheet(data);

  // Set column widths
  worksheet['!cols'] = [
    { wch: 6 },
    { wch: 16 },
    { wch: 28 },
    { wch: 18 },
    { wch: 16 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Class Roster & PINs');

  const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([excelBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  const fileName = classFilter && classFilter !== 'ALL'
    ? `Student_Roster_${classFilter.replace(/[^a-zA-Z0-9]/g, '_')}_PINs.xlsx`
    : `School_Student_Roster_All_Classes_PINs.xlsx`;

  exportFileUniversal(blob, fileName);
}

/**
 * Reads an uploaded Excel file (.xlsx, .xls, .csv) and extracts:
 * - List of unique classes gathered from the sheet.
 * - List of students belonging to each class with 4-digit PINs.
 */
export async function parseExcelRosterFile(file: File): Promise<{
  students: RosterStudent[];
  detectedClasses: string[];
}> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });

  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error('The uploaded Excel file contains no worksheets.');
  }

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

    const nameKey = keys.find((k) =>
      /^(student.*name|candidate.*name|full.*name|candidate|name|nama.*siswa|nama.*lengkap|nama|murid|peserta)/i.test(k.trim())
    );
    const classKey = keys.find((k) =>
      /^(class.*cohort|class|kelas|cohort|section|grade|tingkat|rombel)/i.test(k.trim())
    );
    const numberKey = keys.find((k) =>
      /^(candidate.*no|candidate.*num|roll.*no|roll.*num|no.*peserta|id.*siswa|student.*id|cand.*#|nisn|nis|id|no)/i.test(k.trim())
    );
    const pinKey = keys.find((k) =>
      /^(4.*digit.*pin|pin|exam.*pin|password|passcode)/i.test(k.trim())
    );

    const nameVal = nameKey ? String(row[nameKey]).trim() : '';
    if (!nameVal) continue;

    const classVal = classKey ? String(row[classKey]).trim() : 'General';
    const numberVal = numberKey ? String(row[numberKey]).trim() : undefined;
    let pinVal = pinKey ? String(row[pinKey]).replace(/\D/g, '').slice(0, 4) : '';

    if (classVal && classVal !== 'General') {
      detectedClassesSet.add(classVal);
    }

    if (!pinVal || pinVal.length !== 4) {
      do {
        pinVal = generateRandom4DigitPin();
      } while (usedPins.has(`${classVal}_${pinVal}`));
    }
    usedPins.add(`${classVal}_${pinVal}`);

    students.push({
      id: crypto.randomUUID(),
      name: nameVal,
      class: classVal,
      candidateNumber: numberVal || undefined,
      pin: pinVal,
      createdAt: new Date().toISOString(),
    });
  }

  return {
    students,
    detectedClasses: Array.from(detectedClassesSet).sort(),
  };
}

/**
 * Downloads a sample Excel template for importing classes and students.
 */
export function downloadSampleExcelTemplate(): void {
  const sampleData = [
    {
      'Class / Cohort': '10-A',
      'Candidate Full Name': 'Alex Johnson',
      'Candidate Number': '1001',
      '4-Digit PIN (Optional)': '4821',
    },
    {
      'Class / Cohort': '10-A',
      'Candidate Full Name': 'Samantha Lee',
      'Candidate Number': '1002',
      '4-Digit PIN (Optional)': '5934',
    },
    {
      'Class / Cohort': '10-B',
      'Candidate Full Name': 'David Miller',
      'Candidate Number': '1003',
      '4-Digit PIN (Optional)': '',
    },
    {
      'Class / Cohort': '11-Chemistry HL',
      'Candidate Full Name': 'Emily Davis',
      'Candidate Number': '1101',
      '4-Digit PIN (Optional)': '',
    },
  ];

  const worksheet = XLSX.utils.json_to_sheet(sampleData);
  worksheet['!cols'] = [
    { wch: 18 },
    { wch: 26 },
    { wch: 18 },
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
