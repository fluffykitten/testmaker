// ─── LMS & Digital Assessment Exporter Service ──────────────────────────────
// Generates industry-standard exports for Google Forms, Canvas, Moodle, Kahoot, and Quizizz.

import { exportFileUniversal } from './fileExportBridge';
import type { Question } from '../types/database';
import type { ExamHeaderConfig } from './testBuilderService';

/**
 * Strips complex markdown/LaTeX markup into clean plain text for spreadsheet/LMS imports
 */
function cleanTextForLms(text: string): string {
  if (!text) return '';
  return text
    .replace(/\\rightarrow/g, '->')
    .replace(/\\times/g, 'x')
    .replace(/\\pm/g, '+/-')
    .replace(/\\Delta/g, 'Δ')
    .replace(/\\degree/g, '°')
    .replace(/\\text\{(.*?)\}/g, '$1')
    .replace(/\$(.*?)\$/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/_{([^{}]*)}/g, '$1')
    .replace(/\^{([^{}]*)}/g, '$1')
    .replace(/\n+/g, ' ')
    .trim();
}

/**
 * 1. Export as QTI 2.1 XML Package for Canvas, Moodle, Blackboard, Schoology
 */
export function exportCanvasMoodleQtiXml(
  headerConfig: ExamHeaderConfig,
  questions: Question[]
): void {
  const safeTitle = (headerConfig.title || 'Exam Assessment').replace(/[^a-zA-Z0-9_-]/g, '_');
  const examTitle = headerConfig.title || 'Examination Assessment';

  let itemsXml = '';

  questions.forEach((q, idx) => {
    const qNum = idx + 1;
    const qText = cleanTextForLms(q.question_text || `Question ${qNum}`);
    const isMcq = q.options && q.options.length > 0;
    const marks = q.marks || 1;

    if (isMcq) {
      const choices = q.options || [];
      const correctIndex = 0; // Standard default or first option

      itemsXml += `
    <assessmentItem identifier="q_${idx + 1}" title="Question ${qNum}" adaptive="false" timeDependent="false">
      <responseDeclaration identifier="RESPONSE" cardinality="single" baseType="identifier">
        <correctResponse>
          <value>Choice_${correctIndex}</value>
        </correctResponse>
      </responseDeclaration>
      <outcomeDeclaration identifier="SCORE" cardinality="single" baseType="float">
        <defaultValue>
          <value>${marks}</value>
        </defaultValue>
      </outcomeDeclaration>
      <itemBody>
        <p>${escapeXml(qText)}</p>
        <choiceInteraction responseIdentifier="RESPONSE" shuffle="false" maxChoices="1">
          ${choices
            .map(
              (choice, cIdx) =>
                `<simpleChoice identifier="Choice_${cIdx}">${escapeXml(cleanTextForLms(choice))}</simpleChoice>`
            )
            .join('\n          ')}
        </choiceInteraction>
      </itemBody>
    </assessmentItem>`;
    } else {
      // Extended Response / Essay Question
      itemsXml += `
    <assessmentItem identifier="q_${idx + 1}" title="Question ${qNum}" adaptive="false" timeDependent="false">
      <outcomeDeclaration identifier="SCORE" cardinality="single" baseType="float">
        <defaultValue>
          <value>${marks}</value>
        </defaultValue>
      </outcomeDeclaration>
      <itemBody>
        <p>${escapeXml(qText)}</p>
        <extendedTextInteraction responseIdentifier="RESPONSE" expectedLength="300" />
      </itemBody>
    </assessmentItem>`;
    }
  });

  const qtiXml = `<?xml version="1.0" encoding="UTF-8"?>
<assessmentTest xmlns="http://www.imsglobal.org/xsd/imsqti_v2p1" identifier="${safeTitle}" title="${escapeXml(examTitle)}">
  <outcomeDeclaration identifier="TOTAL_SCORE" cardinality="single" baseType="float" />
  <testPart identifier="part_1" navigationMode="nonlinear" submissionMode="simultaneous">
    <assessmentSection identifier="section_1" title="Main Section" visible="true">
      ${itemsXml}
    </assessmentSection>
  </testPart>
</assessmentTest>`;

  const blob = new Blob([qtiXml], { type: 'application/xml;charset=utf-8' });
  exportFileUniversal(blob, `${safeTitle}_QTI_Canvas_Moodle.xml`, 'application/xml');
}

