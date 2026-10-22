# DHL export repair — rollout and acceptance

## Gates before release

`WORKSPACE.md` calls for Claude review of substantive Codex implementation, plus explicit approval for publication, database writes, and deployment. After disclosure that Claude was unavailable and independent Codex review had completed, the user explicitly authorized creating a draft PR and merging to main. Normal GitHub checks and branch protection still apply. No production database target was changed or inferred from the connected Vercel project; schema readiness and application activation remain separate release steps.

Review the patch against base `5286f4c47ae83cf30a4fcf9f7b88aa748e7e65ce`. Verify the implementation hashes in `source-sha256.json`; the patch contains only the 15 implementation/test/migration files listed there. The accompanying receipt records the evidence and its limits.

## Approved deployment order

1. Confirm which service actually handles `svis.songdeegps.com`, its protected runtime configuration, database target, active release, and rollback release. The repository documents `hosting/launch.cjs` with `SONGDEE_CONFIG` as the Windows release entrypoint. A Vercel default-domain project alone does not establish the custom hostname's backend.
   The repository enables Vercel Git deployments. Check live project controls before merging if the linked production deployment could activate immediately; GitHub CI itself neither deploys nor migrates. The external Windows controller's live behavior is not established by this repository.
2. On the explicitly approved database, apply **only** `sql/024-export-download-tickets.sql` using the operator's approved migration procedure. It creates a table and indexes; it does not modify business data. The repository's older `scripts/run-sql.js` is a bootstrap script, not a runner for this migration. Do not invoke it to apply 024.
3. Build and validate the reviewed backend and dashboard through the existing packaging pipeline. Deploy both together after the table exists. Keep the existing bearer GET available for older clients.
4. Validate the ordinary-network flow, then run the DHL-network acceptance checks below while correlating request IDs in the actual host log.
5. Roll back the application release if acceptance fails. The additive table can remain unused during application rollback; dropping it is a separate database mutation and is not needed to restore the prior application.

## Server-side confirmation

For the original incident, obtain the correct date/time/timezone and the actual service/reverse-proxy logs for `/api/dashboard/export`. The existing log format may not retain `_sm_nck` or Authorization presence. A sanitized HAR can correlate the redirect chain, status, request headers, and request ID; redact bearer credentials, ticket values, personal data, and full proxy-authentication URLs before sharing.

The new host diagnostics record these bounded fields:

| Field | Interpretation |
| --- | --- |
| `route` | Export or ticket endpoint |
| `status` | Final HTTP status observed by the host |
| `requestId` | Server-generated ID, also returned as X-Request-ID |
| `authPresent` | Whether an Authorization header was present; never its value |
| `proxyAuthReturn` | Whether an exact `_sm_nck=1` value was present; observational only |
| `originClass` | `absent`, `null`, `svis`, `vercel`, or `other` |
| `ms` | Request duration |

For a reproduced legacy failure, the expected correlation is route `/api/dashboard/export`, status 401, `proxyAuthReturn: true`, `authPresent: false`, and potentially `originClass: null`. This is an acceptance criterion, not a claim that those production logs were found.

For the new flow, verify a successful authenticated ticket POST followed by a navigated export GET. Absence of the Authorization header on the ticketed GET is expected. The ticket, not the proxy marker, authorizes that request.

The application does not log ticket values. Confirm that upstream access logs, APM, analytics, and error capture also redact the `downloadTicket` query value before live rollout.

## DHL-network acceptance

- Sign in with the authorized customer account, select a bounded fleet/date range, and request an export.
- Confirm the POST returns a same-origin ticket URL promptly, and the download is a browser navigation. Neither a full session token nor report scope should appear in that URL.
- Follow any corporate authentication redirect and confirm the returned GET downloads a valid workbook with the intended data scope and all four sheets.
- Repeat with a representative large range and record total duration, response status, and whether the proxy terminates the request. This determines whether the synchronous-generation limit remains material.
- Try the same ticket again: expect 410. HEAD and OPTIONS must not consume it. A fresh request must still succeed.
- Test an expired sign-in and an intercepted ticket POST: the page should provide sign-in or network guidance without claiming download completion.
- Confirm exact-origin CORS on error responses. Do not allow wildcard or null origins to compensate for a removed bearer header.

DHL IT's targeted authentication exemption for the application hostname remains a relevant short-term measure. Zscaler documents URL authentication exemptions for applications that cannot handle its authentication redirect/cookie flow. Authentication exemption and TLS inspection exemption are separate policy choices; the supplied evidence specifically identifies authentication redirects. The actual DHL configuration and hostname/path scope must be verified by DHL IT.

## Background generation follow-up

The current patch makes ticket creation quick, but the navigation GET still creates the workbook. If large-report acceptance demonstrates timeouts, implement a durable export-job pipeline:

1. Authenticated job creation validates and stores immutable company/fleet/date scope and returns 202 with a job ID.
2. A separately operated worker claims jobs with leases, bounded concurrency, retries, and stale-job recovery; it generates the workbook outside the HTTP request lifetime.
3. Store the workbook privately with an expiry and owner-scoped status access. The repository's existing public upload path is not an appropriate default for private reports.
4. After the job is ready, issue the short-lived one-use navigation capability. Its expiry starts when issued, not when the long-running job was submitted.
5. Add retention cleanup and observable failure states. Verify storage access and database/job concurrency on the actual deployment platform.

An unawaited promise or in-memory timer after returning the request is not this durable job system. The worker/storage deployment choice requires the actual host target and operating model; this patch does not pretend that infrastructure exists.
