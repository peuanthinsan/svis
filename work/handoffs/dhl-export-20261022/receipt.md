# DHL export repair — implementation receipt

## Status

Prepared and verified locally on 2026-10-22. The user subsequently authorized creating a draft PR and merging to main after disclosure that Claude review was unavailable. This receipt accompanies that publication; the PR records its check and merge outcome. **No production migration or manual deployment has been performed.**

- Repository: `peuanthinsan/svis`.
- Frozen base: `5286f4c47ae83cf30a4fcf9f7b88aa748e7e65ce` (`main`).
- Provider/model: Codex / GPT-6 Astra Pro; effort UNKNOWN.
- Phase: implementation and local verification complete; publication and merge authorized by the user. Claude review was not performed.
- Writer leases: released. All changes belong to this task; no pre-existing work was present.

## Findings and evidence

The original dashboard downloads report bytes with a bearer-authenticated fetch. The API authenticates from the Authorization header only. A cross-origin redirect removes that header under the Fetch standard. The supplied Zscaler redirect chain is consistent with the reported 401 and CORS error.

An isolated Chromium test reproduced the entire chain using real HTTP 307 responses between two local origins: the first GET carried a bearer header; the returning GET contained `_sm_nck=1`, no bearer header, and `Origin: null`; the handler returned 401 and the browser reported Failed to fetch. This establishes the mechanism, not the historical contents of DHL's production request.

Read-only, unauthenticated production probes of `/api/dashboard/export?_sm_nck=1` returned:

| Request Origin | Status | Access-Control-Allow-Origin |
| --- | --- | --- |
| `https://svis.songdeegps.com` | 401 | `https://svis.songdeegps.com` |
| `null` | 401 | absent |

The production exact-origin error CORS behavior already works. Allowing an opaque/null origin would not restore the removed credential and is not part of this change.

**Production log confirmation remains unavailable.** The connected Vercel project exposes its vercel.app domain, not the custom hostname. Its available 23-hour `_sm_nck` search returned no matches; a broader route search timed out. Neither result establishes what happened on the custom host. The existing Windows host logger also did not record the proxy-return parameter or credential presence. Obtain the actual host/reverse-proxy logs and a sanitized customer HAR for the same time window before claiming the DHL request is independently confirmed.

