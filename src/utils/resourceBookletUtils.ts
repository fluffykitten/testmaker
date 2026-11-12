import type { InsertResourceItem, Question, SubQuestion } from '../types/database';

export interface ResourceBookletItem {
  id: string;             // e.g. "Fig. 1.1", "Photograph A", "Table 2.1"
  title: string;          // e.g. "Settlement hierarchy in Country X"
  imageUrl?: string | null;
  svgContent?: string | null;
  textContent?: string | null;
  pageNumber?: number;
  targetQuestions?: string[];
}

export interface BookletQuestionTrigger {
  refId: string;
  label: string;
}

type RawResourceInput = ResourceBookletItem | InsertResourceItem | Record<string, any>;

export function normalizeResourceKey(ref?: string | null): string {
  return String(ref || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function normalizeBookletItem(raw: RawResourceInput): ResourceBookletItem {
  const obj = (raw || {}) as Record<string, any>;
  const id = String(obj.id || '').trim() || 'Resource';
  const rawTitle = typeof obj.title === 'string' ? obj.title.trim() : '';
  const rawPage = obj.pageNumber ?? obj.page_number;
  const parsedPage =
    typeof rawPage === 'number' && Number.isFinite(rawPage) && rawPage > 0
      ? rawPage
      : undefined;
  const rawTargets = obj.targetQuestions ?? obj.target_questions;
  const targetQuestions = Array.isArray(rawTargets)
    ? rawTargets.map((t) => String(t).trim()).filter(Boolean)
    : undefined;

  return {
    id,
    title: rawTitle || id,
    imageUrl: obj.imageUrl ?? obj.diagram_url ?? null,
    svgContent: obj.svgContent ?? obj.svg_content ?? null,
    textContent: obj.textContent ?? obj.text_content ?? null,
    pageNumber: parsedPage,
    targetQuestions: targetQuestions && targetQuestions.length > 0 ? targetQuestions : undefined,
  };
}

export function hasRenderableBookletContent(item?: ResourceBookletItem | null): boolean {
  if (!item) return false;
  return Boolean(
    (item.imageUrl && String(item.imageUrl).trim()) ||
    (item.svgContent && String(item.svgContent).trim()) ||
    (item.textContent && String(item.textContent).trim())
  );
}

/**
 * Determines whether a parent Question or SubQuestion visual belongs in the Insert / Resource Booklet.
 * Explicitly excludes Question Paper diagrams (`diagram_source === 'qp'`) so in-paper graphs/apparatus
 * stay inline on the question instead of falsely spawning Resource Booklet tabs.
 */
export function isQuestionEntityInsertResource(
  entity: Partial<Question & SubQuestion> | Record<string, any> | null | undefined
): boolean {
  if (!entity) return false;
  if ((entity as any).insert_resource_id) return true;
  if (entity.diagram_source === 'insert') return true;
  if (entity.diagram_source === 'qp') return false;
  if (entity.resource_ref && String(entity.resource_ref).trim()) return true;
  return false;
}

/**
 * Collects explicit insert catalog items from ALL questions (supporting both top-level
 * `q.insert_resources` preserved after exam sanitization and `q.mark_scheme._insert_resources`).
 */
export function collectQuestionCatalogResources(questions: Question[] = []): ResourceBookletItem[] {
  const byKey = new Map<string, ResourceBookletItem>();
  const order: string[] = [];

  for (const q of questions) {
    const candidates: RawResourceInput[] = [];
    if (Array.isArray((q as any).insert_resources)) {
      candidates.push(...(q as any).insert_resources);
    }
    const ms = q.mark_scheme as Record<string, any> | null | undefined;
    if (ms && Array.isArray(ms._insert_resources)) {
      candidates.push(...ms._insert_resources);
    }

    for (const raw of candidates) {
      const item = normalizeBookletItem(raw);
      const key = normalizeResourceKey(item.id);
      if (!key) continue;

      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, item);
        order.push(key);
      } else {
        byKey.set(key, mergeBookletItems(existing, item));
      }
    }
  }

  return order.map((k) => byKey.get(k)!);
}

function mergeBookletItems(
  base: ResourceBookletItem,
  incoming: Partial<ResourceBookletItem>
): ResourceBookletItem {
  const mergedTargets = Array.from(
    new Set([...(base.targetQuestions || []), ...(incoming.targetQuestions || [])].filter(Boolean))
  );

  // Prefer descriptive non-generic title over bare ID fallback
  const baseTitle = base.title?.trim() || '';
  const incomingTitle = incoming.title?.trim() || '';
  const pickedTitle =
    baseTitle && normalizeResourceKey(baseTitle) !== normalizeResourceKey(base.id)
      ? baseTitle
      : incomingTitle || baseTitle || base.id;

  return {
    id: base.id || incoming.id || 'Resource',
    title: pickedTitle,
    imageUrl: base.imageUrl || incoming.imageUrl || null,
    svgContent: base.svgContent || incoming.svgContent || null,
    textContent: base.textContent || incoming.textContent || null,
    pageNumber: base.pageNumber ?? incoming.pageNumber,
    targetQuestions: mergedTargets.length > 0 ? mergedTargets : undefined,
  };
}

