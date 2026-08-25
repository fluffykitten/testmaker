// ─── Formula & LaTeX Search Helper ─────────────────────────────────────────────
// Normalizes plain chemical formulas (e.g., C3H8, H2SO4, Fe2O3, CaCO3) and math symbols into LaTeX patterns
// and bidirectional chemical synonyms (e.g. propane <-> C3H8, sulfuric acid <-> H2SO4, rust <-> Fe2O3).

export interface FormulaExpansion {
  originalQuery: string;
  expandedTokens: string[];
  isFormula: boolean;
}

const ELEMENTS = [
  'He', 'Li', 'Be', 'Ne', 'Na', 'Mg', 'Al', 'Si', 'Cl', 'Ar',
  'Ca', 'Sc', 'Ti', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn',
  'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr', 'Rb', 'Sr', 'Zr', 'Nb',
  'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn', 'Sb',
  'Te', 'Xe', 'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd', 'Pm', 'Sm',
  'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu', 'Hf',
  'Ta', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg', 'Tl', 'Pb', 'Bi',
  'Po', 'At', 'Rn', 'Fr', 'Ra', 'Ac', 'Th', 'Pa', 'Np', 'Pu',
  'Am', 'Cm', 'Bk', 'Cf', 'Es', 'Fm', 'Md', 'No', 'Lr',
  'H', 'B', 'C', 'N', 'O', 'F', 'P', 'S', 'K', 'V', 'Y', 'I', 'W', 'U',
];

interface ChemEntry {
  formula: string;
  altFormulas?: string[];
  names: string[];
}

