// ─── Google Forms REST API v1 Service ─────────────────────────────────────────
// Creates auto-graded Google Forms Quizzes via Google Forms REST API v1.
// Supports chunked batchUpdate requests, AbortSignal cancellation, section breaks,
// shuffle options, required toggles, and SHORT_ANSWER auto-grading.

import type { Question } from '../../types/database';
import type { ExamHeaderConfig } from '../testBuilderService';
import type {
  GoogleFormResult,
  GoogleFormsProgress,
  GoogleFormsExportOptions,
} from './googleFormsTypes';
import { FORMS_API_CONSOLE_URL } from './googleFormsTypes';
import { formatFormMetadata } from './googleFormsTextSanitizer';
import { flattenQuestionsForForms } from './googleFormsFlattenService';
import { requestGoogleFormsToken } from './googleFormsOAuthService';

/**
 * Robust fetch wrapper with exponential backoff and AbortSignal support (Fixes Issue #11).
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 2,
  delayMs = 800,
  signal?: AbortSignal
): Promise<Response> {
  if (signal?.aborted) {
    throw new DOMException('Operation aborted by user', 'AbortError');
  }

  let lastError: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Operation aborted by user', 'AbortError');
    }

    try {
      const res = await fetch(url, { ...options, signal });
      if ((res.status === 429 || res.status === 503) && attempt < retries) {
        await new Promise((r, reject) => {
          const timeout = setTimeout(r, delayMs * (attempt + 1));
          signal?.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(new DOMException('Operation aborted by user', 'AbortError'));
          }, { once: true });
        });
        continue;
      }
      return res;
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      lastError = err;
      if (attempt < retries) {
        await new Promise((r, reject) => {
          const timeout = setTimeout(r, delayMs * (attempt + 1));
          signal?.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(new DOMException('Operation aborted by user', 'AbortError'));
          }, { once: true });
        });
      }
    }
  }
  throw lastError || new Error(`Network request failed: ${url}`);
}

/**
 * Creates an auto-graded Google Forms Quiz via Google Forms REST API v1.
 */
