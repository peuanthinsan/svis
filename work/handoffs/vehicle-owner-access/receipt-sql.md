# Isolated PostgreSQL validation receipt

Provider: Codex, independent read-scope lane reviewing root migration and account-management lane SQL. Model: GPT-6 Astra Pro. Effort: UNKNOWN. Phase: integration validation. Base: `190e4ba92eb2538f8e6fc883d92a5374955b4637`. This does not replace the WORKSPACE.md opposite-provider review gate.

Environment: ephemeral in-memory PostgreSQL through PGlite, with synthetic companies, users, plates, inspections and issues only. No production connection, customer record or credential was used. Repository schema migrations through 024 were applied, excluding data-only 003/010 seeds. The optional `CREATE EXTENSION pgcrypto` declaration in 001 was omitted because core PostgreSQL `gen_random_uuid` is available. Migration 025 was then applied twice successfully.

Validated source SHA-256 values:

- `sql/025-vehicle-owner-access.sql`: `384910930212703f6c4346b120f1abf3e050c4e9c66f657cac729333d294300f`
- `lib/owner-vehicle-assignment.ts`: `4ae6ca2c30214536155be4017f9610f0c09836b223115a6d0ebce1d5c81849de`
- `lib/vehicle-access.ts`: `c9298cdd4d423dcea206c032080e99597f8d0d4be0d07eea224f49da93b746c4`

The original 13 verification groups below passed again in the final run. Together with the root auth/export checks, corporate-name regression and owner inventory regression below, the extended script now passes **23 verification groups**:

1. Migration 025 succeeds and is rerunnable after the existing schema chain.
2. Real create-account CTE grants vehicles in separate fleets and clears an owner's operational fleet field.
3. Missing/foreign-company vehicle selections leave no partial account or grants.
4. Single-statement catalog includes inactive same-company vehicles and excludes another company.
5. Real update CTE replaces grants, preserves overlapping selected IDs without duplication, and does not accumulate previous selections.
6. Invalid update leaves name, password hash and grants unchanged.
7. Empty selection removes all grants; role conversion removes grants; a non-owner cannot receive selections or a partial profile change through a rejected request.
8. Composite foreign keys reject user and vehicle tenant mismatches; two owners may share one vehicle.
9. Under a non-owner database role with RLS enabled, owner SELECT visibility is restricted across vehicles, inspections, inspection results, issues and membership rows.
10. RLS rejects owner grant/inspection/result/issue INSERTs and returns no rows for attempted tested UPDATEs/DELETEs.
11. RLS preserves distinct owner lists, company isolation, driver/supervisor fleet scope and admin company scope.
12. Removing a grant affects the next SELECT; all fixture fleet memberships remain identical before and after account/assignment operations.
13. Fifteen calls through actual API handlers execute successfully against PostgreSQL: vehicle list/filter/detail, dashboard, maintenance, unit status, normal/filtered/out-of-service history, inspection list/detail, issue list/filter/detail and issue XLSX export.

Final corporate-name regression on the updated helper: creating and editing a corporate `vehicle_owner` with an empty surname succeeds and preserves selected vehicles. Attempting conversion to each of `driver`, `supervisor`, and `admin` with an omitted, empty or whitespace-only surname returns 400. All nine rejected cases leave name, password hash, role, fleet, update timestamp and grants unchanged. Supplying a nonempty surname permits each conversion and clears owner grants atomically. The complete earlier PostgreSQL suite passed again with this updated helper.

Final owner-inventory regression: actual `/api/vehicles` requests return both active and explicitly assigned inactive vehicles, including `is_active = false`, with matching total/search/fleet-filter results. Actual Admin, Supervisor and Driver list requests remain active-only even with an `includeInactive=true` parameter. This was verified using the existing inactive PostgreSQL fixture and the complete script passed again.

Reproduction in this workspace: `node /tmp/svis-owner-db-qa/verify-owner-sql.mjs`. Structured result: `/tmp/svis-owner-db-qa/result.json`. The script and dependency installation are temporary QA artifacts outside source.

Limits: PGlite uses one connection. Actual contention between two independent database sessions was not reproduced. The account row lock and subsequent READ COMMITTED mutation snapshot ordering were inspected, and sequential complete replacements were executed; do not describe this as a multi-session concurrency stress test. Windows host adapter behavior is separately owned and tested by root. No implementation changes were needed during this independent SQL review.
