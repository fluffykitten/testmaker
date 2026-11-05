// Phase 1 harness: chemistry/math sanitisation expectations from the plan.
import { cleanTextForGoogleForms } from '../src/services/googleForms/googleFormsTextSanitizer.ts';

const cases = [
  { name: 'ce reaction', input: '\\ce{CuSO4(aq) + 2NaOH(aq) -> Cu(OH)2(s) + Na2SO4(aq)}', expect: /CuSO₄.*\(aq\).*→.*Cu\(OH\)₂.*\(s\)/ },
  { name: 'state symbol braced', input: 'NaCl_{(aq)} and CaCO_{3(s)}', expect: 'NaCl (aq) and CaCO₃ (s)' },
  { name: 'state symbol bare', input: 'Fe_{(s)} + S_{(g)}', expect: 'Fe (s) + S (g)' },
  { name: 'thermo', input: '\\Delta H^\\ominus = -393.5\\text{ kJ/mol}', expect: 'ΔH⦵ = -393.5 kJ/mol' },
  { name: 'degree C', input: '25^\\circ C', expect: '25°C' },
  { name: 'plain formulas', input: 'CaCO3 and H2O and Fe2(SO4)3', expect: 'CaCO₃ and H₂O and Fe₂(SO₄)₃' },
  { name: 'labels untouched', input: 'Q1 and Fig. 1.1 and Paper 2', expect: 'Q1 and Fig. 1.1 and Paper 2' },
  { name: 'hydrate', input: 'CuSO4.5H2O', expect: 'CuSO₄ · 5H₂O' },
  { name: 'equilibrium', input: 'N2 + 3H2 <=> 2NH3', expect: 'N₂ + 3H₂ ⇌ 2NH₃' },
  { name: 'escaped tab repair', input: '\text{exothermic}', expect: 'exothermic' },
  { name: 'ionic charge', input: 'Fe^2+ and SO_4^2-', expect: 'Fe²⁺ and SO₄²⁻' },
  { name: 'arrow -->', input: 'A --> B', expect: 'A → B' },
];

let failures = 0;
for (const c of cases) {
  const actual = cleanTextForGoogleForms(c.input);
  const ok = c.expect instanceof RegExp ? c.expect.test(actual) : actual === c.expect;
  if (!ok) {
    failures++;
    console.log(`FAIL ${c.name}`);
    console.log(`   in : ${c.input}`);
    console.log(`   got: ${actual}`);
    if (typeof c.expect === 'string') console.log(`   want: ${c.expect}`);
  } else {
    console.log(`ok   ${c.name} → ${actual}`);
  }
}
console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures === 0 ? 0 : 1);