const CHEMICAL_DICTIONARY: ChemEntry[] = [
  // Hydrocarbons (Alkanes, Alkenes, Alkynes, Arenes)
  { formula: 'CH4', names: ['methane', 'natural gas', 'marsh gas', 'biogas'] },
  { formula: 'C2H6', names: ['ethane'] },
  { formula: 'C3H8', names: ['propane', 'lpg', 'liquefied petroleum gas'] },
  { formula: 'C4H10', names: ['butane', 'isobutane', '2-methylpropane'] },
  { formula: 'C5H12', names: ['pentane', 'isopentane', 'neopentane'] },
  { formula: 'C6H14', names: ['hexane'] },
  { formula: 'C7H16', names: ['heptane'] },
  { formula: 'C8H18', names: ['octane', 'iso-octane', '2,2,4-trimethylpentane'] },
  { formula: 'C9H20', names: ['nonane'] },
  { formula: 'C10H22', names: ['decane'] },
  { formula: 'C2H4', names: ['ethene', 'ethylene'] },
  { formula: 'C3H6', names: ['propene', 'propylene', 'cyclopropane'] },
  { formula: 'C4H8', names: ['butene', 'but-1-ene', 'but-2-ene', 'cyclobutane'] },
  { formula: 'C5H10', names: ['pentene', 'cyclopentane'] },
  { formula: 'C6H12', names: ['hexene', 'cyclohexane'] },
  { formula: 'C2H2', names: ['ethyne', 'acetylene'] },
  { formula: 'C3H4', names: ['propyne'] },
  { formula: 'C4H6', names: ['butyne', 'butadiene'] },
  { formula: 'C6H6', names: ['benzene'] },
  { formula: 'C7H8', names: ['toluene', 'methylbenzene'] },

  // Alcohols & Organic Oxygen Compounds
  { formula: 'CH3OH', altFormulas: ['CH4O'], names: ['methanol', 'methyl alcohol', 'wood spirit'] },
  { formula: 'C2H5OH', altFormulas: ['CH3CH2OH', 'C2H6O'], names: ['ethanol', 'ethyl alcohol', 'alcohol'] },
  { formula: 'C3H7OH', altFormulas: ['CH3CH2CH2OH', 'C3H8O'], names: ['propanol', 'propan-1-ol', 'propan-2-ol', 'isopropanol', 'isopropyl alcohol'] },
  { formula: 'C4H9OH', altFormulas: ['C4H10O'], names: ['butanol', 'butan-1-ol', 'butan-2-ol'] },
  { formula: 'HCOOH', altFormulas: ['CH2O2'], names: ['methanoic acid', 'formic acid'] },
  { formula: 'CH3COOH', altFormulas: ['C2H4O2'], names: ['ethanoic acid', 'acetic acid', 'vinegar'] },
  { formula: 'C2H5COOH', altFormulas: ['C3H6O2'], names: ['propanoic acid', 'propionic acid'] },
  { formula: 'C3H7COOH', altFormulas: ['C4H8O2'], names: ['butanoic acid', 'butyric acid'] },
  { formula: 'C6H12O6', names: ['glucose', 'fructose', 'galactose', 'sugar', 'monosaccharide'] },
  { formula: 'C12H22O11', names: ['sucrose', 'maltose', 'lactose', 'cane sugar'] },
  { formula: 'CH3COOC2H5', altFormulas: ['C4H8O2', 'CH3COOCH2CH3'], names: ['ethyl ethanoate', 'ethyl acetate', 'ester'] },
  { formula: 'CH3COOCH3', altFormulas: ['C3H6O2'], names: ['methyl ethanoate', 'methyl acetate'] },
  { formula: 'HCOOCH3', altFormulas: ['C2H4O2'], names: ['methyl methanoate'] },
  { formula: 'HCHO', altFormulas: ['CH2O'], names: ['methanal', 'formaldehyde', 'formalin'] },
  { formula: 'CH3CHO', altFormulas: ['C2H4O'], names: ['ethanal', 'acetaldehyde'] },
  { formula: 'CH3COCH3', altFormulas: ['C3H6O'], names: ['propanone', 'acetone'] },

  // Inorganic Acids & Bases
  { formula: 'HCl', names: ['hydrochloric acid', 'hydrogen chloride', 'muriatic acid'] },
  { formula: 'H2SO4', names: ['sulfuric acid', 'sulphuric acid', 'oil of vitriol', 'hydrogen sulfate'] },
  { formula: 'H2SO3', names: ['sulfurous acid', 'sulphurous acid'] },
  { formula: 'HNO3', names: ['nitric acid', 'hydrogen nitrate', 'aqua fortis'] },
  { formula: 'HNO2', names: ['nitrous acid'] },
  { formula: 'H3PO4', names: ['phosphoric acid', 'orthophosphoric acid'] },
  { formula: 'H2CO3', names: ['carbonic acid'] },
  { formula: 'HF', names: ['hydrofluoric acid', 'hydrogen fluoride'] },
  { formula: 'HBr', names: ['hydrobromic acid', 'hydrogen bromide'] },
  { formula: 'HI', names: ['hydroiodic acid', 'hydrogen iodide'] },
  { formula: 'H2S', names: ['hydrogen sulfide', 'hydrogen sulphide', 'sewer gas'] },
  { formula: 'H2O2', names: ['hydrogen peroxide'] },
  { formula: 'H2O', names: ['water', 'steam', 'ice', 'dihydrogen monoxide'] },
  { formula: 'NaOH', names: ['sodium hydroxide', 'caustic soda'] },
  { formula: 'KOH', names: ['potassium hydroxide', 'caustic potash'] },
  { formula: 'Ca(OH)2', names: ['calcium hydroxide', 'limewater', 'slaked lime'] },
  { formula: 'Mg(OH)2', names: ['magnesium hydroxide', 'milk of magnesia'] },
  { formula: 'Al(OH)3', names: ['aluminium hydroxide', 'aluminum hydroxide'] },
  { formula: 'NH3', names: ['ammonia', 'ammonia gas'] },
  { formula: 'NH4OH', names: ['ammonium hydroxide', 'aqueous ammonia'] },

  // Oxides & Carbonates
  { formula: 'CO2', names: ['carbon dioxide', 'dry ice'] },
  { formula: 'CO', names: ['carbon monoxide'] },
  { formula: 'SO2', names: ['sulfur dioxide', 'sulphur dioxide'] },
  { formula: 'SO3', names: ['sulfur trioxide', 'sulphur trioxide'] },
  { formula: 'NO', names: ['nitrogen monoxide', 'nitric oxide'] },
  { formula: 'NO2', names: ['nitrogen dioxide'] },
  { formula: 'N2O', names: ['dinitrogen monoxide', 'nitrous oxide', 'laughing gas'] },
  { formula: 'N2O4', names: ['dinitrogen tetroxide'] },
  { formula: 'P4O10', altFormulas: ['P2O5'], names: ['phosphorus pentoxide', 'phosphorus(v) oxide'] },
  { formula: 'SiO2', names: ['silicon dioxide', 'silica', 'sand', 'quartz'] },
  { formula: 'CaO', names: ['calcium oxide', 'quicklime'] },
  { formula: 'CaCO3', names: ['calcium carbonate', 'limestone', 'marble', 'chalk', 'calcite'] },
  { formula: 'Na2CO3', names: ['sodium carbonate', 'washing soda', 'soda ash'] },
  { formula: 'NaHCO3', names: ['sodium hydrogencarbonate', 'sodium bicarbonate', 'baking soda'] },
  { formula: 'K2CO3', names: ['potassium carbonate', 'potash'] },
  { formula: 'KHCO3', names: ['potassium hydrogencarbonate', 'potassium bicarbonate'] },
  { formula: 'MgCO3', names: ['magnesium carbonate', 'magnesite'] },
  { formula: 'CuCO3', names: ['copper(ii) carbonate', 'copper carbonate'] },
  { formula: 'ZnCO3', names: ['zinc carbonate', 'calamine', 'smithsonite'] },
  { formula: 'FeCO3', names: ['iron(ii) carbonate', 'siderite'] },
  { formula: 'PbCO3', names: ['lead(ii) carbonate', 'cerussite'] },

  // Salts & Inorganic Compounds
  { formula: 'NaCl', names: ['sodium chloride', 'table salt', 'common salt', 'rock salt', 'halite'] },
  { formula: 'KCl', names: ['potassium chloride', 'sylvite'] },
  { formula: 'CaCl2', names: ['calcium chloride'] },
  { formula: 'MgCl2', names: ['magnesium chloride'] },
  { formula: 'AlCl3', names: ['aluminium chloride', 'aluminum chloride'] },
  { formula: 'FeCl2', names: ['iron(ii) chloride', 'ferrous chloride'] },
  { formula: 'FeCl3', names: ['iron(iii) chloride', 'ferric chloride'] },
  { formula: 'CuCl2', names: ['copper(ii) chloride', 'cupric chloride'] },
  { formula: 'CuCl', names: ['copper(i) chloride', 'cuprous chloride'] },
  { formula: 'ZnCl2', names: ['zinc chloride'] },
  { formula: 'PbCl2', names: ['lead(ii) chloride'] },
  { formula: 'BaCl2', names: ['barium chloride'] },
  { formula: 'NH4Cl', names: ['ammonium chloride', 'sal ammoniac'] },
  { formula: 'AgCl', names: ['silver chloride'] },
  { formula: 'AgBr', names: ['silver bromide'] },
  { formula: 'AgI', names: ['silver iodide'] },
  { formula: 'AgNO3', names: ['silver nitrate', 'lunar caustic'] },
  { formula: 'CuSO4', names: ['copper(ii) sulfate', 'copper sulphate', 'copper sulfate', 'blue vitriol'] },
  { formula: 'FeSO4', names: ['iron(ii) sulfate', 'iron(ii) sulphate', 'ferrous sulfate', 'green vitriol'] },
  { formula: 'Fe2(SO4)3', names: ['iron(iii) sulfate', 'iron(iii) sulphate', 'ferric sulfate'] },
  { formula: 'MgSO4', names: ['magnesium sulfate', 'magnesium sulphate', 'epsom salt'] },
  { formula: 'ZnSO4', names: ['zinc sulfate', 'zinc sulphate', 'white vitriol'] },
  { formula: 'Na2SO4', names: ['sodium sulfate', 'sodium sulphate', "glauber's salt"] },
  { formula: 'K2SO4', names: ['potassium sulfate', 'potassium sulphate'] },
  { formula: 'BaSO4', names: ['barium sulfate', 'barium sulphate', 'baryte', 'barite'] },
  { formula: 'CaSO4', names: ['calcium sulfate', 'calcium sulphate', 'gypsum', 'anhydrite'] },
  { formula: 'Al2(SO4)3', names: ['aluminium sulfate', 'aluminum sulfate'] },
  { formula: '(NH4)2SO4', names: ['ammonium sulfate', 'ammonium sulphate'] },
  { formula: 'KNO3', names: ['potassium nitrate', 'saltpetre', 'saltpeter', 'niter'] },
  { formula: 'NaNO3', names: ['sodium nitrate', 'chile saltpetre'] },
  { formula: 'NH4NO3', names: ['ammonium nitrate'] },
  { formula: 'Cu(NO3)2', names: ['copper(ii) nitrate', 'copper nitrate'] },
  { formula: 'Pb(NO3)2', names: ['lead(ii) nitrate', 'lead nitrate'] },
  { formula: 'Mg(NO3)2', names: ['magnesium nitrate'] },
  { formula: 'Ca(NO3)2', names: ['calcium nitrate'] },
  { formula: 'Zn(NO3)2', names: ['zinc nitrate'] },
  { formula: 'Fe2O3', names: ['iron(iii) oxide', 'ferric oxide', 'rust', 'haematite', 'hematite'] },
  { formula: 'FeO', names: ['iron(ii) oxide', 'ferrous oxide'] },
  { formula: 'Fe3O4', names: ['iron(ii,iii) oxide', 'triiron tetroxide', 'magnetite', 'lodestone'] },
  { formula: 'CuO', names: ['copper(ii) oxide', 'cupric oxide', 'black copper oxide'] },
  { formula: 'Cu2O', names: ['copper(i) oxide', 'cuprous oxide', 'red copper oxide'] },
  { formula: 'Al2O3', names: ['aluminium oxide', 'aluminum oxide', 'alumina', 'bauxite', 'corundum'] },
  { formula: 'ZnO', names: ['zinc oxide', 'zinc white'] },
  { formula: 'MgO', names: ['magnesium oxide', 'magnesia'] },
  { formula: 'PbO', names: ['lead(ii) oxide', 'litharge'] },
  { formula: 'PbO2', names: ['lead(iv) oxide', 'lead dioxide'] },
  { formula: 'Pb3O4', names: ['trilead tetroxide', 'red lead', 'minium'] },
  { formula: 'MnO2', names: ['manganese(iv) oxide', 'manganese dioxide', 'pyrolusite'] },
  { formula: 'KMnO4', names: ['potassium manganate(vii)', 'potassium permanganate', 'potassium manganate'] },
  { formula: 'K2Cr2O7', names: ['potassium dichromate(vi)', 'potassium dichromate'] },
  { formula: 'K2CrO4', names: ['potassium chromate'] },
  { formula: 'KI', names: ['potassium iodide'] },
  { formula: 'KBr', names: ['potassium bromide'] },
  { formula: 'NaF', names: ['sodium fluoride'] },
  { formula: 'NaBr', names: ['sodium bromide'] },
  { formula: 'NaI', names: ['sodium iodide'] },
  { formula: 'LiCl', names: ['lithium chloride'] },
  { formula: 'LiOH', names: ['lithium hydroxide'] },
  { formula: 'Li2O', names: ['lithium oxide'] },
  { formula: 'Li2CO3', names: ['lithium carbonate'] },
  { formula: 'CuSO4.5H2O', names: ['hydrated copper(ii) sulfate', 'copper sulfate pentahydrate'] },
  { formula: 'CoCl2', names: ['cobalt(ii) chloride', 'cobalt chloride'] },

  // Diatomic Elements & Gases
  { formula: 'H2', names: ['hydrogen', 'hydrogen gas'] },
  { formula: 'O2', names: ['oxygen', 'oxygen gas'] },
  { formula: 'O3', names: ['ozone'] },
  { formula: 'N2', names: ['nitrogen', 'nitrogen gas'] },
  { formula: 'Cl2', names: ['chlorine', 'chlorine gas'] },
  { formula: 'Br2', names: ['bromine', 'liquid bromine'] },
  { formula: 'I2', names: ['iodine', 'solid iodine'] },
  { formula: 'F2', names: ['fluorine', 'fluorine gas'] },
];

