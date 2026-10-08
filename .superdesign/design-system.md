# ICM Exam Platform - Design System

## Product Context
- **Product**: ICM Exam Platform (Insan Cendekia Madani • Cambridge International School ID395)
- **Target Audience**: Teachers, examiners, and academic staff creating, organizing, managing, and printing past Cambridge and custom assessments.
- **Key Feature**: "Saved Exams & Tests" — catalog of saved assessments organized by subject & topic, enabling rapid access to Builder, DOCX/PDF export, parallel twin variant generation, Google Forms export, and offline grading.
- **Core Problem to Solve**: The current Saved Tests page is visually crowded when many tests exist (cluttered badges, multi-action button grids on every card, noisy borders and emojis). The new design must be clean, spacious, minimalist, high-density yet breathable, and highly informative at a glance.

## Visual & Aesthetic Direction
- **Style**: Ultra-clean, modern minimalist SaaS / academic workspace (linear-inspired or modern Notion/Raycast aesthetic, refined typography, subtle borders, high information hierarchy).
- **Typography**: Inter (`'Inter', system-ui, -apple-system, sans-serif`), tabular figures for counts/marks.
- **Color Palette**:
  - Primary Brand: Deep Indigo / Violet (`#4f46e5` to `#6366f1`) and ICM Blue (`#24448c`)
  - Accent: ICM Emerald Green (`#8abf44` / `#10b981`)
  - Neutral Backgrounds:
    - Light: `#ffffff` surface, `#f8fafc` elevated, `#f1f5f9` sunken canvas
    - Dark: `#0f172a` surface, `#1e293b` elevated, `#0c1322` sunken canvas
  - Borders: Crisp hairline borders (`#e2e8f0` in light, `#334155` in dark)
  - Typography Colors: `#0f172a` (Primary), `#475569` (Secondary), `#94a3b8` (Muted/Tertiary)
- **Layout & Density**:
  - Breathable whitespace, uncluttered hierarchy
  - Compact table / list view option or refined sleek card rows with contextual actions (e.g., hover quick actions or kebab menu `···` to eliminate the 5-button visual clutter)
  - Clear subject & topic segmentation with subtle pill filters or segmented controls instead of overwhelming tabs
  - Key metadata (marks, question count, date, subject/topic) visible without screaming for attention

## Key Components & Patterns
- **Header**: Clean title with live test count and "+ Create New Exam" CTA.
- **Toolbar**: Unified filter bar (Search, Subject dropdown/tabs, Topic pill chips, View mode toggle).
- **Test Item Presentation**:
  - Primary details: Title, Subject badge, Topic tags, total marks, questions count, last modified date.
  - Action hierarchy: Primary action ("Open in Builder") prominent; secondary actions (Export, Variant, Forms, Grade, Delete) neatly tucked into an action dropdown menu or subtle icon action group on hover.
