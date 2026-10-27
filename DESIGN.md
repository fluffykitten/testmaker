# Design Direction: ICM Exam Platform

> Brand and visual direction for the ICM Exam Platform • Cambridge International School.
> Used alongside `antislop` to preserve brand character and prevent generic AI slop.

---

## 1. Dials

```
Dial: ENERGY 2 / RHYTHM 2 / MOTION 1
```

- **ENERGY 2 (Balanced):** Academic, focused, and professional. High-clarity visual hierarchy without sensory overload or startup hype.
- **RHYTHM 2 (Structured with purposeful breaks):** Predictable margins and card containers for exam papers, contrasting with structured split-views for authoring and analytics.
- **MOTION 1 (Calm / Functional):** Fast, subtle micro-interactions (150-250ms cubic-bezier). Zero gratuitous floating or bouncing animations that distract during assessments.

---

## 2. Identity & Product

- **Product:** ICM Exam Platform • Cambridge International School
- **Core Purpose:** An intelligent exam authoring studio, past paper PDF extraction pipeline, and student assessment platform (dual mode: formal proctored exams & gamified sprint arenas) for Insan Cendekia Madani (ICM) in partnership with Cambridge Assessment International Education.
- **Audience:** Cambridge IGCSE / IELTS subject educators, exam administrators, invigilators, and secondary school students.

---

## 3. Personality & Mood

- **Character:** Rigorous, institutional, and academically authoritative, yet clear, modern, and low-friction.
- **Testing Atmosphere:** High legibility, distraction-free, ink-friendly layout with zero visual clutter during timed exams.
- **Dual-Experience:** Serious academic rigor in teacher authoring & formal exams, balanced by engaging, low-anxiety gamified assessment arenas.

---

## 4. Color Palette

Limit active palette to 2-3 core colors + 1 deliberate accent color:

- **Core Color 1 (Primary Brand):** ICM Deep Blue (`#24448c`, dark: `#60a5fa` / `#93c5fd`)
  - *Purpose:* Navigation headers, active indicators, and formal exam actions.
- **Core Color 2 (Neutral Base):** Slate Neutrals
  - *Light Mode:* Surface `#ffffff`, Elevated `#f8fafc`, Sunken `#f1f5f9`, Border `#e2e8f0`, Text Primary `#0f172a`, Text Secondary `#475569`.
  - *Dark Mode:* Surface `#0f172a`, Elevated `#1e293b`, Sunken `#0c1322`, Border `#334155`, Text Primary `#f1f5fa`, Text Secondary `#94a3b8`.
  - *Purpose:* Ink-friendly, high-contrast, distraction-free reading surfaces.
- **Deliberate Accent Color:** ICM Fresh Green (`#8abf44`, hover: `#659228`, text: `#537a1f`, bg: `#f5f9ed`, border: `#dbeaba`)
  - *Purpose:* Portal mode switching, positive confirmations, and intentional brand touches.
- **Semantic Accents (Functional Only):**
  - Emerald (`#10b981`): Correct answers, success states.
  - Rose (`#e11d48`): Proctor strikes, errors, destructive actions.
  - Amber (`#f59e0b`): Warning states, time limits, audio play counters.
- **Theme Support:** Full light and dark modes via `:root` and `:root.dark` tokens.

---

## 5. Typography

- **Primary Typeface:** `Inter, system-ui, -apple-system, sans-serif`
  - *Reason:* Exceptionally high legibility across small sizes, form fields, and complex multi-tier question stems (`(a)(i)`, `(b)`).
- **Mathematical & Chemical Notation:** `KaTeX` standard LaTeX typography
  - *Reason:* Authentic rendering of formulas, chemical reactions, nuclide/isotope symbols, and scientific expressions.

---

## 6. Identity Motifs & Levers

- **Dual Header Alignment:** ICM School Crest on the top left and Cambridge Assessment logo on the top right.
- **Flat Underline Navigation:** Clean text tabs with a 2.5px bottom indicator (`#24448c`) on the active view instead of generic pill-shaped buttons.
- **Cambridge Exam Formatting:** Authentic question numbering, structured gap-fill tokens (`[1]`, `[2]`), and clean handwriting lines (~8mm) for printable exports.
- **Subtle Academic Watermarks:** Faint, low-opacity floating math and science line doodles on portal surfaces.
