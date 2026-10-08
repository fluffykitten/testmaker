# Design Tokens & Theme Specification

## Part 1 — Compact Token Summary

### Color Palette

#### Primary (Indigo / Violet)
- `--color-primary-50`: `#eef2ff`
- `--color-primary-100`: `#e0e7ff`
- `--color-primary-200`: `#c7d2fe`
- `--color-primary-300`: `#a5b4fc`
- `--color-primary-400`: `#818cf8`
- `--color-primary-500`: `#6366f1` (Brand Primary)
- `--color-primary-600`: `#4f46e5`
- `--color-primary-700`: `#4338ca`
- `--color-primary-800`: `#3730a3`
- `--color-primary-900`: `#312e81`

#### Accents (Emerald / Green - Insan Cendekia Madani Brand Identity)
- `--color-accent-400`: `#34d399`
- `--color-accent-500`: `#10b981` (Brand Accent)
- `--color-accent-600`: `#059669`
- Subtle Mint Glow: `rgba(16, 185, 129, 0.055)`
- Mint Pill Badge: Background `#f0fdf4`, Border `#bbf7d0`, Text `#047857`

#### Semantic States
- **Danger (Rose)**: `--color-danger-400` (`#fb7185`), `--color-danger-500` (`#f43f5e`), `--color-danger-600` (`#e11d48`)
- **Warning (Amber)**: `--color-warning-400` (`#fbbf24`), `--color-warning-500` (`#f59e0b`)

#### Surface & Typography (Light Mode `:root`)
- Surface: `#ffffff`
- Surface Elevated: `#f8fafc`
- Surface Sunken: `#f1f5f9`
- Border: `#e2e8f0`
- Border Hover: `#cbd5e1`
- Text Primary: `#0f172a` (Slate 900)
- Text Secondary: `#475569` (Slate 600)
- Text Tertiary: `#94a3b8` (Slate 400)
- Text Inverse: `#ffffff`

#### Dark Mode (`:root.dark`)
- Surface: `#0f172a`
- Surface Elevated: `#1e293b`
- Surface Sunken: `#0c1322`
- Border: `#334155`
- Border Hover: `#475569`
- Text Primary: `#f1f5f9`
- Text Secondary: `#94a3b8`
- Text Tertiary: `#64748b`
- Text Inverse: `#0f172a`

### Border Radii
- `--radius-sm`: `0.375rem` (6px)
- `--radius-md`: `0.5rem` (8px)
- `--radius-lg`: `0.75rem` (12px)
- `--radius-xl`: `1rem` (16px)
- `--radius-2xl`: `1.5rem` (24px)
- Full Capsule: `999px`

### Shadows
- `--shadow-sm`: `0 1px 2px 0 rgb(0 0 0 / 0.05)`
- `--shadow-md`: `0 4px 6px -1px rgb(0 0 0 / 0.07), 0 2px 4px -2px rgb(0 0 0 / 0.05)`
- `--shadow-lg`: `0 10px 15px -3px rgb(0 0 0 / 0.08), 0 4px 6px -4px rgb(0 0 0 / 0.04)`
- `--shadow-xl`: `0 20px 25px -5px rgb(0 0 0 / 0.08), 0 8px 10px -6px rgb(0 0 0 / 0.04)`
- `--shadow-glow`: `0 0 20px rgb(99 102 241 / 0.15)`

### Typography
- Font Family: `'Inter', system-ui, -apple-system, sans-serif`
- Weights: 300, 400, 500, 600, 700, 800, 900

---

## Part 2 — Raw Source Dumps

### `src/index.css`
```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap');
@import "tailwindcss";

/* ─── Design System Tokens ──────────────────────────────────────────────────── */

:root {
  /* Primary palette — deep indigo / violet */
  --color-primary-50: #eef2ff;
  --color-primary-100: #e0e7ff;
  --color-primary-200: #c7d2fe;
  --color-primary-300: #a5b4fc;
  --color-primary-400: #818cf8;
  --color-primary-500: #6366f1;
  --color-primary-600: #4f46e5;
  --color-primary-700: #4338ca;
  --color-primary-800: #3730a3;
  --color-primary-900: #312e81;

  /* Accent — emerald */
  --color-accent-400: #34d399;
  --color-accent-500: #10b981;
  --color-accent-600: #059669;

  /* Danger — rose */
  --color-danger-400: #fb7185;
  --color-danger-500: #f43f5e;
  --color-danger-600: #e11d48;

  /* Warning — amber */
  --color-warning-400: #fbbf24;
  --color-warning-500: #f59e0b;

  /* Neutrals */
  --color-surface: #ffffff;
  --color-surface-elevated: #f8fafc;
  --color-surface-sunken: #f1f5f9;
  --color-border: #e2e8f0;
  --color-border-hover: #cbd5e1;
  --color-text-primary: #0f172a;
  --color-text-secondary: #475569;
  --color-text-tertiary: #94a3b8;
  --color-text-inverse: #ffffff;

  /* Shadows */
  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.07), 0 2px 4px -2px rgb(0 0 0 / 0.05);
  --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.08), 0 4px 6px -4px rgb(0 0 0 / 0.04);
  --shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.08), 0 8px 10px -6px rgb(0 0 0 / 0.04);
  --shadow-glow: 0 0 20px rgb(99 102 241 / 0.15);

  /* Radius */
  --radius-sm: 0.375rem;
  --radius-md: 0.5rem;
  --radius-lg: 0.75rem;
  --radius-xl: 1rem;
  --radius-2xl: 1.5rem;

  /* Transitions */
  --transition-fast: 150ms cubic-bezier(0.4, 0, 0.2, 1);
  --transition-base: 250ms cubic-bezier(0.4, 0, 0.2, 1);
  --transition-slow: 350ms cubic-bezier(0.4, 0, 0.2, 1);

  /* Mobile Safe Area Insets (iPhone notch, Dynamic Island, Android gesture bars) */
  --sat: env(safe-area-inset-top, 0px);
  --sab: env(safe-area-inset-bottom, 0px);
  --sal: env(safe-area-inset-left, 0px);
  --sar: env(safe-area-inset-right, 0px);

  /* Typography */
  --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
}

:root.dark {
  --color-surface: #0f172a;
  --color-surface-elevated: #1e293b;
  --color-surface-sunken: #0c1322;
  --color-border: #334155;
  --color-border-hover: #475569;
  --color-text-primary: #f1f5f9;
  --color-text-secondary: #94a3b8;
  --color-text-tertiary: #64748b;
  --color-text-inverse: #0f172a;

  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.3);
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.4), 0 2px 4px -2px rgb(0 0 0 / 0.3);
  --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.5), 0 4px 6px -4px rgb(0 0 0 / 0.3);
  --shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.5), 0 8px 10px -6px rgb(0 0 0 / 0.3);
  --shadow-glow: 0 0 25px rgb(99 102 241 / 0.25);
}
```
