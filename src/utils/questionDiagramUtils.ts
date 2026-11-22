import { extractSvgFromDiagramUrl } from '../lib/gemini';

export interface DiagramLikeEntity {
  diagram_url?: string | null;
  diagram_urls?: string[] | null;
  option_diagrams?: (string | null)[] | null;
  svg_content?: string | null;
  options?: string[] | null;
  mark_scheme?: any;
}

export interface ParsedDiagramColumnValue {
  urls: string[];
  optionDiagrams: (string | null)[] | null;
}

const INLINE_MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g;

/**
 * Extracts the first image URL embedded via Markdown image syntax `![alt](url)`, if present.
 */
export function extractInlineMarkdownImageUrl(text: unknown): string | null {
  if (typeof text !== 'string' || !text.includes('![')) return null;
  const match = text.match(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/);
  return match?.[1]?.trim() || null;
}

/**
 * Strips inline Markdown image tokens `![alt](url)` from option display text
 * so ExamMathText / KaTeX does not render broken/raw markdown syntax alongside option thumbnails.
 */
export function stripInlineMarkdownImage(text: unknown): string {
  if (typeof text !== 'string') return text == null ? '' : String(text);
  if (!text.includes('![')) return text;
  return text.replace(INLINE_MARKDOWN_IMAGE_RE, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Deduplicates and normalizes a list of image URLs / data URIs while preserving order.
 */
export function normalizeDiagramUrlList(urls: unknown): string[] {
  if (!Array.isArray(urls)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of urls) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Normalizes an array of per-option image URLs (preserving positional slots A=0, B=1, ...).
 * Trims empty strings to `null` and trims trailing `null`s when `targetLength` is omitted.
 */
export function normalizeOptionDiagramList(
  optionDiagrams: unknown,
  targetLength?: number
): (string | null)[] {
  const raw = Array.isArray(optionDiagrams) ? optionDiagrams : [];
  const cleaned = raw.map((item) => {
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    return trimmed.length > 0 ? trimmed : null;
  });

  if (typeof targetLength === 'number' && targetLength >= 0) {
    const sized: (string | null)[] = [];
    for (let i = 0; i < targetLength; i++) {
      sized.push(cleaned[i] ?? null);
    }
    return sized;
  }

  let lastNonNull = -1;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    if (cleaned[i]) {
      lastNonNull = i;
      break;
    }
  }
  return lastNonNull >= 0 ? cleaned.slice(0, lastNonNull + 1) : [];
}

/**
 * Unpacks a raw `questions.diagram_url` TEXT value which may be:
 * - null / empty
 * - a plain URL or `data:` URI (legacy / single-image format)
 * - a JSON string array `["url1", "url2"]`
 * - a structured envelope `{"urls":["url1","url2"],"optUrls":[null,"optB"]}`
 */
export function parseDiagramColumnValue(rawDiagramUrl: unknown): ParsedDiagramColumnValue {
  if (typeof rawDiagramUrl !== 'string') {
    return { urls: [], optionDiagrams: null };
  }

  const trimmed = rawDiagramUrl.trim();
  if (!trimmed) {
    return { urls: [], optionDiagrams: null };
  }

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return {
          urls: normalizeDiagramUrlList(parsed),
          optionDiagrams: null,
        };
      }
    } catch {
      // Fall through and treat as plain string
    }
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const urls = normalizeDiagramUrlList(
          Array.isArray((parsed as any).urls)
            ? (parsed as any).urls
            : (parsed as any).diagram_urls
        );
        const rawOpts = Array.isArray((parsed as any).optUrls)
          ? (parsed as any).optUrls
          : (parsed as any).option_diagrams;
        const normalizedOpts = normalizeOptionDiagramList(rawOpts);
        return {
          urls,
          optionDiagrams: normalizedOpts.some(Boolean) ? normalizedOpts : null,
        };
      }
    } catch {
      // Fall through and treat as plain string
    }
  }

  return {
    urls: [trimmed],
    optionDiagrams: null,
  };
}

/**
 * Serializes stem `diagramUrls` and per-option `optionDiagrams` into a single value
 * suitable for `public.questions.diagram_url` (`TEXT`).
 *
 * - Single stem image + no option images -> returns plain URL string (100% legacy compatible).
 * - Multiple stem images or any option image -> returns compact JSON envelope
 *   `{"urls":[...],"optUrls":[...]}` so student RPCs that strip `mark_scheme` keep all visuals.
 */
