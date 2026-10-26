# Account management lane receipt

Provider: Codex. Model: inherited GPT-6 Astra Pro. Effort: UNKNOWN.
Phase: implementation and lane verification. Base: `190e4ba92eb2538f8e6fc883d92a5374955b4637`.
Writer lease: account-management paths released to root after this receipt.

## Changes

- Added `vehicle_owner` to administrator user create, update, list/filter, import and export.
- Added `GET /api/admin/users/:id/vehicles` with the complete company vehicle catalog and the owner's selected IDs. Inactive rows remain visible; no catalog pagination limit can silently discard a saved selection.
- Added `PUT /api/admin/users/:id/vehicles` for complete checklist replacement. Only administrators can call it and its target must be a vehicle-owner account in their company.
- Added shared UUID validation, same-company vehicle validation and account/assignment mutation helpers. Empty selections grant zero vehicles. Omitted selections preserve existing grants on owner updates and create new owners with zero grants.
- Account creation and initial grants use one guarded SQL statement. Account updates, password changes and assignment replacement use a READ COMMITTED transaction with a company-scoped account row lock followed by a guarded CTE. Foreign/missing vehicle IDs do not permit a partial account mutation.
- Removing the owner role deletes old grants in the same transaction. Import accepts the human labels `Vehicle Owner`, `vehicle-owner`, and `vehicle_owner`; owner-to-owner import preserves its checklist and importing a different role revokes it.
- Owner account `fleet_id` is blank. No SQL in this lane updates vehicle fleet membership.
- No customer plate dataset was added to the repository.
- Superseding host-compatibility revision: the edit transaction passes `{ isolationLevel: 'ReadCommitted' }` without a raw `SET TRANSACTION`, so the Windows adapter can use its request transaction/savepoint correctly. Catalog retrieval now uses one correlated JSON/array SELECT, guaranteeing a shared snapshot independently of adapter transaction-option support.
- Superseding corporate-customer revision: owner creation permits an omitted/blank surname while retaining the required customer name and 100-character name bounds. Explicit owner-role edits can clear the surname; other roles still require it. An owner-to-person role conversion without an effective surname is blocked inside the same guarded mutation, so profile/password/grants remain unchanged. CSV/XLSX owner imports preserve multiword customer names and allow a blank surname.

## Owned files

- `api/admin/users/index.ts`
- `api/admin/users/[id].ts`
- `api/admin/users/import.ts`
- `api/admin/users/export.ts`
- `api/admin/users/[id]/vehicles.ts`
- `lib/owner-vehicle-assignment.ts`
- `tests/owner-vehicle-assignment.test.mjs`
- This receipt.

## Verification

- `node --experimental-strip-types tests/owner-vehicle-assignment.test.mjs`: **21 tests passed** after the corporate-customer revision. Coverage includes malformed UUID selections, foreign/missing vehicle rejection, guarded account/password updates, empty versus omitted selections, role conversion, full/inactive catalog, all role guards, create/update request integration, optional owner surnames, person surname requirements, name length limits, CSV/XLSX customer-name fidelity, import behavior, and generated export contents.
- `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types --test tests/owner-vehicle-assignment.test.mjs`: passed.
- `git diff --check`: passed.
- `npm run typecheck` at lane verification time reported one error in concurrently edited root-owned mobile code: missing `profile.vehicleOwner` i18n key in `app/(app)/profile/index.tsx`. No error pointed at this lane's files. Root was informed.
- The 16 assignment tests passed again after the Windows compatibility revision. Root subsequently supplied the missing mobile i18n key.
- `npm run typecheck`: **passed** after the corporate-customer revision and root's shared translations; this supersedes the earlier shared-i18n error.
- Independent read-scope lane subsequently executed the latest helper SQL against embedded PostgreSQL. It reported successful create, same-company/foreign-ID checks, no partial account/password update, replacement/overlap, empty selections, role conversion, inactive/full catalog and composite-FK checks. Script: `/tmp/svis-owner-db-qa/verify-owner-sql.mjs`. It did not validate multi-connection contention.
- Final independent PostgreSQL rerun also passed the corporate-surname regression: all nine invalid person-role conversions (three roles × omitted/empty/whitespace surname) left the profile, password, role, fleet, timestamp and grants unchanged. All three nonempty-surname conversions succeeded and cleared grants; corporate owner creation/editing with an empty surname succeeded. The broader SQL harness now reports **23 passing groups**, including the subsequent inventory-inactive regression. See `receipt-sql.md` for exact helper/schema hashes and reproduction.

## Limits and integration notes

- This lane's tests use a scripted Neon adapter. Independent embedded PostgreSQL checks now cover actual CTE execution and foreign-key validation. Multi-connection contention still needs staging validation before relying on concurrency behavior operationally.
- Checklist saves serialize and replace complete sets. They do not yet expose optimistic version tokens, so a later save can overwrite an earlier administrator's choices.
- The new membership table and role constraint migration must be applied before deploying these account handlers.
- No git commit, push, merge, deployment, external mutation or database write was performed by this lane.
- This is an implementation receipt, not the opposite-provider review required by WORKSPACE.md. Claude was unavailable according to scope; root must record any review fallback accurately.
