// ─── Formula & LaTeX Search Helper ─────────────────────────────────────────────
// Normalizes plain chemical formulas (e.g., H2SO4, KMnO4, CO2) and math symbols into LaTeX patterns.

export interface FormulaExpansion {
  originalQuery: string;
  expandedTokens: string[];
  isFormula: boolean;
}

const COMMON_FORMULA_MAP: Record<string, string[]> = {
  h2so4: ['h_2so_4', 'h_{2}so_{4}', 'h2so4', 'sulfuric acid'],
  kmno4: ['kmno_4', 'kmno_{4}', 'kmno4', 'potassium manganate'],
  co2: ['co_2', 'co_{2}', 'co2', 'carbon dioxide'],
  h2o: ['h_2o', 'h_{2}o', 'h2o', 'water'],
  caco3: ['caco_3', 'caco_{3}', 'caco3', 'calcium carbonate'],
  naoh: ['naoh', 'sodium hydroxide'],
  hcl: ['hcl', 'hydrochloric acid'],
  nh3: ['nh_3', 'nh_{3}', 'nh3', 'ammonia'],
  nh4cl: ['nh_4cl', 'nh_{4}cl', 'nh4cl', 'ammonium chloride'],
  ch4: ['ch_4', 'ch_{4}', 'ch4', 'methane'],
  c2h5oh: ['c_2h_5oh', 'c_{2}h_{5}oh', 'c2h5oh', 'ethanol'],
  c2h4: ['c_2h_4', 'c_{2}h_{4}', 'c2h4', 'ethene'],
  fe2o3: ['fe_2o_3', 'fe_{2}o_{3}', 'fe2o3', 'iron(iii) oxide', 'rust'],
  cuso4: ['cuso_4', 'cuso_{4}', 'cuso4', 'copper(ii) sulfate'],
  agno3: ['agno_3', 'agno_{3}', 'agno3', 'silver nitrate'],
  nacl: ['nacl', 'sodium chloride'],
  mgo: ['mgo', 'magnesium oxide'],
  deltah: ['\\delta h', '\\deltah', 'delta h', 'enthalpy'],
  dh: ['\\delta h', 'delta h', 'enthalpy change'],
  alpha: ['\\alpha', 'alpha'],
  beta: ['\\beta', 'beta'],
  gamma: ['\\gamma', 'gamma'],
  theta: ['\\theta', 'theta'],
  integral: ['\\int', 'integral'],
  sum: ['\\sum', 'summation'],
  pi: ['\\pi', '3.14'],
  micro: ['\\mu', 'micro'],
};

/**
 * Expands a search query into multiple chemical and LaTeX equivalents
 */
export function expandFormulaSearch(query: string): FormulaExpansion {
  const clean = query.trim();
  if (!clean) {
    return { originalQuery: '', expandedTokens: [], isFormula: false };
  }

  const normalized = clean.toLowerCase().replace(/[^a-z0-9]/g, '');
  const tokens = new Set<string>([clean]);

  if (COMMON_FORMULA_MAP[normalized]) {
    COMMON_FORMULA_MAP[normalized].forEach((t) => tokens.add(t));
    return {
      originalQuery: clean,
      expandedTokens: Array.from(tokens),
      isFormula: true,
    };
  }

  // Automatic subscript expansion for chemical formulas like XnYm -> X_n Y_m
  if (/^[A-Z][a-z]?\d+([A-Z][a-z]?\d*)*$/.test(clean)) {
    const subscripted = clean.replace(/(\d+)/g, '_$1');
    const bracketed = clean.replace(/(\d+)/g, '_{$1}');
    tokens.add(subscripted);
    tokens.add(bracketed);
    tokens.add(subscripted.toLowerCase());
    return {
      originalQuery: clean,
      expandedTokens: Array.from(tokens),
      isFormula: true,
    };
  }

  return {
    originalQuery: clean,
    expandedTokens: Array.from(tokens),
    isFormula: false,
  };
}

/**
 * Matches question text or topics against expanded formula tokens
 */
export function matchesFormulaSearch(
  text: string,
  tokens: string[]
): boolean {
  if (!text || tokens.length === 0) return false;
  const lowerText = text.toLowerCase();

  return tokens.some((tok) => {
    const t = tok.toLowerCase();
    return lowerText.includes(t) || lowerText.replace(/[\s_{}^$\\]/g, '').includes(t.replace(/[\s_{}^$\\]/g, ''));
  });
}
