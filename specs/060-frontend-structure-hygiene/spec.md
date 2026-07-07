# Feature Specification: Frontend structure hygiene

**Feature Branch**: `060-frontend-structure-hygiene`
**Created**: 2026-07-03
**Status**: Draft
**Input**: Holistic review finding (2026-07-03 SaaS/architecture/DRY+YAGNI re-evaluation): five
frontend concerns are split-brained, misplaced, duplicated, or dead — each gets a wire-or-delete
verdict.

## Overview

Structural cleanup of the SPA with zero user-visible change: state that belongs in the store moves
there, an account page stops hiding inside an auth-flow component, the unused shadcn input
primitives get used, formatting helpers converge on the tested `lib/format.ts`, and dead exports
are deleted.

Single responsibility: **every frontend concern has exactly one home and no dead affordances.**

## Finding & evidence

- **(a) Dataset selection is split-brain.** `selectedDataset` is App-local state
  (`apps/explorer-web/src/App.tsx:51`) prop-drilled into `DatasetList` (`App.tsx:169-175`) and
  `ChatPanel` (`App.tsx:216`; prop declared `chat/ChatPanel.tsx:53-54`, used for citation clicks at
  `:563`) — while its siblings `reader` and `chatFocus` live in the explorer store
  (`store/explorerStore.ts:29-30`). A citation opening a dataset needs a callback chain instead of
  a store action. (The map's transient hover/focus staying component-local is fine.)
- **(b) An account page hides inside a flow component.** `auth/KratosFlow.tsx:429-493`
  (`kind === 'settings'`) composes `AvatarUpload`/`AppearanceSection`/`SelfUsage`/`ApiKeys`
  (`:438-441`) — none Kratos-related — into the 558-line login/registration component. The
  `createFlow`/`getFlow`/`submitFlow` triplet (`:38-98`) is three five-way `if (kind === …)`
  ladders over the same SDK method families.
- **(c) Unused primitives vs 7 hand-rolled input class strings.** `components/ui/input.tsx` and
  `ui/textarea.tsx` have ZERO importers, while near-identical input classes are hand-rolled at
  `admin/SettingsPage.tsx:9-10` (`INPUT`), `auth/KratosFlow.tsx:100-101` (`INPUT_CLASS`),
  `admin/AdminUsage.tsx:95`, `account/ApiKeys.tsx:114`, `filters/FilterPanel.tsx:180`,
  `datasets/ResourcePreview.tsx:330`, `filters/SearchBar.tsx:41`. Verdict: **use them**.
- **(d) Formatting duplicated outside `lib/format.ts`** (which exists and is tested):
  `new Intl.NumberFormat('bg-BG')` at `admin/AdminUsage.tsx:7` and `account/SelfUsage.tsx:7`;
  `toLocaleString('bg-BG')` at `chat/ChatPanel.tsx:93`; a date formatter at
  `account/ApiKeys.tsx:14-15`; `initials()` implemented twice with different signatures
  (`auth/UserMenu.tsx:9` takes `AuthUser`, `account/AvatarUpload.tsx:37` takes `string` — same
  body).
- **(e) Dead exports.** `lib/theme.ts:29` `cycleTheme` (only its test imports it);
  `auth/guards.tsx:11` `RequireAuth` (only `RequireAdmin` is routed, `main.tsx:49`); `lib/api.ts:59`
  `fetchRegion`; `lib/scope.ts:32` `isEmptyFilter`; `lib/format.ts:14` `translationNote` plus the
  whole `Lang`/`'en'` branch — `bilingualLabel` is only ever called with `'bg'`
  (`DatasetDetail.tsx:59`, `DatasetList.tsx:35`): i18n built ahead of need. Verdict: **delete**.

## Requirements

- **FR-430**: Dataset selection MUST move into the explorer store (`openDataset(id)` /
  `closeDataset()` beside `reader`/`chatFocus`); the `onSelectDataset` prop and its drilling
  (`App.tsx:51,166-175,216`, `ChatPanel.tsx:53-54,563`) are deleted. Citation clicks call the store
  action directly. Store transitions are covered in `explorerStore.test.ts`.
- **FR-431**: An `AccountPage` component (own file, routed at `/auth/settings`) MUST own the
  account composition (avatar, appearance, usage, API keys, and the Kratos settings sections);
  `KratosFlow` shrinks to the generic flow renderer (login/registration/recovery/verification +
  the settings *form* rendering it exposes for reuse). UI strings and behavior are unchanged.
- **FR-432**: `createFlow`/`getFlow`/`submitFlow` (`KratosFlow.tsx:38-98`) MUST collapse into one
  kind→SDK-method map (single lookup per operation), preserving the per-kind body types.
- **FR-433**: All seven hand-rolled input/textarea class sites MUST render the `Input`/`Textarea`
  primitives (size/variant differences expressed via `className` overrides through the existing
  `cn`); the local `INPUT`/`INPUT_CLASS` constants are deleted. If a site genuinely cannot use the
  primitive (e.g. the chat composer's transparent textarea), it uses `Textarea` with overrides —
  not a parallel class string.
- **FR-434**: `lib/format.ts` MUST gain tested `formatNumber` (bg-BG), `formatDate` (bg-BG,
  `dateStyle: 'medium'`, `null → '—'`), and `initials(nameOrEmail: string)`; the five duplication
  sites in finding (d) call them (UserMenu adapts by passing
  `user.displayName?.trim() || user.email`).
- **FR-435**: The dead exports in finding (e) are deleted along with their now-orphaned tests and
  the `Lang` parameter threading: `bilingualLabel(bg, en, lang)` becomes `bilingualLabel(bg)` (or
  is inlined) and `translationNote` + the `'en'` branch are removed. No behavior change — Bulgarian
  output is already the only exercised path.

## Success criteria

- **SC-1**: `grep -rn "onSelectDataset" apps/explorer-web/src` returns nothing; selecting a
  citation still opens the dataset detail (store test + manual flow).
- **SC-2**: `KratosFlow.tsx` contains no imports from `account/`; `/auth/settings` renders
  identically (screenshot/DOM diff) via `AccountPage`.
- **SC-3**: `ui/input.tsx` and `ui/textarea.tsx` each have ≥1 importer;
  `grep -rn "rounded.* border.*border-input bg-background px-" apps/explorer-web/src` matches only
  the primitives.
- **SC-4**: `grep -rn "Intl.NumberFormat\|toLocaleString\|Intl.DateTimeFormat"` under
  `apps/explorer-web/src` matches only `lib/format.ts`; exactly one `initials` definition exists.
- **SC-5**: `grep -rn "cycleTheme\|RequireAuth\|fetchRegion\|isEmptyFilter\|translationNote"`
  under `apps/explorer-web/src` returns nothing; `bun run typecheck` and `bun test` green.

## Out of scope / dependencies

- The fetch/error/loading layer — **spec 057** (FR-433's touched files will also be edited there;
  land 057 first or coordinate).
- The chat lifecycle hook — **spec 058** (FR-430 removes the prop the hook must not depend on;
  058 should build against the store action).
- Shared payload types — **spec 059** (`Lang` deletion in FR-435 touches `types.ts`, which 059
  reshapes; sequence 059 → 060 or merge the `Lang` edit there).
- Backend dead-export/surface cleanup — **spec 056**; this spec is frontend-only.
