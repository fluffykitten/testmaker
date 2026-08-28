import type { Question } from '../types/database';

const BASE_DIAGRAM_URL =
  'https://jtxmlmexvfvrkhfavwdr.supabase.co/storage/v1/object/public/exam-diagrams/diagrams/';

/**
 * Known mapping of Geography 0460/11 authentic cropped diagrams
 */
const GEOGRAPHY_0460_RESOURCE_MAP: Record<
  string | number,
  {
    parent: {
      diagram_url: string;
      diagram_source: 'insert' | 'qp';
      resource_ref: string;
    };
    subQuestions?: Record<
      number,
      {
        diagram_url: string;
        diagram_source: 'insert' | 'qp';
        resource_ref: string;
      }
    >;
  }
> = {
  1: {
    parent: {
      diagram_url: `${BASE_DIAGRAM_URL}0460_2025_p11_1_1787753469374.webp`,
      diagram_source: 'insert',
      resource_ref: 'Fig. 1.1',
    },
    subQuestions: {
      4: {
        diagram_url: `${BASE_DIAGRAM_URL}0460_2025_p11_1_sub_4_1787753473461.webp`,
        diagram_source: 'qp',
        resource_ref: 'Fig. 1.2',
      },
    },
  },
  2: {
    parent: {
      diagram_url: `${BASE_DIAGRAM_URL}0460_2025_p11_2_1787753471040.webp`,
      diagram_source: 'insert',
      resource_ref: 'Fig. 2.1',
    },
    subQuestions: {
      4: {
        diagram_url: `${BASE_DIAGRAM_URL}0460_2025_p11_2_sub_4_1787753473710.webp`,
        diagram_source: 'insert',
        resource_ref: 'Figs. 2.2 and 2.3',
      },
      5: {
        diagram_url: `${BASE_DIAGRAM_URL}0460_2025_p11_2_sub_5_1787901630346.webp`,
        diagram_source: 'insert',
        resource_ref: 'Fig. 2.4',
      },
    },
  },
  3: {
    parent: {
      diagram_url: `${BASE_DIAGRAM_URL}0460_2025_p11_3_1787753471388.webp`,
      diagram_source: 'insert',
      resource_ref: 'Fig. 3.1',
    },
    subQuestions: {
      4: {
        diagram_url: `${BASE_DIAGRAM_URL}0460_2025_p11_3_sub_4_1787753474102.webp`,
        diagram_source: 'insert',
        resource_ref: 'Fig. 3.2',
      },
    },
  },
  4: {
    parent: {
      diagram_url: `${BASE_DIAGRAM_URL}0460_2025_p11_4_1787753472007.webp`,
      diagram_source: 'qp',
      resource_ref: 'Fig. 4.1',
    },
    subQuestions: {
      4: {
        diagram_url: `${BASE_DIAGRAM_URL}0460_2025_p11_4_sub_4_1787753474482.webp`,
        diagram_source: 'insert',
        resource_ref: 'Fig. 4.2',
      },
    },
  },
  5: {
    parent: {
      diagram_url: `${BASE_DIAGRAM_URL}0460_2025_p11_5_1787753472459.webp`,
      diagram_source: 'insert',
      resource_ref: 'Fig. 5.1',
    },
    subQuestions: {
      4: {
        diagram_url: `${BASE_DIAGRAM_URL}0460_2025_p11_5_sub_4_1787753474888.webp`,
        diagram_source: 'qp',
        resource_ref: 'Fig. 5.2',
      },
    },
  },
  6: {
    parent: {
      diagram_url: `${BASE_DIAGRAM_URL}0460_2025_p11_6_1787753472905.webp`,
      diagram_source: 'insert',
      resource_ref: 'Fig. 6.1',
    },
    subQuestions: {
      4: {
        diagram_url: `${BASE_DIAGRAM_URL}0460_2025_p11_6_sub_4_1787753475186.webp`,
        diagram_source: 'qp',
        resource_ref: 'Fig. 6.2',
      },
    },
  },
};

/**
 * Checks whether a question or sub-question visual belongs to the Cambridge Insert Booklet
 */
