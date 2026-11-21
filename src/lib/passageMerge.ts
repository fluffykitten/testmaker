import type { ExtractedPassage, ExtractedQuestion, ExtractionResult } from '../types/database';

/**
 * Extracts declared question ranges from passage headings or exam instructions.
 * Supports English and Indonesian forms:
 * - "questions 1 to 5", "questions 1–5"
 * - "(Teks untuk soal nomor 1-3)", "(Infografis utk soal nomor 11 & 12)", "soal no 6 s.d. 10"
 * - "(Teks untuk nomor 18 saja)", "(Descriptive Text, 5 Questions)"
 */
export function parseQuestionRange(
  text: string,
  currentQNum?: string | number
): { start: number; end: number } | null {
  if (!text) return null;

  const rangeMatch = text.match(
    /(?:questions?|soal|nomor|no\.?)(?:\s+(?:soal|utk|untuk|nomor|no\.?))*\s*(\d+)\s*(?:to|–|-|s\.?d\.?|sampai(?:\s+dengan)?|hingga|&|\bdan\b)\s*(\d+)/i
  );
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
      return { start, end };
    }
  }

  const singleMatch = text.match(
    /(?:questions?|soal|nomor|no\.?)(?:\s+(?:soal|utk|untuk|nomor|no\.?))*\s*(\d+)\s*(?:only|saja)\b/i
  );
  if (singleMatch) {
    const n = parseInt(singleMatch[1], 10);
    if (!Number.isNaN(n)) return { start: n, end: n };
  }

  const countMatch = text.match(/(\d+)\s+questions?/i);
  if (countMatch && currentQNum !== undefined) {
    const count = parseInt(countMatch[1], 10);
    const start = parseInt(String(currentQNum).replace(/\D/g, ''), 10) || 1;
    return {
      start,
      end: start + count - 1,
    };
  }

  return null;
}

/**
 * Expands target question descriptors (including ranges like "1-3", "11 & 12", "R1-6")
 * into a set of normalized target tokens for collision-safe passage matching.
 */
export function expandTargetQuestionTokens(targets?: string[] | null): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(targets)) return out;

  for (const rawTarget of targets) {
    const s = String(rawTarget || '').trim();
    if (!s) continue;

    // Range like "1-3", "1–3", "R1-6"
    const rangeM = /^([LRW])?\s*(\d+)\s*[-–]\s*([LRW])?\s*(\d+)$/i.exec(s);
    if (rangeM) {
      const prefix = (rangeM[1] || rangeM[3] || '').toUpperCase();
      const start = parseInt(rangeM[2], 10);
      const end = parseInt(rangeM[4], 10);
      if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start && end - start <= 50) {
        for (let n = start; n <= end; n++) {
          out.add(prefix ? `${prefix}${n}` : String(n));
        }
        continue;
      }
    }

    // Ampersand / comma list like "11 & 12" or "1, 2, 3"
    const nums = s.match(/(?:[LRW]\s*)?\d+/gi);
    if (nums && nums.length > 0) {
      for (const tok of nums) {
        out.add(tok.replace(/\s+/g, '').toUpperCase());
      }
    } else {
      out.add(s.toLowerCase());
    }
  }

  return out;
}

function normalizeBodyFingerprint(body?: string | null): string {
  return String(body || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 80);
}

function hasSetOverlap(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const item of a) {
    if (b.has(item)) return true;
  }
  return false;
}

function buildRangeScopedPassageId(
  rawId: string,
  targets: Set<string>,
  usedLowerIds: Set<string>,
  fallbackIndex: number
): string {
  const numericTargets = Array.from(targets)
    .map((t) => parseInt(t.replace(/\D/g, ''), 10))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);

  if (numericTargets.length > 0) {
    const min = numericTargets[0];
    const max = numericTargets[numericTargets.length - 1];
    const baseLabel = min === max ? `Teks Q${min}` : `Teks Q${min}-${max}`;
    if (!usedLowerIds.has(baseLabel.toLowerCase())) {
      return baseLabel;
    }
  }

  const cleanBase = (rawId || 'Text').replace(/\s+\d+$/, '').trim() || 'Text';
  let candidate = `${cleanBase} ${fallbackIndex}`;
  let counter = fallbackIndex;
  while (usedLowerIds.has(candidate.toLowerCase())) {
    counter++;
    candidate = `${cleanBase} ${counter}`;
  }
  return candidate;
}

/**
 * Collision-safe passage merger for chunked PDF extractions.
 * Prevents two independent chunks that both label their first reading text "Text 1" / "Teks 1"
 * from overwriting each other (e.g. Q13-15's text overwriting Q1-3's text), and remaps
 * each chunk's question `passage_ref` values to the canonical disambiguated passage IDs.
 */