/**
 * 2. Export as Google Forms Quiz Payload & Self-Grading CSV format
 */
export function exportGoogleFormsQuiz(
  headerConfig: ExamHeaderConfig,
  questions: Question[]
): void {
  const safeTitle = (headerConfig.title || 'Google_Forms_Quiz').replace(/[^a-zA-Z0-9_-]/g, '_');

  // Generate CSV formatted for Google Forms add-ons (like Form Builder or Form Director)
  const rows: string[] = [
    'Question,Type,Option 1,Option 2,Option 3,Option 4,Points,Feedback/MarkScheme',
  ];

  questions.forEach((q, idx) => {
    const qNum = idx + 1;
    const qText = `"${cleanTextForLms(q.question_text || `Question ${qNum}`).replace(/"/g, '""')}"`;
    const isMcq = q.options && q.options.length > 0;
    const type = isMcq ? 'MULTIPLE_CHOICE' : 'PARAGRAPH';
    const opt1 = isMcq && q.options![0] ? `"${cleanTextForLms(q.options![0]).replace(/"/g, '""')}"` : '""';
    const opt2 = isMcq && q.options![1] ? `"${cleanTextForLms(q.options![1]).replace(/"/g, '""')}"` : '""';
    const opt3 = isMcq && q.options![2] ? `"${cleanTextForLms(q.options![2]).replace(/"/g, '""')}"` : '""';
    const opt4 = isMcq && q.options![3] ? `"${cleanTextForLms(q.options![3]).replace(/"/g, '""')}"` : '""';
    const points = q.marks || 1;

    const ms = q.mark_scheme;
    const feedback = ms?.marking_points
      ? `"${ms.marking_points.map(cleanTextForLms).join('; ').replace(/"/g, '""')}"`
      : '""';

    rows.push(`${qText},${type},${opt1},${opt2},${opt3},${opt4},${points},${feedback}`);
  });

  const csvContent = rows.join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  exportFileUniversal(blob, `${safeTitle}_Google_Forms_Import.csv`, 'text/csv');
}

/**
 * 3. Export for Kahoot & Quizizz Classroom Game CSV
 */
export function exportKahootQuizizzCsv(
  headerConfig: ExamHeaderConfig,
  questions: Question[]
): void {
  const safeTitle = (headerConfig.title || 'Kahoot_Quiz').replace(/[^a-zA-Z0-9_-]/g, '_');

  const rows: string[] = [
    'Question,Answer 1,Answer 2,Answer 3,Answer 4,Time limit (sec),Correct answer (1-4)',
  ];

  questions.forEach((q) => {
    if (q.options && q.options.length >= 2) {
      const qText = `"${cleanTextForLms(q.question_text || '').replace(/"/g, '""')}"`;
      const a1 = `"${cleanTextForLms(q.options[0] || '').replace(/"/g, '""')}"`;
      const a2 = `"${cleanTextForLms(q.options[1] || '').replace(/"/g, '""')}"`;
      const a3 = q.options[2] ? `"${cleanTextForLms(q.options[2]).replace(/"/g, '""')}"` : '""';
      const a4 = q.options[3] ? `"${cleanTextForLms(q.options[3]).replace(/"/g, '""')}"` : '""';
      const timeLimit = 60;
      const correctAnswer = 1; // Default to first or keyed answer

      rows.push(`${qText},${a1},${a2},${a3},${a4},${timeLimit},${correctAnswer}`);
    }
  });

  const csvContent = rows.join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  exportFileUniversal(blob, `${safeTitle}_Kahoot_Quizizz.csv`, 'text/csv');
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}