export function isInsertResource(qOrSq: {
  diagram_source?: 'qp' | 'insert' | null;
  resource_ref?: string | null;
  question_text?: string;
  diagram_url?: string | null;
}): boolean {
  if (qOrSq.diagram_source === 'insert') return true;
  if (qOrSq.diagram_source === 'qp') return false;
  if (qOrSq.resource_ref && /insert/i.test(qOrSq.resource_ref)) return true;
  if (qOrSq.question_text && /\(insert\)/i.test(qOrSq.question_text)) return true;
  return false;
}

export interface ResourceResolutionOptions {
  autoRenumberFigures?: boolean;
}

/**
 * Dynamically renumbers figure codes (e.g. Fig. 1.1, Fig. 1.2 for Question 1) to match the question's
 * position on the test paper, and updates all references in the stem, sub-questions, and mark scheme.
 */
export function renumberQuestionFigures(questions: Question[]): Question[] {
  return questions.map((q, qIdx) => {
    const targetQNum = qIdx + 1;
    let figureCounter = 1;
    let tableCounter = 1;

    interface Replacement {
      isTable?: boolean;
      from?: string;
      to?: string;
      rawFrom?: string;
      rawTo?: string;
    }
    const replacements: Replacement[] = [];

    // ─── 1. Detect and Renumber Tables in Question ───
    const allText = [
      q.question_text || '',
      ...(q.sub_questions || []).map((s) => s.question_text || ''),
    ].join('\n');
    const tableMatches = [...allText.matchAll(/Tables?\s*([0-9.]+)/gi)];
    const seenTables = new Set<string>();
    tableMatches.forEach((m) => {
      const origTableNum = m[1];
      if (!seenTables.has(origTableNum)) {
        seenTables.add(origTableNum);
        const targetTableNum = `${targetQNum}.${tableCounter++}`;
        if (origTableNum !== targetTableNum) {
          replacements.push({
            isTable: true,
            from: origTableNum,
            to: targetTableNum,
          });
        }
      }
    });

    // ─── 2. Detect and Renumber Figures ───
    // Parent question figure
    let newParentResourceRef = q.resource_ref;
    const hasParentDiagram = Boolean(q.diagram_url);

    if (hasParentDiagram) {
      const parentRefMatch =
        (q.resource_ref || '').match(/Figs?\.?\s*([0-9.]+)/i) ||
        (q.question_text || '').match(/Figs?\.?\s*([0-9.]+)/i);

      const origNum = parentRefMatch ? parentRefMatch[1] : null;
      const targetRef = `${targetQNum}.${figureCounter}`;
      newParentResourceRef = `Fig. ${targetRef}`;
      if (origNum && origNum !== targetRef) {
        replacements.push({ from: origNum, to: targetRef });
      }
      figureCounter++;
    }

    // Sub-question figures (ONLY sub-questions that ACTUALLY have a diagram_url)
    const updatedSubs = (q.sub_questions || []).map((sq) => {
      let newSqRef: string | null | undefined = undefined;

      if (sq.diagram_url) {
        // Compound 3 figures: "Figs. 2.2, 2.3 and 2.4"
        const multiMatch3 = (sq.resource_ref || sq.question_text || '').match(
          /Figs?\.?\s*([0-9.]+),\s*([0-9.]+)\s*(?:and|&)\s*([0-9.]+)/i
        );
        // Compound 2 figures: "Figs. 2.2 and 2.3"
        const multiMatch2 = !multiMatch3
          ? (sq.resource_ref || sq.question_text || '').match(
              /Figs?\.?\s*([0-9.]+)\s*(?:and|&)\s*([0-9.]+)/i
            )
          : null;

        if (multiMatch3) {
          const f1 = `${targetQNum}.${figureCounter++}`;
          const f2 = `${targetQNum}.${figureCounter++}`;
          const f3 = `${targetQNum}.${figureCounter++}`;
          newSqRef = `Figs. ${f1}, ${f2} and ${f3}`;
          replacements.push(
            { from: multiMatch3[1], to: f1 },
            { from: multiMatch3[2], to: f2 },
            { from: multiMatch3[3], to: f3 },
            {
              rawFrom: `${multiMatch3[1]}, ${multiMatch3[2]} and ${multiMatch3[3]}`,
              rawTo: `${f1}, ${f2} and ${f3}`,
            },
            {
              rawFrom: `${multiMatch3[1]}, ${multiMatch3[2]} or ${multiMatch3[3]}`,
              rawTo: `${f1}, ${f2} or ${f3}`,
            }
          );
        } else if (multiMatch2) {
          const f1 = `${targetQNum}.${figureCounter++}`;
          const f2 = `${targetQNum}.${figureCounter++}`;
          newSqRef = `Figs. ${f1} and ${f2}`;
          replacements.push(
            { from: multiMatch2[1], to: f1 },
            { from: multiMatch2[2], to: f2 },
            {
              rawFrom: `${multiMatch2[1]} and ${multiMatch2[2]}`,
              rawTo: `${f1} and ${f2}`,
            },
            {
              rawFrom: `${multiMatch2[1]} or ${multiMatch2[2]}`,
              rawTo: `${f1} or ${f2}`,
            }
          );
        } else {
          const sqRefMatch =
            (sq.resource_ref || '').match(/Figs?\.?\s*([0-9.]+)/i) ||
            (sq.question_text || '').match(/Figs?\.?\s*([0-9.]+)/i);

          const origSqNum = sqRefMatch ? sqRefMatch[1] : null;
          const targetSqRef = `${targetQNum}.${figureCounter}`;
          newSqRef = `Fig. ${targetSqRef}`;
          if (origSqNum && origSqNum !== targetSqRef) {
            replacements.push({ from: origSqNum, to: targetSqRef });
          }
          figureCounter++;
        }
      }
      return { ...sq, resource_ref: newSqRef };
    });

    // ─── 3. Apply Text Replacements ───
    function applyReplacements(text?: string | null): string {
      if (!text) return '';
      let res = text;
      // 1. Raw compound replacements first
      replacements.forEach((r) => {
        if (r.rawFrom && r.rawTo) {
          res = res.replaceAll(r.rawFrom, r.rawTo);
        }
      });
      // 2. Table replacements
      replacements.forEach((r) => {
        if (r.isTable && r.from && r.to) {
          const pattern = new RegExp(`\\b(Tables?)\\s*${r.from.replace('.', '\\.')}\\b`, 'gi');
          res = res.replace(pattern, `$1 ${r.to}`);
        }
      });
      // 3. Multi-figure compound lists (e.g. "Figs. 2.2, 2.3 and 2.4" or "Fig. 2.2 and Fig. 2.3" or "2.3 and 2.4")
      replacements.forEach((r) => {
        if (!r.isTable && r.from && r.to) {
          const listPattern = new RegExp(
            `(\\bFigs?\\.?\\s*|\\bFigures?\\s*|,\\s*|\\band\\s+|\\bor\\s+)${r.from.replace('.', '\\.')}\\b`,
            'gi'
          );
          res = res.replace(listPattern, `$1${r.to}`);
        }
      });
      // 4. Standalone figure replacements
      replacements.forEach((r) => {
        if (!r.isTable && r.from && r.to) {
          const pattern = new RegExp(
            `\\b(Figs?\\.?|Figure)\\s*${r.from.replace('.', '\\.')}\\b`,
            'gi'
          );
          res = res.replace(pattern, `$1 ${r.to}`);
        }
      });
      return res;
    }

    const updatedStem = applyReplacements(q.question_text);

    let updatedMarkScheme = q.mark_scheme;
    if (q.mark_scheme) {
      if (typeof q.mark_scheme === 'string') {
        updatedMarkScheme = applyReplacements(q.mark_scheme) as any;
      } else if (typeof q.mark_scheme === 'object') {
        updatedMarkScheme = {
          ...q.mark_scheme,
          marking_points: (q.mark_scheme.marking_points || []).map(applyReplacements),
          acceptable_answers: (q.mark_scheme.acceptable_answers || []).map(applyReplacements),
          guidance: (q.mark_scheme.guidance || []).map(applyReplacements),
        };
      }
    }

    const updatedExplanation = (q as any).explanation
      ? applyReplacements((q as any).explanation)
      : (q as any).explanation;

    const finalSubs = updatedSubs.map((sq) => ({
      ...sq,
      question_text: applyReplacements(sq.question_text),
      resource_ref: sq.resource_ref ? applyReplacements(sq.resource_ref) : sq.resource_ref,
      mark_scheme: (sq as any).mark_scheme
        ? applyReplacements((sq as any).mark_scheme)
        : (sq as any).mark_scheme,
    }));

    return {
      ...q,
      original_question_number: (q as any).original_question_number || q.question_number,
      question_number: String(targetQNum),
      question_text: updatedStem,
      resource_ref: newParentResourceRef,
      mark_scheme: updatedMarkScheme,
      explanation: updatedExplanation,
      sub_questions: finalSubs,
      _resourcesResolved: true,
    };
  });
}

