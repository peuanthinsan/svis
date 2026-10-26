# Independent owner-read privacy review

Provider: Codex. Model: inherited GPT-6 Astra Pro. Effort: UNKNOWN.
Phase: read-only review of the other implementation lanes, refreshed after the final inactive-inventory delta; 2026-10-26.
Reviewer lane: account/mobile-admin implementer. This review excludes that lane's own account and mobile-admin implementation.
Fallback reason: Claude tools/CLI were unavailable in the session. This additional Codex review does **not** satisfy or replace the opposite-provider review requested by WORKSPACE.md.

## Reviewed state

- Base and HEAD: `190e4ba92eb2538f8e6fc883d92a5374955b4637`; changes are uncommitted.
- SHA-256 of all 41 reviewed files, including new files: `33362dcea203cfb74e52624cbef7a3208df466925854ad49418ca406429951ad`.
- SHA-256 of `git diff --no-ext-diff --binary <base> -- <paths below>`: `49396698371c37fbb3581da193bf56ac60820855073ea1a358abaf0aab916716`.
- Full-content hash recipe: sort the paths below lexicographically; concatenate each UTF-8 path, a NUL byte, its exact file bytes, and a NUL byte; SHA-256 the concatenated bytes. The diff hash alone excludes untracked files.
- This receipt applies to that state only. A subsequent change to a reviewed source requires review of the delta.

```text
api/dashboard.ts
api/dashboard/export-ticket.ts
api/dashboard/export.ts
api/history.ts
api/inspections.ts
api/inspections/[id].ts
api/issues.ts
api/issues/[id].ts
api/issues/[id]/notify-vendor.ts
api/issues/export.ts
api/issues/import.ts
api/maintenance.ts
api/unit-status.ts
api/upload.ts
api/vehicles.ts
app/(app)/vehicles/[id]/inspect.tsx
app/(app)/vehicles/index.tsx
lib/api-auth.ts
lib/export-download-ticket.ts
lib/i18n.ts
lib/types.ts
lib/vehicle-access.ts
tests/export-download-ticket.test.mjs
tests/vehicle-owner-read-access.test.mjs
tests/vehicle-owner-ui.test.mjs
tests/web-auth-routing.test.mjs
web/src/App.tsx
web/src/AuthContext.tsx
web/src/api.ts
web/src/auth.ts
web/src/components/InspectionResultDialog.tsx
web/src/components/Layout.tsx
web/src/i18n.ts
web/src/owner-vehicle-selection.ts
web/src/pages/DashboardPage.tsx
web/src/pages/ExportPage.tsx
web/src/pages/HistoryPage.tsx
web/src/pages/InspectionsPage.tsx
web/src/pages/IssuesPage.tsx
web/src/pages/OwnerVehiclesPage.tsx
web/src/styles.css
```

## Findings

**No unresolved confirmed defect in the reviewed scope.**

- **Resolved during review — assigned inventory without GPS.** The earlier web owner navigation had no complete vehicle inventory: a granted vehicle without GPS, inspection history or an exception appeared only in totals. Reported to root; the UI lane added `/dashboard/vehicles`. The reviewed state loads the owner-scoped vehicle endpoint through all pages, has search and read-only inspection history, and does not depend on GPS configuration. The route and owner navigation are present.
- **Final inactive-inventory delta reviewed after writer release.** Every owner inventory count/list branch retains the company and UUID allowlist and changes its active filter to a server-derived owner boolean OR the stored active flag. Assigned inactive vehicles therefore remain visible in totals, search, fleet filters and details; unassigned vehicles remain denied. Admin, Supervisor and Driver lists remain active-only regardless of client `includeInactive` input. The API supplies `is_active`, the web inventory shows translated Active/Inactive badges, and native owner rows show the existing translated inactive label only when the stored flag is false. No active flag or fleet membership is written by these reads.
- Owner filtering uses the explicit current membership list; an empty list remains an empty UUID array rather than becoming an unrestricted fleet query. Vehicle totals, pagination, history, issues, maintenance and dashboard aggregates apply this filter in SQL. ID lookups fail with 404 outside the owner's assignments. Optional fleet filtering narrows the set.
- Global GPS sheet rows are projected onto already-authorized database vehicles, with database fleet values retained. Owner requests do not record activity as a side effect. Inspection, issue, maintenance, upload and vendor-notification writes reject the owner role; administration remains behind the administrator guard.
- Report and issue exports retain company/vehicle scope. Download tickets snapshot vehicle grants, revalidate the active account/current role and intersect current grants at redemption. Revoked IDs disappear and later additions do not expand an existing owner ticket. Owner report fleet filters use current vehicle fleets consistently with the owner dashboard/history.
- Web storage holds authentication/UI preferences, not a persisted vehicle-data cache. Sign-out clears the session and unmounts protected content. Owner navigation and direct inspection routes are read-only. Native owner vehicle browsing bypasses the prior company-wide offline vehicle cache.

## Verification performed by this reviewer

- `node --experimental-strip-types tests/vehicle-owner-read-access.test.mjs`: **11/11 passed** after the final inactive delta, including inactive owner counts/filter/detail and all three legacy roles' active-only behavior.
- `node --experimental-strip-types tests/vehicle-owner-ui.test.mjs`: **7/7 passed**, rerun after the final inactive delta.
- `node --experimental-strip-types tests/web-auth-routing.test.mjs`: **4/4 passed** after the final delta.
- `node --experimental-strip-types tests/export-download-ticket.test.mjs`: **14/14 passed**.
- Inspected the UI lane's current desktop screenshot at `/workspace/scratch/9719e7787fa0/owner-ui-vehicles-desktop.png`: a synthetic assigned inactive vehicle appears after fleet search with an Inactive badge and its read-only saved-inspection panel open. The UI lane performed the browser interactions; this reviewer inspected the resulting image and source.
- Reviewed the independent read-scope lane's final `receipt-sql.md`, which records **23 passing real PostgreSQL groups**, including assigned inactive inventory and legacy-role active-only requests. This is separate evidence, not a new database run by this reviewer.
- Inspected the changed endpoint queries and guards, detail/evidence queries, export capability flow, relevant web routes and local state, and native cache bypass. No source edits were made as part of this review.

## Limits

- These automated checks use request/SQL boundary fixtures; they do not constitute a full deployed end-to-end or live database privacy test. The independently executed embedded PostgreSQL checks belong to the read-scope lane's separate receipt.
- The new inventory was checked in source and in the UI lane's provided desktop image. This reviewer did not personally operate the browser or a native device/emulator.
- No production data access or mutation, deployment, commit, push, or merge was performed.