export function serializeQuestionDiagramsForColumn(
  diagramUrls: string[] | null | undefined,
  optionDiagrams?: (string | null)[] | null
): string | null {
  const cleanUrls = normalizeDiagramUrlList(diagramUrls);
  const cleanOpts = normalizeOptionDiagramList(optionDiagrams);
  const hasOptionDiagrams = cleanOpts.some(Boolean);

  if (!hasOptionDiagrams) {
    if (cleanUrls.length === 0) return null;
    if (cleanUrls.length === 1) return cleanUrls[0];
    return JSON.stringify({ urls: cleanUrls });
  }

  const envelope: { urls?: string[]; optUrls: (string | null)[] } = {
    optUrls: cleanOpts,
  };
  if (cleanUrls.length > 0) {
    envelope.urls = cleanUrls;
  }
  return JSON.stringify(envelope);
}

/**
 * Resolves all ordered stem/sub-question diagram URLs for an entity, combining:
 * 1. Explicit `diagram_urls` array
 * 2. Packed or plain `diagram_url`
 * 3. `mark_scheme._diagram_urls` metadata
 * 4. Optional fallback `svg_content` rendered as SVG data URI when no bitmap/URL exists
 */
export function resolveQuestionDiagramUrls(q: DiagramLikeEntity | null | undefined): string[] {
  if (!q) return [];
  const parsedCol = parseDiagramColumnValue(q.diagram_url);
  const msUrls = normalizeDiagramUrlList(q.mark_scheme?._diagram_urls);
  const explicitUrls = normalizeDiagramUrlList(q.diagram_urls);

  const combined = normalizeDiagramUrlList([
    ...explicitUrls,
    ...parsedCol.urls,
    ...msUrls,
  ]);

  if (combined.length > 0) {
    return combined;
  }

  const inlineSvg = q.svg_content || q.mark_scheme?._svg_content || extractSvgFromDiagramUrl(q.diagram_url);
  if (inlineSvg && typeof inlineSvg === 'string' && inlineSvg.trim()) {
    return [`data:image/svg+xml;utf8,${encodeURIComponent(inlineSvg)}`];
  }

  return [];
}

/**
 * Resolves all non-SVG diagram URLs (or exact bitmap/SVG data URLs stored for an entity),
 * ignoring fallback conversion of `svg_content` if the caller renders `svg_content` separately.
 */
export function resolveQuestionImageUrlsExcludingStandaloneSvg(
  q: DiagramLikeEntity | null | undefined
): string[] {
  if (!q) return [];
  const parsedCol = parseDiagramColumnValue(q.diagram_url);
  const msUrls = normalizeDiagramUrlList(q.mark_scheme?._diagram_urls);
  const explicitUrls = normalizeDiagramUrlList(q.diagram_urls);
  return normalizeDiagramUrlList([...explicitUrls, ...parsedCol.urls, ...msUrls]);
}

/**
 * Resolves positional per-option image URLs from `option_diagrams`, packed `diagram_url`,
 * `_option_diagrams` in `mark_scheme`, and inline Markdown image syntax in `options`.
 */
export function resolveOptionDiagramUrls(
  q: DiagramLikeEntity | null | undefined,
  optionCount?: number
): (string | null)[] {
  if (!q) return typeof optionCount === 'number' ? Array(optionCount).fill(null) : [];

  const parsedCol = parseDiagramColumnValue(q.diagram_url);
  const explicit = normalizeOptionDiagramList(q.option_diagrams);
  const fromCol = normalizeOptionDiagramList(parsedCol.optionDiagrams);
  const fromMs = normalizeOptionDiagramList(q.mark_scheme?._option_diagrams);
  const opts = Array.isArray(q.options) ? q.options : [];

  const maxLen = Math.max(
    optionCount ?? 0,
    explicit.length,
    fromCol.length,
    fromMs.length,
    opts.length
  );

  const merged: (string | null)[] = [];
  for (let i = 0; i < maxLen; i++) {
    const url =
      explicit[i] ||
      fromCol[i] ||
      fromMs[i] ||
      extractInlineMarkdownImageUrl(opts[i]) ||
      null;
    merged.push(url);
  }

  return typeof optionCount === 'number'
    ? merged.slice(0, optionCount)
    : normalizeOptionDiagramList(merged);
}

/**
 * Resolves the diagram/image URL for a single MC option at `optionIndex`.
 */
export function resolveOptionDiagramUrl(
  q: DiagramLikeEntity | null | undefined,
  optionIndex: number,
  optionText?: string | null
): string | null {
  if (optionIndex < 0) return null;
  const urls = resolveOptionDiagramUrls(q);
  if (urls[optionIndex]) return urls[optionIndex];
  if (optionText) {
    return extractInlineMarkdownImageUrl(optionText);
  }
  return null;
}

/**
 * Returns true if any option carries an attached or inline diagram URL.
 */
export function hasAnyOptionDiagrams(
  q: DiagramLikeEntity | null | undefined,
  options?: string[] | null
): boolean {
  const opts = options ?? q?.options ?? [];
  const resolved = resolveOptionDiagramUrls(q, opts.length || undefined);
  if (resolved.some(Boolean)) return true;
  return opts.some((opt) => Boolean(extractInlineMarkdownImageUrl(opt)));
}
