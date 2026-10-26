# Mobile administrator user editor receipt

Provider: Codex. Model: inherited GPT-6 Astra Pro. Effort: UNKNOWN.
Phase: implementation and lane verification. Base: `190e4ba92eb2538f8e6fc883d92a5374955b4637`.
Authorization: root's bounded follow-up assignment for the mobile administrator editor.
Writer lease: released to root.

## Changes

- Added the vehicle-owner role to mobile user creation/editing and list badges, with the shared Thai/English role label.
- Owners use a searchable administrator checklist in the existing modal. Each row shows plate and current fleet, and marks inactive vehicles. Checkbox accessibility states and a selected count expose the saved selection clearly.
- The fleet field is hidden for owners. The form explains owner read-only access, unchanged vehicle fleets, and what an empty selection means.
- Existing owners retrieve their catalog and assigned IDs from `GET /api/admin/users/:id/vehicles`. New or converting owners load every `/api/admin/vehicles` page before enabling Save. Malformed, incomplete, non-advancing or superseded loads cannot silently become empty selections.
- Modal changes and role changes invalidate older requests through a generation guard. Loading, unavailable or failed owner selections disable Save; a retry control is provided.
- Profile fields and the complete selected ID list are submitted in one account create/update request. Editing only names/password preserves the loaded selection. Non-owner requests do not include `vehicleIds`.
- Long lists show 100 rows at a time with an explicit shown/total count and Load more control. Filtering searches the complete loaded catalog, and rows outside the visible slice remain in the selected state.
- Root supplied all requested shared i18n keys. This lane did not write shared i18n or web paths.
- Superseding corporate-customer revision: owner forms label the first name as Customer name and surname as optional, in Thai/English. Owners may save a blank surname; the existing person-role surname requirement remains. Payloads retain an explicit owner role and submit the blank surname with the selected vehicles atomically.

## Owned files

- `app/(app)/admin/users.tsx`
- `tests/vehicle-owner-mobile-admin.test.mjs`
- This receipt.

## Verification

- `node --experimental-strip-types tests/vehicle-owner-mobile-admin.test.mjs`: **11 tests passed** after the corporate-customer revision. Coverage includes complete 501-row catalog retrieval, exact page boundaries, inactive selections, malformed/invisible rows, pagination stalls, superseded requests, Save gating, profile edits, zero selections, role conversion payloads and a customer name without a surname.
- `npm run typecheck`: passed after mobile implementation and root's shared translations.
- `git diff --check`: passed.
- The account-management lane's **21 tests passed** after the Windows transaction compatibility correction and optional owner-surname support.

## Limits

- Native iOS/Android visual rendering and nested scrolling were not exercised in a device or emulator in this lane. The checklist uses existing modal styling and ordinary React Native controls.
- This mobile editor supports searchable checkboxes. Spreadsheet/paste bulk matching is available in the web editor implemented by the UI lane.
- No production database write, deployment, git commit/push/merge or customer-data publication was performed.
- This implementation receipt does not replace the required opposite-provider review. See root's review fallback record.
