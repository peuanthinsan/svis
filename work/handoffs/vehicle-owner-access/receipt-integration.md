# Integrated vehicle-owner implementation receipt

Provider: Codex. Model: GPT-6 Astra Pro. Effort: UNKNOWN. Phase: root integration and final verification. Date: 2026-10-26.

Base: `190e4ba92eb2538f8e6fc883d92a5374955b4637`. Feature branch: `feat/vehicle-owner-access`. All implementation writer leases are released to root. No production database, live customer account, vehicle fleet membership, published branch, deployment or release was changed.

## Final delivered behavior

- A separate read-only `vehicle_owner` role uses same-company, administrator-managed vehicle ID grants across fleets. Empty grants mean no access, and multiple owners may share a vehicle.
- Web and native administrator forms create/edit account fields and the complete vehicle selection atomically. Corporate customer names may omit a surname; conversion to an operational role requires a surname without partially changing the account on failure.
- The web editor accepts a customer column from CSV/XLSX or pasted plates, blocks unmatched/ambiguous lists and preserves hidden selections through filtering. All catalog pages are loaded.
- Owner vehicle, history, inspection, issue, maintenance, telemetry and export reads are scoped before totals and pagination. The inventory includes assigned inactive vehicles with web/native status labels. Existing operational-role active-only inventory remains unchanged.
- Owner writes to operational data are rejected. Current account state is resolved for authenticated requests; revoked grants and demoted/disabled users cannot rely on old token claims. Owner export tickets snapshot grants and revalidate at redemption.
- Migration 025 is additive and guarded by a dry-run/confirmation-aware runner. The Windows PostgreSQL adapter supports the required transaction semantics. Fleet assignments are never updated by ownership access.

## Final verification

| Check | Result |
| --- | --- |
| `npm test` | 312 total; 308 passed; 0 failed; 4 skipped |
| Existing skipped cases | Gitignored private seed fixtures absent from checkout |
| `npm run typecheck` | Passed after final native status change |
| `npm run build --prefix web` | Passed after final inactive inventory UI change |
| `node host/build.cjs` | Passed; 39 API routes |
| Windows hosting regression suite | 69 passed; 0 failed |
| Isolated PostgreSQL integration suite | 23 groups passed |
| Rendered browser checks | Passed at 1366×950 and 390×844 with synthetic fixtures |
| Actual private workbook parsing | Two distinct customer columns parsed with no overlap or ambiguity; no source plates embedded in repository |
| `git diff --check` | Passed |

Root visually inspected the desktop/mobile administrator checkbox editor and the final owner inventory with inactive status. The browser run reported no app page/console errors. Backend verification executed real SQL in PGlite, actual auth/report/account modules and the actual Windows adapter with an isolated transport. Source details are in the bounded implementation/review receipts.

Test execution used local subprocess permission because the default environment denied Node child process creation. No test targeted production. Source parsing against synthetic IDs does not prove live vehicle matching. The single-connection database harness cannot reproduce two-session lock scheduling. Native physical-device end-to-end behavior was not exercised.

## Integrated source identity

SHA-256 of 69 changed/new source, test, schema and documentation files: `c8907c7720aa9cdd736c9483f71198e00ecc9ccada3344f80a9dcf5b82fc880b`.

Recipe: sort the changed/new paths excluding `work/handoffs/`; concatenate each UTF-8 path, a NUL byte, its exact file bytes, and another NUL byte; hash with SHA-256. Handoff receipts are excluded to avoid circular hashes. The final commit records the exact file set.

## Review and remaining release gate

`receipt-independent-review.md` reviews the final owner read/UI delta, including inactive inventory. `receipt-sql.md` and `receipt-root-review.md` record independent account/schema/root-module verification. These are same-provider Codex reviews. Claude tools/CLI were unavailable, so the opposite-provider review required by `WORKSPACE.md` remains outstanding; no fallback is represented as equivalent approval.

The remaining actions are approval to publish for review, the required opposite-provider review, approved database migration/deployment, live workbook-to-catalog reconciliation and creation of the two separate customer accounts. This receipt does not claim those actions are complete. Customer details and exact plate lists belong only in the private handoff outside the public repository.
