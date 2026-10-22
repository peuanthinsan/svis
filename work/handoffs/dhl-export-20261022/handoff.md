# DHL export download repair

- Active root: Codex / GPT-6 Astra Pro; effort UNKNOWN.
- Base: `5286f4c47ae83cf30a4fcf9f7b88aa748e7e65ce` (`main`). Clean checkout verified before edits.
- Objective: remove the dashboard file download's dependence on a bearer header surviving a cross-origin proxy redirect. Preserve tenant/fleet authorization and require a short-lived, single-use, export-only ticket.
- Evidence: supplied console screenshot shows Zscaler, CORS rejection and 401. Repository uses header-only auth and fetch/blob downloads. These observations do not independently prove the production request's missing header. The Windows host already has an exact-origin CORS allowlist. Its request logger omits proxy-return/auth-presence fields. Connected Vercel project exposes only its vercel.app domain; its logs are not confirmation for the custom hostname.

## Implementation scope and ownership

- Backend lane: `lib/export-download-ticket.ts`, `lib/export-http.ts`, `api/dashboard/export-ticket.ts`, `api/dashboard/export.ts`, `sql/024-export-download-tickets.sql`, `tests/export-download-ticket.test.mjs`.
- Host diagnostics lane: `host/export-diagnostics.cjs`, `host/export-diagnostics.test.cjs`, `host/server.cjs`.
- Root: `web/src/api.ts`, `web/src/pages/ExportPage.tsx`, `web/src/i18n.ts`, `lib/i18n.ts`, focused frontend tests, this handoff/receipt, integration and verification.
- No delegated lane may commit, stage, push, merge, deploy, or modify git state. No overlapping writer leases.

## Contract

1. `POST /api/dashboard/export-ticket` accepts JSON `{fleetId?, dateStart?, dateEnd?}` with ordinary bearer authentication. It validates input, binds tenant and effective fleet on the server, writes a durable ticket record and returns `{downloadUrl, expiresAt}` quickly, before workbook generation.
2. `GET /api/dashboard/export?downloadTicket=...` validates a purpose-separated signed capability and atomically redeems its database record. The database record supplies immutable report scope. Extra query parameters, including `_sm_nck`, cannot widen that scope. The existing authenticated GET remains available to existing clients.
3. Ordinary session tokens cannot be used as download tickets, and download tickets cannot be used as general API credentials. No full session token in a URL. No wildcard or null CORS origin allowance.
4. Only GET can consume a ticket. Expired, tampered, replayed and concurrently redeemed tickets fail closed. Downloads retain attachment headers and no-store caching. A failed generation requires a fresh ticket.
5. Dashboard requests the ticket and initiates a normal navigation; it does not fetch the report bytes. The ticket POST can still be intercepted, so testing the actual DHL policy remains a release criterion.
6. Export diagnostic logs record bounded request metadata and credential presence only. Never log bearer/ticket values or complete query strings.

## Migration safety

The requested single-use URL requires durable replay state. Scope explicitly includes preparing an additive ticket-table migration. No migration is applied, no database connection is opened against a customer environment, and no database target or environment file is changed. Validate the SQL using an isolated local database if available. Review and apply through the existing guarded migration mechanism only after approval and target verification.

## Limits and release gates

- This is the immediate download/auth repair. Workbook generation remains synchronous during the navigated GET. A durable async job needs its own worker trigger, retry/lease policy and private artifact storage; it is not represented as implemented by this patch.
- Production server/HAR verification and a DHL-network acceptance run remain necessary.
- WORKSPACE.md requires opposite-provider review and explicit approval for publishing, deployment and database writes. Claude tooling was not found in the active environment; record that gate as pending, with independent Codex review as additional evidence only.
- Subsequent user instruction on 2026-10-22: "draft pr merge to main", after disclosure of the unavailable Claude review. Publication and merge are now authorized; preserve the review limitation in the record and observe GitHub checks/protection. This does not authorize production database writes or infer a deployment target.
- Do not change `.env*`, database targets, existing migrations, Vercel configuration, release artifacts, or production state.