References: [Fetch redirect algorithm](https://fetch.spec.whatwg.org/#http-redirect-fetch), [MDN Authorization](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Authorization), [MDN Access-Control-Allow-Origin](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Allow-Origin), [Zscaler URL authentication exemptions](https://help.zscaler.com/zia/exempting-urls-cloud-apps-authentication).

## Implemented behavior

1. The dashboard sends a short authenticated JSON POST to `/api/dashboard/export-ticket` with fleet/date filters. Workbook generation does not occur in this POST.
2. The server validates the filters and stores their authorized company/fleet/date scope with a five-minute signed ticket. Only a SHA-256 hash of the ticket is stored. The signing key context and token envelope are separate from ordinary session authentication. The URL contains no full session token or report scope.
3. The dashboard validates the returned same-origin URL and uses `window.location.assign` to download it. It no longer fetches dashboard report bytes into a blob.
4. The GET endpoint validates the signature and atomically deletes the durable ticket record with `DELETE ... RETURNING`. Extra URL parameters, including `_sm_nck`, cannot change its scope. HEAD and OPTIONS do not consume a ticket. Expired, invalid, or reused tickets return 410.
5. Issuance uses an owner-row lock and explicitly selects READ COMMITTED before counting/inserting tickets. It limits outstanding tickets to ten per user and clears the owner's expired tickets.
6. Existing bearer-authenticated GET clients and the four workbook sheets remain supported. Non-admin users without a fleet fail closed; invalid date/filter inputs are rejected.
7. Both endpoints set no-store, no-referrer, nosniff, and exact-origin error CORS headers. No wildcard or null origin allowance was added.
8. The page has English/Thai progress, requested-download, session-expiry, network-error, and date-validation messages. It reports that a download was requested, not that a navigated transfer completed.
9. The host adds a generated request ID and bounded export diagnostics: credential presence, proxy-return marker, and origin classification. It never adds credentials, complete URLs, filter values, or identity data to those logs.

The schema addition is `sql/024-export-download-tickets.sql`. It was applied and reapplied only in the isolated fixture database. No environment files, database targets, dependencies, lockfiles, deployment configuration, or release packages were changed.

## Verification

| Check | Result |
| --- | --- |
| `npm test` | 251 passed, 4 skipped, 0 failed; 255 total |
| `npm run typecheck` | passed |
| `npm run build` in `web` | TypeScript and Vite production build passed |
| `node host/build.cjs` | built server with 38 API routes |
| Focused host adapter/proxy/diagnostics suites | 18 passed, 0 failed; overlaps seven tests in the full suite |
| `git diff --check` | passed |
| Isolated SQL/browser harness | 19 checks passed |
| Tested source hashes | all eight recorded source hashes match final implementation |
| Review patch | applies cleanly to the frozen base; all 15 reconstructed implementation files match their recorded SHA-256 hashes |

The four existing skips concern absent private seed fixtures. The first full-suite attempt encountered the environment's subprocess restriction (`spawnSync EPERM`); a normal subprocess-enabled execution passed without changing tests.

Browser environment: Chromium 156.0.8078.47; `http://localhost:4173/dashboard/export`; desktop 1280 × 900 and mobile 390 × 844. Browser plugin unavailable, so regular Playwright was used with an isolated Google Chrome-for-Testing executable. No application dependency was added. Page identity, meaningful rendering, absence of framework overlays, console health, screenshots, and the export interaction were checked. The successful flow had no page errors or unexpected console errors. Deliberately failing CORS/401 cases produced the expected errors.

The new navigation completed the simulated redirect and downloaded an 11,847-byte valid XLSX containing Summary, By Fleet, Inspections, and Checklist Detail. It contained the selected synthetic company/fleet/date data and excluded another tenant, another fleet, and an older inspection. Invalid/tampered/expired/replayed tickets, method handling, immutable scope, and cross-token rejection were exercised.

A deliberate report-query failure after redemption returned a generic 500 with a code-only log; retrying that ticket returned 410. Restoring the fixture and creating a fresh ticket produced a valid workbook.

The database harness uses PGlite with a single connection. Concurrent calls resulted in one success and one 410 against the real SQL, but this is not a multi-session PostgreSQL contention test. The atomic-delete design and owner lock were separately reviewed by inspection.

## Independent review

An independent Codex lane found no unresolved blocking authentication, tenant-isolation, purpose-separation, or replay flaw. It found and resolved reliance on the default database isolation level for the outstanding-ticket cap. It also requested the generation-failure-after-redemption check, which subsequently passed.

This is additional review evidence only. `WORKSPACE.md` calls for the opposite provider (Claude) to review substantive Codex implementation. No callable Claude reviewer or CLI was available. After this limitation was disclosed, the user explicitly directed: "draft pr merge to main". The root is proceeding with that user-directed publication/merge and normal GitHub checks; this record does not claim Claude review occurred. Any implementation change invalidates the review and affected verification.

## Remaining limits and next owner

- Workbook generation still occurs synchronously in the navigated GET. A background worker/job pipeline is not implemented. The 401/CORS evidence does not itself establish a proxy timeout.
- The initial authenticated ticket POST can still be intercepted. That case was reproduced and displays an actionable error. DHL policy acceptance remains necessary.
- A consumed ticket cannot resume or retry a failed generation/transfer; the user requests a fresh export.
- Browser evidence uses a local redirect fixture, not real Zscaler or the DHL network. Other browser engines and multi-session PostgreSQL contention remain untested.
- Actual custom-host logs are still required to confirm the historical DHL event.
- Next owner: active root for the user-authorized PR/merge, then the release operator with an explicitly approved and verified database/deployment target. See `rollout.md`.