/**
 * Aggregates and normalizes Resource Booklet items from both explicit catalogs (`resources` prop /
 * question `_insert_resources`) and question/sub-question insert visuals (`diagram_url` / `svg_content`).
 */
export function buildBookletResources(options: {
  resources?: RawResourceInput[];
  questions?: Question[];
}): ResourceBookletItem[] {
  const questions = options.questions || [];
  const catalogByKey = new Map<string, ResourceBookletItem>();
  const catalogOrder: string[] = [];

  const registerCatalogItem = (raw: RawResourceInput) => {
    const normalized = normalizeBookletItem(raw);
    const key = normalizeResourceKey(normalized.id);
    if (!key) return;
    const existing = catalogByKey.get(key);
    if (!existing) {
      catalogByKey.set(key, normalized);
      catalogOrder.push(key);
    } else {
      catalogByKey.set(key, mergeBookletItems(existing, normalized));
    }
  };

  (options.resources || []).forEach(registerCatalogItem);
  collectQuestionCatalogResources(questions).forEach(registerCatalogItem);

  const resultByKey = new Map<string, ResourceBookletItem>();
  const resultOrder: string[] = [];
  const matchedCatalogKeys = new Set<string>();

  const upsertResult = (key: string, partial: ResourceBookletItem) => {
    const existing = resultByKey.get(key);
    if (!existing) {
      resultByKey.set(key, partial);
      resultOrder.push(key);
    } else {
      resultByKey.set(key, mergeBookletItems(existing, partial));
    }
  };

  questions.forEach((q, idx) => {
    const qNum = String(q.question_number || idx + 1);
    const qHasInsertSubs = (q.sub_questions || []).some((sub) =>
      Boolean(
        isQuestionEntityInsertResource(sub) &&
        (sub.resource_ref || (sub as any).insert_resource_id || sub.diagram_url || sub.svg_content)
      )
    );

    let parentRefUsed: string | null = null;

    if (isQuestionEntityInsertResource(q)) {
      const explicitParentRef =
        q.resource_ref?.trim() || (q as any).insert_resource_id?.trim() || '';
      const hasParentVisual = Boolean(q.diagram_url || q.svg_content);

      if (explicitParentRef || hasParentVisual || !qHasInsertSubs) {
        const qRef = explicitParentRef || `Resource Q${qNum}`;
        parentRefUsed = qRef;
        const key = normalizeResourceKey(qRef);
        const cat = catalogByKey.get(key);
        if (cat) matchedCatalogKeys.add(key);

        const defaultTitle = q.topic
          ? `${q.topic} (Q${qNum})`
          : `Resource for Question ${qNum}`;

        upsertResult(key, {
          id: cat?.id || qRef,
          title:
            cat && normalizeResourceKey(cat.title) !== normalizeResourceKey(cat.id)
              ? cat.title
              : defaultTitle,
          imageUrl: q.diagram_url || cat?.imageUrl || null,
          svgContent: q.svg_content || cat?.svgContent || null,
          textContent: cat?.textContent || null,
          pageNumber: cat?.pageNumber ?? q.insert_page_number ?? q.page_number ?? undefined,
          targetQuestions: Array.from(
            new Set([...(cat?.targetQuestions || []), `Q${qNum}`])
          ),
        });
      }
    }

    (q.sub_questions || []).forEach((sub) => {
      if (!isQuestionEntityInsertResource(sub)) return;
      const explicitSubRef =
        sub.resource_ref?.trim() || (sub as any).insert_resource_id?.trim() || '';
      const hasSubVisual = Boolean(sub.diagram_url || sub.svg_content);

      // Avoid generating empty duplicate entries when sub-questions inherit insert source without their own figure
      if (!explicitSubRef && !hasSubVisual) return;

      const subRef =
        explicitSubRef ||
        `${parentRefUsed || `Resource Q${qNum}`} ${sub.sub_id}`;
      const subKey = normalizeResourceKey(subRef);
      const cat = catalogByKey.get(subKey);
      if (cat) matchedCatalogKeys.add(subKey);

      const sharesParentRef =
        Boolean(parentRefUsed) && normalizeResourceKey(parentRefUsed) === subKey;
      const subTitle =
        cat && normalizeResourceKey(cat.title) !== normalizeResourceKey(cat.id)
          ? cat.title
          : `${q.topic || 'Resource'} (${sub.sub_id})`;

      upsertResult(subKey, {
        id: cat?.id || subRef,
        title: subTitle,
        imageUrl: sub.diagram_url || (sharesParentRef ? q.diagram_url : null) || cat?.imageUrl || null,
        svgContent: sub.svg_content || (sharesParentRef ? q.svg_content : null) || cat?.svgContent || null,
        textContent: cat?.textContent || null,
        pageNumber: cat?.pageNumber ?? sub.insert_page_number ?? sub.page_number ?? undefined,
        targetQuestions: Array.from(
          new Set([...(cat?.targetQuestions || []), `Q${qNum} ${sub.sub_id}`])
        ),
      });
    });
  });

  // Append unmatched catalog items when they contain actual renderable content (e.g., Paper 5x
  // qualitative analysis notes) or when no questions exist (standalone drawer preview).
  for (const key of catalogOrder) {
    if (matchedCatalogKeys.has(key)) continue;
    const cat = catalogByKey.get(key)!;
    if (hasRenderableBookletContent(cat) || questions.length === 0) {
      upsertResult(key, cat);
    }
  }

  return resultOrder.map((k) => resultByKey.get(k)!);
}