export function mergeChunkPassagesAndQuestions(chunkResults: ExtractionResult[]): {
  passages: ExtractedPassage[];
  chunkQuestions: ExtractedQuestion[][];
} {
  const canonicalPassages: ExtractedPassage[] = [];
  const canonicalTargets: Set<string>[] = [];
  const canonicalFingerprints: string[] = [];
  const usedLowerIds = new Set<string>();

  const chunkQuestions: ExtractedQuestion[][] = chunkResults.map((cr) => {
    const idRemap = new Map<string, string>();
    const rawPassages = cr.passages || [];

    for (const p of rawPassages) {
      const rawId = (p.id || '').trim();
      if (!rawId) continue;

      const rawIdKey = rawId.toLowerCase();
      const targets = expandTargetQuestionTokens(p.target_questions);
      const fingerprint = normalizeBodyFingerprint(p.body);

      let matchedIndex = -1;

      // 1. Strongest signal: matching body text fingerprint (handles overlap across chunks even if IDs differ)
      if (fingerprint.length >= 40) {
        matchedIndex = canonicalFingerprints.findIndex(
          (fp) => fp.length >= 40 && (fp === fingerprint || fp.startsWith(fingerprint.slice(0, 50)) || fingerprint.startsWith(fp.slice(0, 50)))
        );
      }

      // 2. Same passage ID AND either overlapping target questions or missing disjoint ranges
      if (matchedIndex === -1) {
        for (let i = 0; i < canonicalPassages.length; i++) {
          const existingIdKey = (canonicalPassages[i].id || '').toLowerCase().trim();
          const existingTargets = canonicalTargets[i];
          const overlap = hasSetOverlap(targets, existingTargets);

          if (overlap) {
            // Same questions targeted -> same passage unless bodies explicitly conflict
            const fpA = canonicalFingerprints[i];
            const bothHaveBodies = fpA.length >= 40 && fingerprint.length >= 40;
            const bodiesCompatible = !bothHaveBodies || fpA.slice(0, 40) === fingerprint.slice(0, 40);
            if (bodiesCompatible && (existingIdKey === rawIdKey || overlap)) {
              matchedIndex = i;
              break;
            }
          } else if (existingIdKey === rawIdKey && targets.size === 0 && existingTargets.size === 0) {
            matchedIndex = i;
            break;
          }
        }
      }

      if (matchedIndex >= 0) {
        const existing = canonicalPassages[matchedIndex];
        const existingLen = (existing.body || '').trim().length;
        const nextLen = (p.body || '').trim().length;
        const mergedTargetArray = Array.from(
          new Set([...(existing.target_questions || []), ...(p.target_questions || [])])
        );

        canonicalPassages[matchedIndex] = {
          ...(nextLen > existingLen ? p : existing),
          id: existing.id,
          target_questions: mergedTargetArray,
        };
        for (const t of targets) canonicalTargets[matchedIndex].add(t);
        if (nextLen > existingLen && fingerprint.length > canonicalFingerprints[matchedIndex].length) {
          canonicalFingerprints[matchedIndex] = fingerprint;
        }
        idRemap.set(rawIdKey, existing.id);
      } else {
        let assignedId = rawId;
        if (usedLowerIds.has(rawIdKey)) {
          assignedId = buildRangeScopedPassageId(rawId, targets, usedLowerIds, canonicalPassages.length + 1);
        }
        usedLowerIds.add(assignedId.toLowerCase());
        canonicalPassages.push({
          ...p,
          id: assignedId,
        });
        canonicalTargets.push(targets);
        canonicalFingerprints.push(fingerprint);
        idRemap.set(rawIdKey, assignedId);
      }
    }

    // Remap chunk questions' passage_ref to canonical IDs (or resolve by question_number overlap)
    return (cr.questions || []).map((q) => {
      const refRaw = (q.passage_ref || '').trim();
      const qNumTok = String(q.question_number || '').replace(/\s+/g, '').toUpperCase();
      const qNumDigits = qNumTok.replace(/\D/g, '');

      // Check target_questions of THIS chunk's passages first in case Gemini reused/mis-referenced an ID
      for (const p of rawPassages) {
        const pTargets = expandTargetQuestionTokens(p.target_questions);
        if (pTargets.has(qNumTok) || (qNumDigits && pTargets.has(qNumDigits))) {
          const canonical = idRemap.get((p.id || '').toLowerCase().trim());
          if (canonical) {
            return { ...q, passage_ref: canonical };
          }
        }
      }

      if (refRaw) {
        const mapped = idRemap.get(refRaw.toLowerCase());
        if (mapped) {
          return { ...q, passage_ref: mapped };
        }
      }

      return q;
    });
  });

  return { passages: canonicalPassages, chunkQuestions };
}