/**
 * Resolves authentic cropped diagrams, diagram_source, and resource_ref for all questions.
 * Handles cases where cached in-memory questions in the browser may still point to old full-page Question Paper crops.
 * If options.autoRenumberFigures is true (default), dynamically updates figure codes to match test order.
 */
export function resolveQuestionResources(
  questions: Question[],
  options: ResourceResolutionOptions = { autoRenumberFigures: true }
): Question[] {
  // Idempotency: if questions have already been resolved and renumbered, do not alter or overwrite them
  if (questions.length > 0 && questions.every((q: any) => q._resourcesResolved)) {
    return questions;
  }

  const resolved = questions.map((q) => {
    if ((q as any)._resourcesResolved) {
      return q;
    }

    const isGeo =
      q.syllabus_id === 'd3efaaae-4e05-434d-93c4-0b1a992e375b' ||
      /geograph/i.test(q.topic || '') ||
      (q.diagram_url && q.diagram_url.includes('0460'));

    // Determine the ORIGINAL question number:
    // 1. From preserved original_question_number
    // 2. From filename pattern in diagram_url (e.g. 0460_2025_p11_2_... -> 2)
    // 3. Fallback to q.question_number
    let origQNum: number | null = null;
    if ((q as any).original_question_number) {
      origQNum = parseInt(String((q as any).original_question_number).replace(/\D/g, '')) || null;
    }
    if (!origQNum && q.diagram_url) {
      const match = q.diagram_url.match(/0460_\d{4}_p\d+_(\d+)_/);
      if (match) {
        origQNum = parseInt(match[1]);
      }
    }
    if (!origQNum) {
      origQNum = parseInt(String(q.question_number).replace(/\D/g, '')) || null;
    }

    const geoMapping = (isGeo && origQNum) ? GEOGRAPHY_0460_RESOURCE_MAP[origQNum] : null;

    // CRITICAL: If q.diagram_url is ALREADY present and authentic, NEVER overwrite it!
    // Only fall back to geoMapping if q.diagram_url is missing.
    const parentDiagramUrl = q.diagram_url || (geoMapping ? geoMapping.parent.diagram_url : null);
    const parentDiagramSource =
      q.diagram_source ||
      (geoMapping ? geoMapping.parent.diagram_source : isInsertResource(q) ? 'insert' : parentDiagramUrl ? 'qp' : null);
    const parentResourceRef = q.resource_ref || (geoMapping ? geoMapping.parent.resource_ref : null);

    const updatedSubQuestions = (q.sub_questions || []).map((sq, idx) => {
      const subMapping = geoMapping?.subQuestions?.[idx];

      // CRITICAL: If sq.diagram_url is ALREADY present, NEVER overwrite it!
      const sqDiagramUrl = sq.diagram_url || (subMapping ? subMapping.diagram_url : null);
      const sqDiagramSource =
        sq.diagram_source ||
        (subMapping ? subMapping.diagram_source : isInsertResource(sq) ? 'insert' : sqDiagramUrl ? 'qp' : null);
      const sqResourceRef = sq.resource_ref || (subMapping ? subMapping.resource_ref : null);

      return {
        ...sq,
        diagram_url: sqDiagramUrl,
        diagram_source: sqDiagramSource,
        resource_ref: sqResourceRef,
      };
    });

    return {
      ...q,
      original_question_number: (q as any).original_question_number || q.question_number,
      diagram_url: parentDiagramUrl,
      diagram_source: parentDiagramSource,
      resource_ref: parentResourceRef,
      sub_questions: updatedSubQuestions,
    };
  });

  if (options.autoRenumberFigures !== false) {
    return renumberQuestionFigures(resolved);
  }

  return resolved.map((q) => ({ ...q, _resourcesResolved: true }));
}
