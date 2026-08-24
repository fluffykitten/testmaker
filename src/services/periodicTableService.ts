// ─── Cambridge IGCSE Periodic Table Service ─────────────────────────────────────
// Renders the official, high-resolution Cambridge IGCSE Periodic Table of Elements
// with all bar codes, copyright stamps, and margin markers cleanly stripped out.

export interface ElementData {
  num: number | string;
  sym: string;
  name: string;
  mass: number | string;
}

export const PERIODIC_TABLE_ELEMENTS: Record<string, ElementData> = {
  H: { num: 1, sym: 'H', name: 'hydrogen', mass: 1 },
  He: { num: 2, sym: 'He', name: 'helium', mass: 4 },
  Li: { num: 3, sym: 'Li', name: 'lithium', mass: 7 },
  Be: { num: 4, sym: 'Be', name: 'beryllium', mass: 9 },
  B: { num: 5, sym: 'B', name: 'boron', mass: 11 },
  C: { num: 6, sym: 'C', name: 'carbon', mass: 12 },
  N: { num: 7, sym: 'N', name: 'nitrogen', mass: 14 },
  O: { num: 8, sym: 'O', name: 'oxygen', mass: 16 },
  F: { num: 9, sym: 'F', name: 'fluorine', mass: 19 },
  Ne: { num: 10, sym: 'Ne', name: 'neon', mass: 20 },
  Na: { num: 11, sym: 'Na', name: 'sodium', mass: 23 },
  Mg: { num: 12, sym: 'Mg', name: 'magnesium', mass: 24 },
  Al: { num: 13, sym: 'Al', name: 'aluminium', mass: 27 },
  Si: { num: 14, sym: 'Si', name: 'silicon', mass: 28 },
  P: { num: 15, sym: 'P', name: 'phosphorus', mass: 31 },
  S: { num: 16, sym: 'S', name: 'sulfur', mass: 32 },
  Cl: { num: 17, sym: 'Cl', name: 'chlorine', mass: 35.5 },
  Ar: { num: 18, sym: 'Ar', name: 'argon', mass: 40 },
  K: { num: 19, sym: 'K', name: 'potassium', mass: 39 },
  Ca: { num: 20, sym: 'Ca', name: 'calcium', mass: 40 },
  Sc: { num: 21, sym: 'Sc', name: 'scandium', mass: 45 },
  Ti: { num: 22, sym: 'Ti', name: 'titanium', mass: 48 },
  V: { num: 23, sym: 'V', name: 'vanadium', mass: 51 },
  Cr: { num: 24, sym: 'Cr', name: 'chromium', mass: 52 },
  Mn: { num: 25, sym: 'Mn', name: 'manganese', mass: 55 },
  Fe: { num: 26, sym: 'Fe', name: 'iron', mass: 56 },
  Co: { num: 27, sym: 'Co', name: 'cobalt', mass: 59 },
  Ni: { num: 28, sym: 'Ni', name: 'nickel', mass: 59 },
  Cu: { num: 29, sym: 'Cu', name: 'copper', mass: 64 },
  Zn: { num: 30, sym: 'Zn', name: 'zinc', mass: 65 },
  Ga: { num: 31, sym: 'Ga', name: 'gallium', mass: 70 },
  Ge: { num: 32, sym: 'Ge', name: 'germanium', mass: 73 },
  As: { num: 33, sym: 'As', name: 'arsenic', mass: 75 },
  Se: { num: 34, sym: 'Se', name: 'selenium', mass: 79 },
  Br: { num: 35, sym: 'Br', name: 'bromine', mass: 80 },
  Kr: { num: 36, sym: 'Kr', name: 'krypton', mass: 84 },
  Rb: { num: 37, sym: 'Rb', name: 'rubidium', mass: 85 },
  Sr: { num: 38, sym: 'Sr', name: 'strontium', mass: 88 },
  Y: { num: 39, sym: 'Y', name: 'yttrium', mass: 89 },
  Zr: { num: 40, sym: 'Zr', name: 'zirconium', mass: 91 },
  Nb: { num: 41, sym: 'Nb', name: 'niobium', mass: 93 },
  Mo: { num: 42, sym: 'Mo', name: 'molybdenum', mass: 96 },
  Tc: { num: 43, sym: 'Tc', name: 'technetium', mass: '–' },
  Ru: { num: 44, sym: 'Ru', name: 'ruthenium', mass: 101 },
  Rh: { num: 45, sym: 'Rh', name: 'rhodium', mass: 103 },
  Pd: { num: 46, sym: 'Pd', name: 'palladium', mass: 106 },
  Ag: { num: 47, sym: 'Ag', name: 'silver', mass: 108 },
  Cd: { num: 48, sym: 'Cd', name: 'cadmium', mass: 112 },
  In: { num: 49, sym: 'In', name: 'indium', mass: 115 },
  Sn: { num: 50, sym: 'Sn', name: 'tin', mass: 119 },
  Sb: { num: 51, sym: 'Sb', name: 'antimony', mass: 122 },
  Te: { num: 52, sym: 'Te', name: 'tellurium', mass: 128 },
  I: { num: 53, sym: 'I', name: 'iodine', mass: 127 },
  Xe: { num: 54, sym: 'Xe', name: 'xenon', mass: 131 },
  Cs: { num: 55, sym: 'Cs', name: 'caesium', mass: 133 },
  Ba: { num: 56, sym: 'Ba', name: 'barium', mass: 137 },
  La_Lu: { num: '57–71', sym: 'lanthanoids', name: '', mass: '' },
  Hf: { num: 72, sym: 'Hf', name: 'hafnium', mass: 178 },
  Ta: { num: 73, sym: 'Ta', name: 'tantalum', mass: 181 },
  W: { num: 74, sym: 'W', name: 'tungsten', mass: 184 },
  Re: { num: 75, sym: 'Re', name: 'rhenium', mass: 186 },
  Os: { num: 76, sym: 'Os', name: 'osmium', mass: 190 },
  Ir: { num: 77, sym: 'Ir', name: 'iridium', mass: 192 },
  Pt: { num: 78, sym: 'Pt', name: 'platinum', mass: 195 },
  Au: { num: 79, sym: 'Au', name: 'gold', mass: 197 },
  Hg: { num: 80, sym: 'Hg', name: 'mercury', mass: 201 },
  Tl: { num: 81, sym: 'Tl', name: 'thallium', mass: 204 },
  Pb: { num: 82, sym: 'Pb', name: 'lead', mass: 207 },
  Bi: { num: 83, sym: 'Bi', name: 'bismuth', mass: 209 },
  Po: { num: 84, sym: 'Po', name: 'polonium', mass: '–' },
  At: { num: 85, sym: 'At', name: 'astatine', mass: '–' },
  Rn: { num: 86, sym: 'Rn', name: 'radon', mass: '–' },
  Fr: { num: 87, sym: 'Fr', name: 'francium', mass: '–' },
  Ra: { num: 88, sym: 'Ra', name: 'radium', mass: '–' },
  Ac_Lr: { num: '89–103', sym: 'actinoids', name: '', mass: '' },
  Rf: { num: 104, sym: 'Rf', name: 'rutherfordium', mass: '–' },
  Db: { num: 105, sym: 'Db', name: 'dubnium', mass: '–' },
  Sg: { num: 106, sym: 'Sg', name: 'seaborgium', mass: '–' },
  Bh: { num: 107, sym: 'Bh', name: 'bohrium', mass: '–' },
  Hs: { num: 108, sym: 'Hs', name: 'hassium', mass: '–' },
  Mt: { num: 109, sym: 'Mt', name: 'meitnerium', mass: '–' },
  Ds: { num: 110, sym: 'Ds', name: 'darmstadtium', mass: '–' },
  Rg: { num: 111, sym: 'Rg', name: 'roentgenium', mass: '–' },
  Cn: { num: 112, sym: 'Cn', name: 'copernicium', mass: '–' },
  Nh: { num: 113, sym: 'Nh', name: 'nihonium', mass: '–' },
  Fl: { num: 114, sym: 'Fl', name: 'flerovium', mass: '–' },
  Mc: { num: 115, sym: 'Mc', name: 'moscovium', mass: '–' },
  Lv: { num: 116, sym: 'Lv', name: 'livermorium', mass: '–' },
  Ts: { num: 117, sym: 'Ts', name: 'tennessine', mass: '–' },
  Og: { num: 118, sym: 'Og', name: 'oganesson', mass: '–' },

  // Lanthanoids (57–71)
  La: { num: 57, sym: 'La', name: 'lanthanum', mass: 139 },
  Ce: { num: 58, sym: 'Ce', name: 'cerium', mass: 140 },
  Pr: { num: 59, sym: 'Pr', name: 'praseodymium', mass: 141 },
  Nd: { num: 60, sym: 'Nd', name: 'neodymium', mass: 144 },
  Pm: { num: 61, sym: 'Pm', name: 'promethium', mass: '–' },
  Sm: { num: 62, sym: 'Sm', name: 'samarium', mass: 150 },
  Eu: { num: 63, sym: 'Eu', name: 'europium', mass: 152 },
  Gd: { num: 64, sym: 'Gd', name: 'gadolinium', mass: 157 },
  Tb: { num: 65, sym: 'Tb', name: 'terbium', mass: 159 },
  Dy: { num: 66, sym: 'Dy', name: 'dysprosium', mass: 163 },
  Ho: { num: 67, sym: 'Ho', name: 'holmium', mass: 165 },
  Er: { num: 68, sym: 'Er', name: 'erbium', mass: 167 },
  Tm: { num: 69, sym: 'Tm', name: 'thulium', mass: 169 },
  Yb: { num: 70, sym: 'Yb', name: 'ytterbium', mass: 173 },
  Lu: { num: 71, sym: 'Lu', name: 'lutetium', mass: 175 },

  // Actinoids (89–103)
  Ac: { num: 89, sym: 'Ac', name: 'actinium', mass: '–' },
  Th: { num: 90, sym: 'Th', name: 'thorium', mass: 232 },
  Pa: { num: 91, sym: 'Pa', name: 'protactinium', mass: 231 },
  U: { num: 92, sym: 'U', name: 'uranium', mass: 238 },
  Np: { num: 93, sym: 'Np', name: 'neptunium', mass: '–' },
  Pu: { num: 94, sym: 'Pu', name: 'plutonium', mass: '–' },
  Am: { num: 95, sym: 'Am', name: 'americium', mass: '–' },
  Cm: { num: 96, sym: 'Cm', name: 'curium', mass: '–' },
  Bk: { num: 97, sym: 'Bk', name: 'berkelium', mass: '–' },
  Cf: { num: 98, sym: 'Cf', name: 'californium', mass: '–' },
  Es: { num: 99, sym: 'Es', name: 'einsteinium', mass: '–' },
  Fm: { num: 100, sym: 'Fm', name: 'fermium', mass: '–' },
  Md: { num: 101, sym: 'Md', name: 'mendelevium', mass: '–' },
  No: { num: 102, sym: 'No', name: 'nobelium', mass: '–' },
  Lr: { num: 103, sym: 'Lr', name: 'lawrencium', mass: '–' },
};