const MATH_PHYSICS_MAP: Record<string, string[]> = {
  deltah: ['\\delta h', '\\deltah', 'delta h', 'enthalpy', 'enthalpy change', 'heat of reaction'],
  dh: ['\\delta h', 'delta h', 'enthalpy change'],
  deltat: ['\\delta t', 'delta t', 'temperature change'],
  ea: ['e_a', 'e_{a}', 'activation energy'],
  kc: ['k_c', 'k_{c}', 'equilibrium constant'],
  kp: ['k_p', 'k_{p}', 'pressure equilibrium constant'],
  ka: ['k_a', 'k_{a}', 'acid dissociation constant'],
  kw: ['k_w', 'k_{w}', 'ionic product of water'],
  ph: ['ph', 'acidity', 'hydrogen ion concentration'],
  rf: ['r_f', 'r_{f}', 'retardation factor'],
  mr: ['m_r', 'm_{r}', 'relative molecular mass', 'molar mass'],
  ar: ['a_r', 'a_{r}', 'relative atomic mass'],
  alpha: ['\\alpha', 'alpha', 'alpha particle', 'alpha radiation'],
  beta: ['\\beta', 'beta', 'beta particle', 'beta radiation'],
  gamma: ['\\gamma', 'gamma', 'gamma ray', 'gamma radiation'],
  theta: ['\\theta', 'theta', 'angle'],
  integral: ['\\int', 'integral', 'integration'],
  sum: ['\\sum', 'summation'],
  pi: ['\\pi', '3.14'],
  micro: ['\\mu', 'micro'],
  lambda: ['\\lambda', 'wavelength'],
  omega: ['\\omega', '\\Omega', 'ohm', 'angular velocity'],
  sigma: ['\\sigma', 'standard deviation'],
};

