# 🚀 Handoff Guide: Creative Mode & Teacher Profile Suite

> **Last Updated:** 2026-10-27T15:50:00+07:00  
> **Repository:** `testmaker` (Branch: `main`)  
> **Status:** Phase 1 (Teacher Profile Suite), Phase 1.7 (Teacher Onboarding & Cohort Multi-Select), and Phase 2 (Student Creative Profiles & Parametric SVG Avatar Engine) are **100% Completed & Verified**.  
> **Next Milestone:** **Phase 3 — Saved Exam → Creative Converter & Global Teacher Directory**.

---

## 📋 What Has Been Built & Completed

### Phase 1 & 1.7: Chemistry Teacher Workspace & Subject Isolation
1. **Teacher Profiles Table (`supabase/migrations/013_teacher_profiles.sql`)**:
   - Stores educator profiles with personal optional 4-digit PINs (`pin_hash`), subject departments, cohorts, and preferences.
2. **Onboarding & PIN Gate Integration**:
   - When entering the app after the 6-digit Master PIN, if no educator profile has been selected on the device (`activeProfile === null`), the app prompts whether to select an existing profile or create a new one.
   - Cohort selector uses tactile multi-select toggle buttons for **`Grade 10`**, **`Grade 11`**, and **`Grade 12`**.
   - `Syllabus Code` is optional (`e.g. 0620 (Optional)`).
3. **Primary Subjects & Admin Management**:
   - `DEFAULT_SUBJECTS` includes: Chemistry, Physics, Biology, Mathematics, English, Geography, Economics, **Sociology**, **PAI**, **Arabic**, and **Bahasa Indonesia**.
   - In **Admin Settings (`src/pages/AdvancedSettingsPage.tsx`)**, admins can add new custom subjects, delete custom subjects, or reset to defaults with cloud synchronization via Supabase `app_config`.
4. **Subject Isolation Across Pages**:
   - `QuestionBankPage.tsx`, `SavedTestsPage.tsx`, and `QuizManagerPage.tsx` auto-filter to the active teacher's subject (defaulting to Chemistry), with a quick toggle to "Show All Subjects".

### Phase 2: Student Creative Profiles & Parametric Avatar Studio
1. **Game Profiles Table (`supabase/migrations/014_game_profiles.sql`)**:
   - Handles student accounts (`handle`, `class`, `pin_hash`), starter coins (`🪙 50 coins`), XP, dynamic levels, and subject-partitioned `topic_mastery`.
   - Stored procedures: `auth_game_profile` and `sync_game_match_rewards`.
2. **Parametric SVG Avatar Engine (`src/components/game/GameAvatarRenderer.tsx`)**:
   - 6 scalable vector layers: Aura, Skin, Eyes/Expressions, Hair/Headwear (including ICM Hijab & Scientist spikes), Outfits, and Chemistry Props (Erlenmeyer Flask, Bunsen Burner, etc.).
   - 4 dynamic emotional reactions: *Happy*, *Thinking*, *Victory!*, and *Oops*.
3. **Student Creative Hub Modal (`src/components/game/GameProfileStudioModal.tsx`)**:
   - **Auth Gate**: Log in via Handle & 4-digit PIN, or register with 50 starter coins.
   - **Tab 1 (Avatar Studio & Wardrobe)**: Real-time customization and coin shop.
   - **Tab 2 (Topic Mastery & Career)**: Filterable by subject (defaults to Chemistry) with overall mastery bars and accuracy breakdowns.
   - **Tab 3 (Match History)**: Review of the last 20 matches with missed topic tags.
4. **Portal & Gameplay HUD Integration**:
   - `PortalLandingPage.tsx` features a dedicated **`🎨 Creative Mode Hub & Avatar Studio`** card.
   - `GameQuizRunner.tsx` displays the student's custom avatar in the top HUD with live emotional reactions, automatically awarding coins, XP, and updating Chemistry topic mastery upon quiz completion.

---

## 🛠️ Step-by-Step Instructions to Continue on Another PC

### Step 1: On this current PC (Before leaving)
1. Commit all modified and untracked files:
   ```bash
   git add .
   git commit -m "feat(creative-mode): complete Phase 1, 1.7, and Phase 2 (teacher profiles, onboarding, student avatars & topic mastery)"
   git push origin main
   ```

### Step 2: On your new PC (Setup)
1. Clone or pull the repository:
   ```bash
   git clone <REPO_URL>
   # Or if already cloned:
   git checkout main
   git pull origin main
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run verification test suite to ensure environment integrity:
   ```bash
   npx tsx scripts/test_teacher_profiles_phase1_7.mjs
   npx tsx scripts/test_creative_game_profiles.mjs
   npm run build
   ```
4. Verify Supabase migrations:
   - Ensure `supabase/migrations/013_teacher_profiles.sql` and `supabase/migrations/014_game_profiles.sql` have been run in your Supabase SQL editor.

---

## 🤖 Prompt to Paste to the AI Agent on the New PC

Copy and paste the exact prompt below into your Antigravity chat on the new PC:

```text
Please read CREATIVE_MODE_HANDOFF.md and DESIGN.md in the project root. 
Phase 1, 1.7, and Phase 2 are completed and verified (100% pass on all test scripts and npm run build).

We are now ready to implement Phase 3: Saved Exam → Creative Converter & Global Teacher Directory:
1. Build CreativeLauncherModal.tsx on SavedTestsPage.tsx with Word-Bank tile flattener and sub-mode selector.
2. Build TeacherCreativeDirectoryModal.tsx in QuizManagerPage.tsx with automatic Chemistry subject filtering, class filters, student drill-down, and PIN reset.
3. Wire Quiz Submission Telemetry so every Creative match writes to quiz_submissions.

Please inspect the codebase and proceed with Phase 3 following the project's DESIGN.md tokens and antislop guidelines.
```

---

## 📁 Key File Reference

- [CREATIVE_MODE_HANDOFF.md](file:///c:/testmaker/CREATIVE_MODE_HANDOFF.md) — This file.
- [DESIGN.md](file:///c:/testmaker/DESIGN.md) — Brand tokens (`ENERGY 2 / RHYTHM 2 / MOTION 1`, colors `#24448c`, `#8abf44`).
- [supabase/migrations/013_teacher_profiles.sql](file:///c:/testmaker/supabase/migrations/013_teacher_profiles.sql) — Teacher profiles SQL schema.
- [supabase/migrations/014_game_profiles.sql](file:///c:/testmaker/supabase/migrations/014_game_profiles.sql) — Student game profiles SQL schema.
- [src/services/teacherProfileService.ts](file:///c:/testmaker/src/services/teacherProfileService.ts) — Teacher profile service & caching.
- [src/services/gameProfileService.ts](file:///c:/testmaker/src/services/gameProfileService.ts) — Student game profile service, coins & topic mastery.
- [src/components/game/GameAvatarRenderer.tsx](file:///c:/testmaker/src/components/game/GameAvatarRenderer.tsx) — 6-layer parametric SVG avatar engine.
- [src/components/game/GameProfileStudioModal.tsx](file:///c:/testmaker/src/components/game/GameProfileStudioModal.tsx) — Student Creative Hub modal.
- [scripts/test_teacher_profiles_phase1_7.mjs](file:///c:/testmaker/scripts/test_teacher_profiles_phase1_7.mjs) — Automated test suite for Phase 1 & 1.7.
- [scripts/test_creative_game_profiles.mjs](file:///c:/testmaker/scripts/test_creative_game_profiles.mjs) — Automated test suite for Phase 2.