function renderCell(el?: ElementData, isSpecialSeries = false): string {
  if (!el) {
    return `<td style="border: none; background: transparent;"></td>`;
  }

  if (isSpecialSeries) {
    return `
      <td style="border: 1px solid #111; padding: 1px; text-align: center; font-size: 8.5px; vertical-align: middle; background: white; height: 32px;">
        <div style="font-size: 8.5px; font-weight: bold; line-height: 1;">${el.num}</div>
        <div style="font-size: 7.5px; color: #333; text-transform: lowercase; line-height: 1;">${el.sym}</div>
      </td>
    `;
  }

  return `
    <td style="border: 1px solid #111; padding: 1px 0.5px; text-align: center; vertical-align: middle; background: white; height: 36px;">
      <div style="font-size: 8px; line-height: 1;">${el.num}</div>
      <div style="font-size: 11px; font-weight: bold; line-height: 1.1; margin: 0.5px 0;">${el.sym}</div>
      <div style="font-size: 6.5px; line-height: 1; color: #222; text-transform: lowercase;">${el.name}</div>
      <div style="font-size: 8px; line-height: 1; margin-top: 0.5px;">${el.mass}</div>
    </td>
  `;
}

/**
 * Generates the clean Cambridge IGCSE Periodic Table HTML.
 * By default, renders in landscape rotated mode (rotated 270deg) to span the full width of an A4 exam page.
 */
