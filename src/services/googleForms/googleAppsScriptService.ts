// ─── Google Apps Script Quiz Generator Service ───────────────────────────────
// Generates standalone Google Apps Script (.gs) code that teachers can run at https://script.new.
// Fixes: Checkbox feedback (#6), Double Mark Scheme prefix (#8), Shared metadata (#7),
// Diagram privacy toggle (#16), Section breaks (#17), Shuffle choices (#18),
// Duration guidance (#20), and Short Answer items (#23).

import type { Question } from '../../types/database';
import type { ExamHeaderConfig } from '../testBuilderService';
import type { GoogleFormsExportOptions } from './googleFormsTypes';
import { formatFormMetadata } from './googleFormsTextSanitizer';
import { flattenQuestionsForForms } from './googleFormsFlattenService';

export function generateGoogleAppsScript(
  headerConfig: ExamHeaderConfig,
  questions: Question[],
  imageBase64Map?: Record<string, string>,
  imageUrlMap?: Record<string, string>,
  exportOptions?: GoogleFormsExportOptions
): string {
  // Process questions and optionally shuffle top-level questions (Fixes Issue #18)
  let workingQuestions = questions;
  if (exportOptions?.shuffleQuestions) {
    workingQuestions = [...questions].sort(() => Math.random() - 0.5);
  }

  const flattened = flattenQuestionsForForms(workingQuestions, imageBase64Map, imageUrlMap, exportOptions?.shuffleQuestions);
  const { title: cleanTitle, description: cleanInstructions } = formatFormMetadata(headerConfig);

  const isRequired = exportOptions?.isRequired !== false;
  const isBase64Forced = exportOptions?.diagramMode === 'base64';

  const lines: string[] = [
    '/**',
    ' * =========================================================================',
    ' * TestMaker — Google Forms Quiz Generator (Google Apps Script)',
    ' * =========================================================================',
    ' * INSTRUCTIONS:',
    ' * 1. Open https://script.new in your browser.',
    ' * 2. Delete any boilerplate code, paste this entire script, and click "Run" (▶).',
    ' * 3. Authorize Google permissions when prompted.',
    ' * 4. Check the Execution Log below for your Google Form Edit & Student Quiz URLs!',
  ];

  if (headerConfig.durationMinutes) {
    lines.push(` * ⏱ TIME LIMIT: ${headerConfig.durationMinutes} Minutes.`);
    lines.push(' * TIP: To automatically close submissions after time expires, consider using');
    lines.push(' * Google Forms add-ons like "formLimiter" or creating a time-driven trigger.');
  }

  lines.push(
    ' * =========================================================================',
    ' */',
    '',
    'function createTestMakerQuiz() {',
    `  var formTitle = ${JSON.stringify(cleanTitle)};`,
    `  var formDescription = ${JSON.stringify(cleanInstructions)};`,
    '',
    '  Logger.log("Creating Google Form: " + formTitle);',
    '  var form = FormApp.create(formTitle);',
    '  form.setIsQuiz(true);',
    '  if (formDescription) {',
    '    form.setDescription(formDescription);',
    '  }',
    ''
  );

  let lastSectionStyle: string | null = null;

  flattened.forEach((item, idx) => {
    const varName = `q${idx + 1}`;

    // Section break logic (Fixes Issue #17)
    let shouldInsertBreak = false;
    let sectionTitle = '';

    if (exportOptions?.sectionBreakMode === 'chunk_10' && idx > 0 && idx % 10 === 0) {
      shouldInsertBreak = true;
      sectionTitle = `Section ${Math.floor(idx / 10) + 1}`;
    } else if (exportOptions?.sectionBreakMode === 'by_question' && !item.isSubQuestion && idx > 0) {
      shouldInsertBreak = true;
      sectionTitle = item.title;
    } else if (exportOptions?.sectionBreakMode === 'by_style') {
      const currentCategory = (item.type === 'RADIO' || item.type === 'CHECKBOX') ? 'Multiple Choice' : 'Structured';
      if (lastSectionStyle && lastSectionStyle !== currentCategory) {
        shouldInsertBreak = true;
        sectionTitle = `Section: ${currentCategory} Questions`;
      }
      lastSectionStyle = currentCategory;
    }

    if (shouldInsertBreak) {
      lines.push(`  // ─── Section Break: ${sectionTitle} ───`);
      lines.push(`  var sec_${idx + 1} = form.addPageBreakItem();`);
      lines.push(`  sec_${idx + 1}.setTitle(${JSON.stringify(sectionTitle)});`);
      lines.push('');
    }

    lines.push(`  // Item ${idx + 1}: ${item.title.slice(0, 40)}...`);

    // Add image if present (diagram or table figure) (Fixes Issue #16: supports diagramMode: 'base64')
    if (item.imageUrl || item.imageBase64) {
      lines.push('  try {');
      if (!isBase64Forced && item.imageUrl) {
        // Preferred CDN URL
        lines.push(`    var imgBlob_${idx + 1} = getSafeDiagramBlob(${JSON.stringify(item.imageUrl)});`);
      } else if (item.imageBase64) {
        // Self-contained base64 image data directly chunked into 32KB parts
        const rawB64 = item.imageBase64.includes(',') ? item.imageBase64.split(',')[1] : item.imageBase64;
        const CHUNK_SIZE = 32768;
        if (rawB64.length > CHUNK_SIZE) {
          const chunks: string[] = [];
          for (let i = 0; i < rawB64.length; i += CHUNK_SIZE) {
            chunks.push(JSON.stringify(rawB64.slice(i, i + CHUNK_SIZE)));
          }
          lines.push(`    var b64_${idx + 1} = [${chunks.join(', ')}].join('');`);
          lines.push(`    var imgBlob_${idx + 1} = Utilities.newBlob(Utilities.base64Decode(b64_${idx + 1}), "image/png", ${JSON.stringify(`diagram_${idx + 1}.png`)});`);
        } else {
          lines.push(`    var imgBlob_${idx + 1} = Utilities.newBlob(Utilities.base64Decode(${JSON.stringify(rawB64)}), "image/png", ${JSON.stringify(`diagram_${idx + 1}.png`)});`);
        }
      }
      lines.push(`    if (imgBlob_${idx + 1}) {`);
      lines.push(`      var imgItem_${idx + 1} = form.addImageItem();`);
      lines.push('      try {');
      lines.push(`        imgItem_${idx + 1}.setImage(imgBlob_${idx + 1});`);
      lines.push(`        imgItem_${idx + 1}.setTitle(${JSON.stringify(`Diagram for ${item.title.slice(0, 35)}`)});`);
      lines.push('      } catch (setErr) {');
      lines.push(`        form.deleteItem(imgItem_${idx + 1});`);
      lines.push(`        Logger.log("Could not set diagram for Item ${idx + 1}: " + setErr.message);`);
      lines.push('      }');
      lines.push('    }');
      lines.push('  } catch (imgErr) {');
      lines.push(`    Logger.log("Could not attach diagram for Item ${idx + 1}: " + imgErr.message);`);
      lines.push('  }');
    }

    if (item.type === 'RADIO' && item.options && item.options.length > 0) {
      lines.push(`  var ${varName} = form.addMultipleChoiceItem();`);
      lines.push(`  ${varName}.setTitle(${JSON.stringify(item.title)});`);
      if (item.description) {
        lines.push(`  ${varName}.setHelpText(${JSON.stringify(item.description)});`);
      }
      lines.push(`  ${varName}.setPoints(${item.pointValue});`);
      if (isRequired) {
        lines.push(`  ${varName}.setRequired(true);`);
      }

      // Handle choice shuffle if enabled (Fixes Issue #18)
      let choiceOptions = item.options.map((opt, optIdx) => ({
        text: opt,
        isCorrect: item.correctOptionIndices?.includes(optIdx) || false,
      }));
      if (exportOptions?.shuffleOptions) {
        choiceOptions = [...choiceOptions].sort(() => Math.random() - 0.5);
      }

      const choicesCode = choiceOptions.map((c) => {
        return `    ${varName}.createChoice(${JSON.stringify(c.text)}, ${c.isCorrect ? 'true' : 'false'})`;
      }).join(',\n');

      lines.push(`  ${varName}.setChoices([\n${choicesCode}\n  ]);`);

      if (item.feedbackWrong) {
        // Fixes Issue #8: No double Mark Scheme: prefix
        lines.push(`  ${varName}.setFeedbackForIncorrect(FormApp.createFeedback().setText(${JSON.stringify(`Mark Scheme: ${item.feedbackWrong}`)}).build());`);
      }
      lines.push(`  ${varName}.setFeedbackForCorrect(FormApp.createFeedback().setText("Correct!").build());`);
    } else if (item.type === 'CHECKBOX' && item.options && item.options.length > 0) {
      lines.push(`  var ${varName} = form.addCheckboxItem();`);
      lines.push(`  ${varName}.setTitle(${JSON.stringify(item.title)});`);
      if (item.description) {
        lines.push(`  ${varName}.setHelpText(${JSON.stringify(item.description)});`);
      }
      lines.push(`  ${varName}.setPoints(${item.pointValue});`);
      if (isRequired) {
        lines.push(`  ${varName}.setRequired(true);`);
      }

      let choiceOptions = item.options.map((opt, optIdx) => ({
        text: opt,
        isCorrect: item.correctOptionIndices?.includes(optIdx) || false,
      }));
      if (exportOptions?.shuffleOptions) {
        choiceOptions = [...choiceOptions].sort(() => Math.random() - 0.5);
      }

      const choicesCode = choiceOptions.map((c) => {
        return `    ${varName}.createChoice(${JSON.stringify(c.text)}, ${c.isCorrect ? 'true' : 'false'})`;
      }).join(',\n');

      lines.push(`  ${varName}.setChoices([\n${choicesCode}\n  ]);`);

      // Fixes Issue #6: Added feedback support for Checkbox (Multiple Select) items
      if (item.feedbackWrong) {
        lines.push(`  ${varName}.setFeedbackForIncorrect(FormApp.createFeedback().setText(${JSON.stringify(`Mark Scheme: ${item.feedbackWrong}`)}).build());`);
      }
      lines.push(`  ${varName}.setFeedbackForCorrect(FormApp.createFeedback().setText("Correct!").build());`);
    } else if (item.type === 'SHORT_ANSWER') {
      // Fixes Issue #23: SHORT_ANSWER item type in Apps Script
      lines.push(`  var ${varName} = form.addTextItem();`);
      lines.push(`  ${varName}.setTitle(${JSON.stringify(item.title)});`);
      lines.push(`  // WARNING: Google Apps Script lacks an API to set auto-grading correct answers for Text items.`);
      lines.push(`  // The Mark Scheme is provided in the Help Text below, but these will require manual grading.`);
      const helpParts = [
        item.description,
        item.feedbackWrong ? `Mark Scheme: ${item.feedbackWrong}` : '',
      ].filter(Boolean);

      if (helpParts.length > 0) {
        lines.push(`  ${varName}.setHelpText(${JSON.stringify(helpParts.join('\n\n'))});`);
      }
      lines.push(`  ${varName}.setPoints(${item.pointValue});`);
      if (isRequired) {
        lines.push(`  ${varName}.setRequired(true);`);
      }
    } else if (item.type === 'GRID' && item.gridRows && item.gridColumns && item.gridRows.length > 0 && item.gridColumns.length > 0) {
      lines.push(`  var ${varName} = form.addGridItem();`);
      lines.push(`  ${varName}.setTitle(${JSON.stringify(item.title)});`);
      lines.push(`  ${varName}.setRows(${JSON.stringify(item.gridRows)});`);
      lines.push(`  ${varName}.setColumns(${JSON.stringify(item.gridColumns)});`);
      if (isRequired) {
        lines.push(`  ${varName}.setRequired(true);`);
      }
      const gridAnswerKeySummary = item.gridRowCorrectAnswers
        ? Object.entries(item.gridRowCorrectAnswers)
            .map(([r, c]) => `${r} = ${c}`)
            .join('; ')
        : '';
      const gridHelpParts = [
        item.description,
        gridAnswerKeySummary ? `Mark Scheme / Answer Key: ${gridAnswerKeySummary}` : (item.feedbackWrong ? `Mark Scheme: ${item.feedbackWrong}` : ''),
      ].filter(Boolean);
      if (gridHelpParts.length > 0) {
        lines.push(`  ${varName}.setHelpText(${JSON.stringify(gridHelpParts.join('\n\n'))});`);
      }
    } else {
      // Paragraph / Open-Ended
      lines.push(`  var ${varName} = form.addParagraphTextItem();`);
      lines.push(`  ${varName}.setTitle(${JSON.stringify(item.title)});`);
      const helpText = [
        item.description,
        item.feedbackWrong ? `Mark Scheme: ${item.feedbackWrong}` : '', // Fixes Issue #8: No double prefix
      ].filter(Boolean).join('\n\n');

      if (helpText) {
        lines.push(`  ${varName}.setHelpText(${JSON.stringify(helpText)});`);
      }
      lines.push(`  ${varName}.setPoints(${item.pointValue});`);
      if (isRequired) {
        lines.push(`  ${varName}.setRequired(true);`);
      }
    }

    lines.push('');
  });

  lines.push('  var editUrl = form.getEditUrl();');
  lines.push('  var publishedUrl = form.getPublishedUrl();');
  lines.push('');
  lines.push('  Logger.log("=================================================");');
  lines.push('  Logger.log("🎉 GOOGLE FORM CREATED SUCCESSFULLY!");');
  lines.push('  Logger.log("✏️ Teacher Edit URL: " + editUrl);');
  lines.push('  Logger.log("📋 Student Quiz URL: " + publishedUrl);');
  lines.push('  Logger.log("=================================================");');
  lines.push('}');
  lines.push('');
  lines.push('/**');
  lines.push(' * Fetches diagram safely with WebP to PNG conversion via Google Drive');
  lines.push(' */');
  lines.push('function getSafeDiagramBlob(url) {');
  lines.push('  if (!url) return null;');
  lines.push('  try {');
  lines.push('    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });');
  lines.push('    if (res.getResponseCode() !== 200) return null;');
  lines.push('    var blob = res.getBlob();');
  lines.push('    var ct = (blob.getContentType() || "").toLowerCase();');
  lines.push('    if (ct.indexOf("png") !== -1 || ct.indexOf("jpeg") !== -1 || ct.indexOf("jpg") !== -1 || ct.indexOf("gif") !== -1) {');
  lines.push('      return blob;');
  lines.push('    }');
  lines.push('    // WebP or other format: attempt Drive thumbnail conversion');
  lines.push('    try {');
  lines.push('      var tempFile = DriveApp.createFile(blob);');
  lines.push('      var fileId = tempFile.getId();');
  lines.push('      var thumbUrl = "https://drive.google.com/thumbnail?id=" + fileId + "&sz=w1200";');
  lines.push('      var conv = UrlFetchApp.fetch(thumbUrl, {');
  lines.push('        headers: { authorization: "Bearer " + ScriptApp.getOAuthToken() },');
  lines.push('        muteHttpExceptions: true');
  lines.push('      });');
  lines.push('      tempFile.setTrashed(true);');
  lines.push('      if (conv.getResponseCode() === 200) {');
  lines.push('        var pngBlob = conv.getBlob();');
  lines.push('        pngBlob.setContentType("image/png");');
  lines.push('        return pngBlob;');
  lines.push('      }');
  lines.push('    } catch (driveErr) {');
  lines.push('      Logger.log("Drive conversion note: " + driveErr.message);');
  lines.push('    }');
  lines.push('    return blob;');
  lines.push('  } catch (err) {');
  lines.push('    Logger.log("UrlFetchApp fetch error: " + err.message);');
  lines.push('    return null;');
  lines.push('  }');
  lines.push('}');

  return lines.join('\n');
}