export async function createGoogleFormQuiz(
  headerConfig: ExamHeaderConfig,
  questions: Question[],
  clientId: string,
  onProgress?: (progress: GoogleFormsProgress) => void,
  imageBase64Map?: Record<string, string>,
  imageUrlMap?: Record<string, string>,
  exportOptions?: GoogleFormsExportOptions
): Promise<GoogleFormResult> {
  const signal = exportOptions?.signal;

  if (signal?.aborted) {
    throw new DOMException('Operation aborted by user', 'AbortError');
  }

  // 1. Authorize
  onProgress?.({
    stage: 'auth',
    message: 'Authenticating with Google...',
  });

  const accessToken = await requestGoogleFormsToken(clientId);

  if (signal?.aborted) {
    throw new DOMException('Operation aborted by user', 'AbortError');
  }

  // 2. Prepare Form Metadata (Fixes Issue #7 & #20)
  const { title: cleanTitle, description: cleanInstructions } = formatFormMetadata(headerConfig);

  onProgress?.({
    stage: 'creating',
    message: 'Creating Google Form in Google Drive...',
  });

  // 3. POST /v1/forms to create blank form
  const createRes = await fetchWithRetry(
    'https://forms.googleapis.com/v1/forms',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        info: {
          title: cleanTitle,
          documentTitle: cleanTitle,
        },
      }),
    },
    2,
    800,
    signal
  );

  if (!createRes.ok) {
    const errJson = await createRes.json().catch(() => ({}));
    const errMsg = errJson.error?.message || `HTTP ${createRes.status} ${createRes.statusText}`;

    if (
      createRes.status === 403 &&
      (errMsg.includes('forms.googleapis.com') ||
        errMsg.includes('disabled') ||
        errMsg.includes('has not been used'))
    ) {
      throw new Error(
        `Google Forms API is not enabled on your Google Cloud Project. Please enable it at: ${FORMS_API_CONSOLE_URL}`
      );
    }
    if (errMsg.includes('insufficient') || errMsg.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
      throw new Error(
        `Google OAuth scope permission denied. Please ensure your OAuth Client ID allows 'https://www.googleapis.com/auth/forms.body'.`
      );
    }
    throw new Error(`Failed to create Google Form: ${errMsg}`);
  }

  const formJson = await createRes.json();
  const formId: string = formJson.formId;

  // Fix Issue #5: Direct view URL fallback without invalid /d/e/ prefix
  const responderUrl: string =
    formJson.responderUri || `https://docs.google.com/forms/d/${formId}/viewform`;
  const editUrl = `https://docs.google.com/forms/d/${formId}/edit`;

  // 4. Process and optionally shuffle questions (Fixes Issue #18)
  let workingQuestions = questions;
  if (exportOptions?.shuffleQuestions) {
    // Shuffle top-level questions while preserving sub-question hierarchy inside each
    workingQuestions = [...questions].sort(() => Math.random() - 0.5);
  }

  // Flatten items
  const flattenedItems = flattenQuestionsForForms(workingQuestions, imageBase64Map, imageUrlMap, exportOptions?.shuffleQuestions);
  const isRequired = exportOptions?.isRequired !== false; // Default true (Fixes Issue #19)
  const shuffleChoices = Boolean(exportOptions?.shuffleOptions); // Fixes Issue #18

  // 5. Build batchUpdate requests with optional Section Breaks (Fixes Issue #17)
  const createRequests: any[] = [];
  let itemIndex = 0;
  let lastSectionStyle: string | null = null;

  flattenedItems.forEach((item, idx) => {
    // Check if section break is needed (Fixes Issue #17)
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
      createRequests.push({
        createItem: {
          item: {
            title: sectionTitle,
            pageBreakItem: {},
          },
          location: {
            index: itemIndex++,
          },
        },
      });
    }

    if (item.type === 'GRID' && item.gridRows && item.gridColumns && item.gridRows.length > 0 && item.gridColumns.length > 0) {
      if (item.imageUrl) {
        let finalUri = item.imageUrl;
        if (finalUri.includes('testmaker-media.icmadani.workers.dev') && finalUri.endsWith('.webp')) {
          finalUri = finalUri.replace(/\.webp$/i, '.png');
        }
        createRequests.push({
          createItem: {
            item: {
              title: item.title,
              imageItem: {
                image: {
                  sourceUri: encodeURI(finalUri),
                  altText: item.altText || 'Diagram',
                },
              },
            },
            location: {
              index: itemIndex++,
            },
          },
        });
      }

      const rowCount = item.gridRows.length;
      const rowPoints = Math.max(1, Math.round(item.pointValue / rowCount));

      const questionGroupItem: any = {
        grid: {
          columns: {
            type: 'RADIO',
            options: item.gridColumns.map((col) => ({ value: col })),
            shuffle: shuffleChoices,
          },
        },
        questions: item.gridRows.map((row) => {
          const qObj: any = {
            rowQuestion: {
              title: row,
            },
            required: isRequired,
            grading: {
              pointValue: rowPoints,
            },
          };

          const correctCol = item.gridRowCorrectAnswers?.[row];
          if (correctCol) {
            qObj.grading.correctAnswers = {
              answers: [{ value: correctCol }],
            };
            qObj.grading.whenRight = { text: 'Correct!' };
            qObj.grading.whenWrong = { text: `Expected: ${correctCol}` };
          } else if (item.feedbackWrong) {
            qObj.grading.whenWrong = { text: `Mark Scheme: ${item.feedbackWrong}` };
          }

          return qObj;
        }),
      };

      createRequests.push({
        createItem: {
          item: {
            title: item.title,
            description: item.description || undefined,
            questionGroupItem,
          },
          location: {
            index: itemIndex++,
          },
        },
      });

      return;
    }

    const questionItem: any = {
      question: {
        required: isRequired, // Fixes Issue #19
        grading: {
          pointValue: item.pointValue,
        },
      },
    };

    if (item.imageUrl) {
      let finalUri = item.imageUrl;
      // Google Forms API strictly requires JPEG, PNG, or GIF.
      if (finalUri.includes('testmaker-media.icmadani.workers.dev') && finalUri.endsWith('.webp')) {
        finalUri = finalUri.replace(/\.webp$/i, '.png');
      }
      questionItem.image = {
        sourceUri: encodeURI(finalUri),
        altText: item.altText || 'Diagram',
      };
    }

    if (item.type === 'RADIO' || item.type === 'CHECKBOX') {
      questionItem.question.choiceQuestion = {
        type: item.type,
        options: (item.options || []).map((opt) => ({ value: opt })),
        shuffle: shuffleChoices, // Fixes Issue #18
      };

      if (item.correctAnswers && item.correctAnswers.length > 0) {
        questionItem.question.grading.correctAnswers = {
          answers: item.correctAnswers.map((ans) => ({ value: ans })),
        };
      }

      if (item.feedbackRight) {
        questionItem.question.grading.whenRight = { text: item.feedbackRight };
      }
      if (item.feedbackWrong) {
        // Pure feedback without double prefix (Fixes Issue #8)
        questionItem.question.grading.whenWrong = { text: `Mark Scheme: ${item.feedbackWrong}` };
      }
    } else if (item.type === 'SHORT_ANSWER') {
      // Fix Issue #23: SHORT_ANSWER item type in Forms API
      questionItem.question.textQuestion = {
        paragraph: false,
      };
      if (item.correctAnswers && item.correctAnswers.length > 0) {
        questionItem.question.grading.correctAnswers = {
          answers: item.correctAnswers.map((ans) => ({ value: ans })),
        };
      }
      if (item.feedbackWrong) {
        questionItem.question.grading.generalFeedback = { text: `Mark Scheme: ${item.feedbackWrong}` };
      }
    } else {
      // Paragraph question
      questionItem.question.textQuestion = {
        paragraph: true,
      };
      if (item.feedbackWrong) {
        questionItem.question.grading.generalFeedback = { text: `Mark Scheme: ${item.feedbackWrong}` };
      }
    }

    createRequests.push({
      createItem: {
        item: {
          title: item.title,
          description: item.description || undefined,
          questionItem,
        },
        location: {
          index: itemIndex++,
        },
      },
    });
  });

  // Setup requests: enable Quiz mode and update description
  const initialSettingsRequests: any[] = [
    {
      updateSettings: {
        settings: {
          quizSettings: {
            isQuiz: true,
          },
        },
        updateMask: 'quizSettings.isQuiz',
      },
    },
  ];

  if (cleanInstructions) {
    initialSettingsRequests.push({
      updateFormInfo: {
        info: {
          description: cleanInstructions,
        },
        updateMask: 'description',
      },
    });
  }

  // 6. Send in batches of 20 items to respect rate and payload limits
  const CHUNK_SIZE = 20;
  const chunks: any[][] = [];

  const firstBatchQuestions = createRequests.slice(0, CHUNK_SIZE);
  chunks.push([...initialSettingsRequests, ...firstBatchQuestions]);

  for (let i = CHUNK_SIZE; i < createRequests.length; i += CHUNK_SIZE) {
    chunks.push(createRequests.slice(i, i + CHUNK_SIZE));
  }

  const totalChunks = chunks.length;
  const totalItems = flattenedItems.length;
  let completedItems = 0;

  for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
    if (signal?.aborted) {
      throw new DOMException('Operation aborted by user', 'AbortError');
    }

    onProgress?.({
      stage: 'populating',
      currentChunk: chunkIdx + 1,
      totalChunks,
      completedItems,
      totalItems,
      message: `Adding questions (${completedItems}/${totalItems})...`,
    });

    const currentRequests = chunks[chunkIdx];
    let batchRes = await fetchWithRetry(
      `https://forms.googleapis.com/v1/forms/${formId}:batchUpdate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requests: currentRequests,
        }),
      },
      2,
      800,
      signal
    );

    if (!batchRes.ok) {
      const errJson = await batchRes.json().catch(() => ({}));
      const errMsg = errJson.error?.message || `HTTP ${batchRes.status} ${batchRes.statusText}`;

      // Resilient fallback: If an image fails to fetch from sourceUri,
      // convert failing image items to formatted diagram link notes so quiz creation still succeeds
      if (errMsg.includes('Failed to fetch image from source_uri')) {
        console.warn(
          `[GoogleFormsExport] Batch ${chunkIdx + 1} image fetch failed (${errMsg}). Retrying without embedding raw image...`
        );
        const fallbackRequests = currentRequests.map((req: any) => {
          if (req.createItem?.item?.questionItem?.image) {
            const failedImg = req.createItem.item.questionItem.image;
            const updatedReq = JSON.parse(JSON.stringify(req));
            delete updatedReq.createItem.item.questionItem.image;
            const linkNotice = `\n\n[Diagram: ${failedImg.sourceUri}]`;
            updatedReq.createItem.item.description = (updatedReq.createItem.item.description || '') + linkNotice;
            return updatedReq;
          }
          return req;
        });

        const retryRes = await fetchWithRetry(
          `https://forms.googleapis.com/v1/forms/${formId}:batchUpdate`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              requests: fallbackRequests,
            }),
          },
          2,
          800,
          signal
        );

        if (!retryRes.ok) {
          const retryErrJson = await retryRes.json().catch(() => ({}));
          const retryErrMsg = retryErrJson.error?.message || `HTTP ${retryRes.status} ${retryRes.statusText}`;
          throw new Error(`Failed adding questions to Google Form (batch ${chunkIdx + 1}): ${retryErrMsg}`);
        }
        batchRes = retryRes;
      } else {
        throw new Error(`Failed adding questions to Google Form (batch ${chunkIdx + 1}): ${errMsg}`);
      }
    }

    const itemsInThisChunk = chunkIdx === 0 ? firstBatchQuestions.length : chunks[chunkIdx].length;
    completedItems += itemsInThisChunk;

    // Polite delay between chunks for rate-limit protection
    if (chunkIdx < totalChunks - 1) {
      await new Promise((r, reject) => {
        const timeout = setTimeout(r, 350);
        signal?.addEventListener('abort', () => {
          clearTimeout(timeout);
          reject(new DOMException('Operation aborted by user', 'AbortError'));
        }, { once: true });
      });
    }
  }

  const totalMarks = flattenedItems.reduce((acc, it) => acc + it.pointValue, 0);
  const mcqCount = flattenedItems.filter((it) => it.type === 'RADIO' || it.type === 'CHECKBOX').length;

  onProgress?.({
    stage: 'done',
    completedItems: totalItems,
    totalItems,
    message: 'Quiz created successfully!',
  });

  return {
    formId,
    editUrl,
    responderUrl,
    title: cleanTitle,
    totalQuestions: totalItems,
    totalMarks,
    mcqCount,
  };
}