/**
 * Normalizes input string to canonical chemical element casing (e.g. c3h8 -> C3H8, fe2o3 -> Fe2O3)
 */
function normalizeFormulaInput(raw: string): string {
  const str = raw.trim();
  const elemRegex = new RegExp(`(${ELEMENTS.join('|')})(\\d*)`, 'gi');
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  let lastIdx = 0;

  while ((m = elemRegex.exec(str)) !== null) {
    if (m.index !== lastIdx && !/^[()\s.]+$/.test(str.slice(lastIdx, m.index))) {
      return str;
    }
    const elem = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    const count = m[2];
    matches.push(elem + count);
    lastIdx = elemRegex.lastIndex;
  }

  if (matches.length > 0 && lastIdx === str.length) {
    return matches.join('');
  }
  return str;
}

/**
 * Generates all LaTeX and formatting variations for a chemical formula
 */
function addFormulaVariations(tokens: Set<string>, formula: string): void {
  const clean = formula.trim();
  if (!clean) return;

  tokens.add(clean);
  tokens.add(clean.toLowerCase());

  // Subscript with underscore: C_3H_8
  const sub = clean.replace(/(\d+)/g, '_$1');
  tokens.add(sub);
  tokens.add(sub.toLowerCase());

  // Subscript with braces: C_{3}H_{8}
  const brk = clean.replace(/(\d+)/g, '_{$1}');
  tokens.add(brk);
  tokens.add(brk.toLowerCase());

  // LaTeX text wrapper: \text{C}_3\text{H}_8 or \text{C}_{3}\text{H}_{8}
  tokens.add(`\\text{${clean}}`);
  tokens.add(`\\text{${clean}}`.toLowerCase());
}

