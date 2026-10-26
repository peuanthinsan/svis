# Bounded independent root review

Provider: Codex, read-scope lane reviewing root implementation. Model: GPT-6 Astra Pro. Effort: UNKNOWN. Phase: independent code review and PostgreSQL integration verification. Base: `190e4ba92eb2538f8e6fc883d92a5374955b4637`. This is the recorded same-provider fallback; it does not satisfy the WORKSPACE.md request for Claude review.

Reviewed scope: `lib/api-auth.ts`, `lib/export-download-ticket.ts`, `api/dashboard/export-ticket.ts`, `api/dashboard/export.ts`, and `host/pg-neon.cjs`.

## Findings

One functional inconsistency was found and resolved by root. An owned vehicle inspected in fleet A and subsequently in fleet B appeared in owner history filtered to B, but its export disappeared because the report filtered by inspection-time fleet. Root changed owner vehicle-scoped export filters, grouping and detail labels to use current vehicle fleet while preserving operational-role historical fleet behavior. PostgreSQL reproduction now verifies both history and export include the moved vehicle and the By Fleet sheet shows matching vehicle/inspection counts with no obsolete A row.

No unresolved defects were found in this bounded reviewed snapshot. This statement does not cover unrelated application code or replace deployment verification.

## Verification

The extended script `/tmp/svis-owner-db-qa/verify-owner-sql.mjs` passed **23 PostgreSQL verification groups**, including all 13 prior schema/account/read groups, two final corporate-name regression groups, the final owner-inventory active/inactive regression, and these additional checks against real root modules:

1. Actual JWT verification resolves current active user/company and ignores stale role/name claims. Invalid tokens and company-mismatched tokens are rejected.
2. The actual owner ticket endpoint persists an explicit UUID array. After an administrator revokes one vehicle and grants another, actual download workbook contents are the intersection of the issuance snapshot and current grants. Query overrides cannot expand it; replay returns 410.
3. An owner ticket containing an empty UUID array stays empty after new assignments. It never behaves like the SQL NULL used for legacy role/fleet scope.
4. Disabling the account or company rejects existing JWTs and outstanding downloads; disabling the account also rejects new ticket creation.
5. An actual admin JWT issued before demotion resolves to the current owner role. Vehicle lists, bearer-authenticated reports and an already issued SQL-NULL admin ticket all narrow to the owner's current assignments.
6. The actual Windows `pg-neon.cjs` adapter executed over a PGlite transport: request authentication SELECT, nested ticket issuance, nested account replacement and ticket redemption all succeeded. The adapter used explicit `BEGIN ISOLATION LEVEL READ COMMITTED` plus savepoints and emitted no nested `SET TRANSACTION`.
7. The fixed fleet-transfer case produces consistent current-fleet owner history and export, including By Fleet totals.

Final regression: a corporate owner can have a blank surname; conversion to any operational role with no effective surname leaves profile, password hash, role, fleet, timestamp and grants unchanged. With a supplied surname, conversion succeeds and clears owner grants. The exact updated account-helper hash is recorded in `receipt-sql.md`; all root-source hashes below remain unchanged and were reverified in the same full run.

Only the PostgreSQL transport and external request/response boundaries were substituted; the authentication, ticket, report, helper and Windows adapter implementations themselves executed. Generated XLSX contents were parsed and checked with ExcelJS. No production connection, customer records, external write or credential was used.

Limit: one PGlite connection cannot reproduce two-session contention scheduling. Isolation, savepoint SQL and sequential replacement/redemption semantics were exercised; multi-session stress behavior is not claimed.

## Reviewed source SHA-256

- `lib/api-auth.ts`: `da20d351fd30c9f07774add9acba3875deb576692b57741c70c1ef7b8e11e0a7`
- `lib/export-download-ticket.ts`: `7c3e69e66bf669205cc0d79196771b46dbf1fad64b59465d176ff0ea386ac574`
- `api/dashboard/export-ticket.ts`: `84fd4194fa605debd00df2df1515cfbfe5525a2ad85f64696e90001582b0dd54`
- `api/dashboard/export.ts`: `1536dbbd7c7f9ea1401ee4e7353ee5bf168ece103e1ad416ac542ad3fb887c34`
- `host/pg-neon.cjs`: `05c4e0b4508ecdfb35d75a7937c81e71c236ca959b468dd05a8f9379acaf08dd`

Any change to these reviewed sources invalidates this receipt for the changed snapshot. Structured results are in `/tmp/svis-owner-db-qa/result.json`.