export function findMatchingBookletResource(
  items: ResourceBookletItem[],
  ref?: string | null
): ResourceBookletItem | undefined {
  if (!ref || items.length === 0) return undefined;
  const targetKey = normalizeResourceKey(ref);
  return items.find((item) => normalizeResourceKey(item.id) === targetKey);
}

function extractLeadingQuestionNumber(raw?: string | number | null): string | null {
  if (raw === undefined || raw === null) return null;
  const match = String(raw).trim().match(/^(?:q|question)?\s*(\d+)/i);
  return match ? match[1] : null;
}

export function matchesQuestionTarget(
  targetQuestions: string[] | undefined,
  q: Pick<Question, 'question_number'> & { original_question_number?: string }
): boolean {
  if (!targetQuestions || targetQuestions.length === 0) return false;
  const qNumCandidates = [
    extractLeadingQuestionNumber(q.original_question_number),
    extractLeadingQuestionNumber(q.question_number),
  ].filter(Boolean) as string[];

  const exactCandidates = [q.original_question_number, q.question_number]
    .filter(Boolean)
    .map((v) => String(v).trim().toLowerCase());

  return targetQuestions.some((t) => {
    const cleanTarget = String(t).trim().toLowerCase();
    if (exactCandidates.includes(cleanTarget)) return true;
    const targetNum = extractLeadingQuestionNumber(cleanTarget);
    return Boolean(targetNum && qNumCandidates.includes(targetNum));
  });
}

/**
 * Resolves the primary Resource Booklet trigger (if any) for a question, and sub-question triggers.
 */
export function getQuestionBookletTrigger(
  q: Question | undefined | null,
  qIndex: number,
  allResources: ResourceBookletItem[]
): BookletQuestionTrigger | null {
  if (!q || allResources.length === 0) return null;

  if (isQuestionEntityInsertResource(q)) {
    const ref =
      q.resource_ref?.trim() ||
      (q as any).insert_resource_id?.trim() ||
      `Resource Q${q.question_number || qIndex + 1}`;
    const matched = findMatchingBookletResource(allResources, ref);
    if (matched) {
      return { refId: matched.id, label: matched.id };
    }
  }

  // Fallback for reference sheets linked by targetQuestions (e.g., Paper 5x Notes on Question 2)
  const targetMatched = allResources.find((item) => matchesQuestionTarget(item.targetQuestions, q));
  if (targetMatched) {
    return {
      refId: targetMatched.id,
      label: targetMatched.title || targetMatched.id,
    };
  }

  return null;
}

export function getSubQuestionBookletTrigger(
  sub: SubQuestion | undefined | null,
  q: Question | undefined | null,
  qIndex: number,
  allResources: ResourceBookletItem[]
): BookletQuestionTrigger | null {
  if (!sub || !q || allResources.length === 0) return null;
  if (!isQuestionEntityInsertResource(sub)) return null;

  const qNum = q.question_number || qIndex + 1;
  const explicitSubRef =
    sub.resource_ref?.trim() || (sub as any).insert_resource_id?.trim() || '';
  if (!explicitSubRef && !sub.diagram_url && !sub.svg_content) return null;

  const ref =
    explicitSubRef ||
    `${q.resource_ref?.trim() || `Resource Q${qNum}`} ${sub.sub_id}`;
  const matched = findMatchingBookletResource(allResources, ref);
  if (!matched) return null;

  return { refId: matched.id, label: matched.id };
}