export function renderPeriodicTableHtml(options: { rotated?: boolean } = { rotated: true }): string {
  const E = PERIODIC_TABLE_ELEMENTS;
  const isRotated = options.rotated !== false;

  const innerContent = `
    <div style="text-align: center; margin-bottom: 4px;">
      <h2 style="font-size: 17px; font-weight: bold; margin: 0 0 1px 0; text-transform: none; letter-spacing: 0.5px;">The Periodic Table of Elements</h2>
      <div style="font-size: 11px; font-weight: bold; color: #222;">Group</div>
    </div>

    <!-- Main Elements Grid -->
    <table style="width: 100%; border-collapse: collapse; table-layout: fixed; margin: 0 auto;">
      <thead>
        <tr style="font-size: 9.5px; font-weight: bold; text-align: center;">
          <th style="width: 5.5%; border: none; padding-bottom: 2px;">I</th>
          <th style="width: 5.5%; border: none; padding-bottom: 2px;">II</th>
          <th style="width: 5.5%; border: none;"></th>
          <th style="width: 5.5%; border: none;"></th>
          <th style="width: 5.5%; border: none;"></th>
          <th style="width: 5.5%; border: none;"></th>
          <th style="width: 5.5%; border: none;"></th>
          <th style="width: 5.5%; border: none;"></th>
          <th style="width: 5.5%; border: none;"></th>
          <th style="width: 5.5%; border: none;"></th>
          <th style="width: 5.5%; border: none;"></th>
          <th style="width: 5.5%; border: none;"></th>
          <th style="width: 5.5%; border: none; padding-bottom: 2px;">III</th>
          <th style="width: 5.5%; border: none; padding-bottom: 2px;">IV</th>
          <th style="width: 5.5%; border: none; padding-bottom: 2px;">V</th>
          <th style="width: 5.5%; border: none; padding-bottom: 2px;">VI</th>
          <th style="width: 5.5%; border: none; padding-bottom: 2px;">VII</th>
          <th style="width: 5.5%; border: none; padding-bottom: 2px;">VIII</th>
        </tr>
      </thead>
      <tbody>
        <!-- Period 1 -->
        <tr>
          ${renderCell(E.H)}
          <td colspan="16" style="border: none;"></td>
          ${renderCell(E.He)}
        </tr>

        <!-- Period 2 -->
        <tr>
          ${renderCell(E.Li)}
          ${renderCell(E.Be)}
          <!-- Key Box spanning across middle columns -->
          <td colspan="10" rowspan="2" style="border: none; padding: 1px 12px; vertical-align: middle;">
            <div style="border: 1.5px solid #111; padding: 4px 10px; width: 150px; margin: 0 auto; background: #fff; text-align: left; font-size: 8.5px;">
              <div style="font-weight: bold; text-align: center; margin-bottom: 2px; font-size: 9.5px;">Key</div>
              <div style="display: flex; justify-content: space-between; align-items: center; line-height: 1.2;">
                <span style="color: #444;">atomic number</span>
                <span style="font-weight: bold;">X</span>
              </div>
              <div style="display: flex; justify-content: space-between; align-items: center; line-height: 1.2;">
                <span style="color: #444;">atomic symbol</span>
                <span style="font-weight: bold; font-size: 11px;">X</span>
              </div>
              <div style="display: flex; justify-content: space-between; align-items: center; line-height: 1.2;">
                <span style="color: #444;">name</span>
                <span>name</span>
              </div>
              <div style="display: flex; justify-content: space-between; align-items: center; line-height: 1.2;">
                <span style="color: #444;">relative atomic mass</span>
                <span style="font-weight: bold;">Ar</span>
              </div>
            </div>
          </td>
          ${renderCell(E.B)}
          ${renderCell(E.C)}
          ${renderCell(E.N)}
          ${renderCell(E.O)}
          ${renderCell(E.F)}
          ${renderCell(E.Ne)}
        </tr>

        <!-- Period 3 -->
        <tr>
          ${renderCell(E.Na)}
          ${renderCell(E.Mg)}
          ${renderCell(E.Al)}
          ${renderCell(E.Si)}
          ${renderCell(E.P)}
          ${renderCell(E.S)}
          ${renderCell(E.Cl)}
          ${renderCell(E.Ar)}
        </tr>

        <!-- Period 4 -->
        <tr>
          ${renderCell(E.K)}
          ${renderCell(E.Ca)}
          ${renderCell(E.Sc)}
          ${renderCell(E.Ti)}
          ${renderCell(E.V)}
          ${renderCell(E.Cr)}
          ${renderCell(E.Mn)}
          ${renderCell(E.Fe)}
          ${renderCell(E.Co)}
          ${renderCell(E.Ni)}
          ${renderCell(E.Cu)}
          ${renderCell(E.Zn)}
          ${renderCell(E.Ga)}
          ${renderCell(E.Ge)}
          ${renderCell(E.As)}
          ${renderCell(E.Se)}
          ${renderCell(E.Br)}
          ${renderCell(E.Kr)}
        </tr>

        <!-- Period 5 -->
        <tr>
          ${renderCell(E.Rb)}
          ${renderCell(E.Sr)}
          ${renderCell(E.Y)}
          ${renderCell(E.Zr)}
          ${renderCell(E.Nb)}
          ${renderCell(E.Mo)}
          ${renderCell(E.Tc)}
          ${renderCell(E.Ru)}
          ${renderCell(E.Rh)}
          ${renderCell(E.Pd)}
          ${renderCell(E.Ag)}
          ${renderCell(E.Cd)}
          ${renderCell(E.In)}
          ${renderCell(E.Sn)}
          ${renderCell(E.Sb)}
          ${renderCell(E.Te)}
          ${renderCell(E.I)}
          ${renderCell(E.Xe)}
        </tr>

        <!-- Period 6 -->
        <tr>
          ${renderCell(E.Cs)}
          ${renderCell(E.Ba)}
          ${renderCell(E.La_Lu, true)}
          ${renderCell(E.Hf)}
          ${renderCell(E.Ta)}
          ${renderCell(E.W)}
          ${renderCell(E.Re)}
          ${renderCell(E.Os)}
          ${renderCell(E.Ir)}
          ${renderCell(E.Pt)}
          ${renderCell(E.Au)}
          ${renderCell(E.Hg)}
          ${renderCell(E.Tl)}
          ${renderCell(E.Pb)}
          ${renderCell(E.Bi)}
          ${renderCell(E.Po)}
          ${renderCell(E.At)}
          ${renderCell(E.Rn)}
        </tr>

        <!-- Period 7 -->
        <tr>
          ${renderCell(E.Fr)}
          ${renderCell(E.Ra)}
          ${renderCell(E.Ac_Lr, true)}
          ${renderCell(E.Rf)}
          ${renderCell(E.Db)}
          ${renderCell(E.Sg)}
          ${renderCell(E.Bh)}
          ${renderCell(E.Hs)}
          ${renderCell(E.Mt)}
          ${renderCell(E.Ds)}
          ${renderCell(E.Rg)}
          ${renderCell(E.Cn)}
          ${renderCell(E.Nh)}
          ${renderCell(E.Fl)}
          ${renderCell(E.Mc)}
          ${renderCell(E.Lv)}
          ${renderCell(E.Ts)}
          ${renderCell(E.Og)}
        </tr>
      </tbody>
    </table>

    <!-- Lanthanoids and Actinoids Series -->
    <div style="margin-top: 10px; width: 100%;">
      <table style="width: 100%; border-collapse: collapse; table-layout: fixed;">
        <tr>
          <td style="width: 13%; font-size: 9px; font-weight: bold; padding-right: 4px; vertical-align: middle; border: none; text-align: right;">lanthanoids</td>
          ${renderCell(E.La)}
          ${renderCell(E.Ce)}
          ${renderCell(E.Pr)}
          ${renderCell(E.Nd)}
          ${renderCell(E.Pm)}
          ${renderCell(E.Sm)}
          ${renderCell(E.Eu)}
          ${renderCell(E.Gd)}
          ${renderCell(E.Tb)}
          ${renderCell(E.Dy)}
          ${renderCell(E.Ho)}
          ${renderCell(E.Er)}
          ${renderCell(E.Tm)}
          ${renderCell(E.Yb)}
          ${renderCell(E.Lu)}
        </tr>
        <tr>
          <td style="width: 13%; font-size: 9px; font-weight: bold; padding-right: 4px; vertical-align: middle; border: none; text-align: right;">actinoids</td>
          ${renderCell(E.Ac)}
          ${renderCell(E.Th)}
          ${renderCell(E.Pa)}
          ${renderCell(E.U)}
          ${renderCell(E.Np)}
          ${renderCell(E.Pu)}
          ${renderCell(E.Am)}
          ${renderCell(E.Cm)}
          ${renderCell(E.Bk)}
          ${renderCell(E.Cf)}
          ${renderCell(E.Es)}
          ${renderCell(E.Fm)}
          ${renderCell(E.Md)}
          ${renderCell(E.No)}
          ${renderCell(E.Lr)}
        </tr>
      </table>
    </div>

    <!-- Bottom Note -->
    <div style="margin-top: 8px; font-size: 9.5px; font-weight: bold; text-align: left; color: #111;">
      The volume of one mole of any gas is 24 dm<sup>3</sup> at room temperature and pressure (r.t.p.).
    </div>
  `;

  if (isRotated) {
    return `
    <div class="cambridge-periodic-table-page" style="page-break-before: always; break-before: page; page-break-after: avoid; break-after: avoid; width: 100%; height: 250mm; max-height: 255mm; display: flex; align-items: center; justify-content: center; overflow: hidden; background: white; box-sizing: border-box; margin: 0; padding: 0;">
      <div style="transform: rotate(270deg); transform-origin: center center; width: 245mm; height: 170mm; max-width: 245mm; max-height: 170mm; display: flex; flex-direction: column; justify-content: space-between; font-family: Arial, Helvetica, sans-serif; color: #000; padding: 4px 6px; box-sizing: border-box; background: white;">
        ${innerContent}
      </div>
    </div>
    `;
  }

  return `
  <div class="cambridge-periodic-table-page" style="page-break-before: always; break-before: page; page-break-after: avoid; break-after: avoid; font-family: Arial, Helvetica, sans-serif; color: #000; padding: 8px 12px; box-sizing: border-box; background: white; width: 100%;">
    ${innerContent}
  </div>
  `;
}