/**
 * Expands a search query into multiple chemical and LaTeX equivalents
 */
export function expandFormulaSearch(query: string): FormulaExpansion {
  const clean = query.trim();
  if (!clean) {
    return { originalQuery: '', expandedTokens: [], isFormula: false };
  }

  const normalizedInput = clean.toLowerCase().replace(/[^a-z0-9]/g, '');
  const tokens = new Set<string>([clean, clean.toLowerCase()]);
  let isFormula = false;

  // 1. Check Math / Physics symbol dictionary
  if (MATH_PHYSICS_MAP[normalizedInput]) {
    isFormula = true;
    MATH_PHYSICS_MAP[normalizedInput].forEach((t) => {
      tokens.add(t);
      tokens.add(t.toLowerCase());
    });
  }

  // 2. Check Chemical dictionary by formula or common name
  for (const entry of CHEMICAL_DICTIONARY) {
    const entryFormulas = [entry.formula, ...(entry.altFormulas || [])];
    const matchFormula = entryFormulas.some(
      (f) => f.toLowerCase().replace(/[^a-z0-9]/g, '') === normalizedInput
    );
    const matchName = entry.names.some(
      (n) =>
        n.toLowerCase().replace(/[^a-z0-9]/g, '') === normalizedInput ||
        n.toLowerCase() === clean.toLowerCase()
    );

    if (matchFormula || matchName) {
      isFormula = true;
      entryFormulas.forEach((f) => addFormulaVariations(tokens, f));
      entry.names.forEach((n) => {
        tokens.add(n);
        tokens.add(n.toLowerCase());
      });
    }
  }

  // 3. Automatic chemical formula detection for arbitrary formulas like C3H8, c3h8, K2Cr2O7, Fe2O3
  const canonical = normalizeFormulaInput(clean);
  if (/^[A-Za-z0-9()]+$/.test(clean) && /\d/.test(clean)) {
    isFormula = true;
    addFormulaVariations(tokens, canonical);
  }

  return {
    originalQuery: clean,
    expandedTokens: Array.from(tokens),
    isFormula,
  };
}

/**
 * Robustly matches text or objects against expanded formula tokens,
 * stripping LaTeX formatting markers to guarantee exact match even with complex KaTeX.
 */
export function matchesFormulaSearch(target: any, tokens: string[]): boolean {
  if (!target || tokens.length === 0) return false;

  let textToMatch = '';
  if (typeof target === 'string') {
    textToMatch = target;
  } else if (Array.isArray(target)) {
    textToMatch = target.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ');
  } else if (typeof target === 'object') {
    textToMatch = JSON.stringify(target);
  }

  const lowerText = textToMatch.toLowerCase();
  const strippedText = lowerText.replace(/[\s_{}^$\\]/g, '').replace(/text|mathrm|mathbf/g, '');

  return tokens.some((tok) => {
    const t = tok.toLowerCase();
    if (lowerText.includes(t)) return true;

    const strippedTok = t.replace(/[\s_{}^$\\]/g, '').replace(/text|mathrm|mathbf/g, '');
    if (strippedTok.length >= 2 && strippedText.includes(strippedTok)) {
      return true;
    }
    return false;
  });
}
