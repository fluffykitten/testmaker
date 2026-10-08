# Extractable UI Components

Catalog of reusable UI components eligible for extraction as Superdesign `DraftComponent` entities.

---

## Layout Components

### NavBar
- **Source**: `src/App.tsx`
- **Category**: `layout`
- **Description**: Main top navigation bar with dual institutional logos, view switching tabs, and status badges.
- **Extractable props**:
  - `currentPage` (string: `'home' | 'bank' | 'builder' | 'saved' | 'quizzes' | 'upload' | 'advanced_settings'`)
  - `selectedCount` (number, default: 0)
- **Hardcoded**: Dual ICM and Cambridge brand logos, navigation link titles, settings gear icon, connection status widget.

### AppFooter
- **Source**: `src/App.tsx`
- **Category**: `layout`
- **Description**: Global bottom institutional footer with school affiliation and copyright metadata.
- **Extractable props**: None
- **Hardcoded**: Insan Cendekia Madani name, Cambridge International School Centre ID395 text, dual logos.

### PinGate
- **Source**: `src/components/PinGate.tsx`
- **Category**: `layout`
- **Description**: 6-digit invigilator PIN security gate modal wrapper for teacher authoring tools.
- **Extractable props**:
  - `onBackToPortal` (`() => void`)
- **Hardcoded**: Dual logo banner, 6-digit input slots, lockout timer calculations, Turnstile bot detection widget.

---

## Basic & Interactive Components

### FeatureCard
- **Source**: `src/App.tsx`
- **Category**: `basic`
- **Description**: Visual feature summary card with colored accent tag and icon used on the dashboard showcase.
- **Extractable props**:
  - `title` (string)
  - `description` (string)
  - `accent` (`'indigo' | 'violet' | 'emerald' | 'amber' | 'cyan' | 'rose'`)
- **Hardcoded**: Card padding, border-radius, hover elevation transitions.

### ConfirmDeleteModal
- **Source**: `src/components/ConfirmDeleteModal.tsx`
- **Category**: `basic`
- **Description**: Destructive operation confirmation modal with portal backdrop dismissal.
- **Extractable props**:
  - `isOpen` (boolean)
  - `title` (string)
  - `message` (string)
  - `isDeleting` (boolean, default: false)
  - `confirmLabel` (string, default: "Delete Permanently")
- **Hardcoded**: Trash bin SVG icon, Cancel button styling, danger red confirm button.

### ConnectionStatus
- **Source**: `src/components/ConnectionStatus.tsx`
- **Category**: `basic`
- **Description**: Real-time Supabase connection indicator pill with color-coded pulsing beacon.
- **Extractable props**: None (internal ping query)
- **Hardcoded**: Connecting amber, connected green, error rose color configurations.

### TurnstileWidget
- **Source**: `src/components/TurnstileWidget.tsx`
- **Category**: `basic`
- **Description**: Cloudflare Turnstile bot verification challenge with zero-layout footprint.
- **Extractable props**:
  - `action` (string, default: "generic")
- **Hardcoded**: Script loader, fallback token logic, hidden container styles.

### PortalSplitToggle
- **Source**: `src/pages/PortalLandingPage.tsx`
- **Category**: `basic`
- **Description**: Segmented 3-way toggle button group for switching between Dual Split, Student Only, and Teacher Only views.
- **Extractable props**:
  - `portalViewFilter` (`'all' | 'students' | 'teachers'`)
  - `onFilterChange` (`(filter: 'all' | 'students' | 'teachers') => void`)
- **Hardcoded**: Dual split icon, student cap icon, teacher blackboard icon, pill borders.
