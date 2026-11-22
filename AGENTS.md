# TestMaker Agent Rules

## Planning Documents Convention
- Whenever creating plan markdown documents (such as feature blueprints, architectural migration specs, bug diagnosis plans, or implementation roadmaps), **ALWAYS** create them inside the `Plan/` folder (e.g., `Plan/<topic>.md`).
- Do not create plan markdown files directly in the repository root.

## Release Command (`bump`)
- Whenever the user commands `bump`, execute the full release flow:
  1. Bump the patch version (unless a minor/major bump is requested) across `package.json`, `package-lock.json` (root & `packages[""]`), `src/config/version.ts`, and `README.md` (header version & badge).
  2. Prepend a new versioned changelog section under `## Changelog` in `README.md` summarizing the changes since the previous release.
  3. Run verification checks (`npm run lint`, `npm run build`, and relevant tests), commit all release changes cleanly, and push to `main`.


