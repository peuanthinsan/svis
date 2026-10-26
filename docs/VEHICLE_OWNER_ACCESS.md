# Vehicle-owner accounts

`vehicle_owner` is a read-only customer role alongside `admin`, `supervisor`, and `driver`. Its access is the administrator's explicit selection of vehicle IDs inside the user's company. Selecting a vehicle never changes its operational fleet. Several owners can be granted the same vehicle, and one owner can see selected vehicles across several fleets.

## Permissions

| Role | Vehicle scope | Changes |
| --- | --- | --- |
| Admin | All vehicles in their company | Existing administration and inspection permissions |
| Supervisor | Their assigned fleet | Existing inspection, issue, and maintenance permissions |
| Driver | Their assigned fleet | Existing driver inspection permissions |
| Vehicle Owner | Explicitly selected vehicles in their company | Own profile/password only; vehicle information, history, issues, maintenance data and reports are read-only |

An empty checklist grants no vehicle access. Fleet query parameters can narrow an owner's selection but cannot add vehicles. The owner's inventory includes every selected vehicle, including inactive vehicles with a status label. Existing operational-role inventory lists keep their active-only behavior.

## Database and deployment order

1. Identify the running service/release, active company and actual serving database using the existing hosting configuration. Do not assume a local `.env.local` is the production target. Migration 024 (export tickets) and earlier migrations are prerequisites.
2. Review `sql/025-vehicle-owner-access.sql`. It adds the role, same-company user/vehicle grants and a nullable vehicle snapshot for report links. It does not create customer accounts or change fleets.
3. From a source checkout with the **verified** database target already configured, run `npm run migrate:025 -- --dry-run`. This prints the target and migration statement count without opening a database connection. Use the approved database change procedure before running `npm run migrate:025 -- --confirm`.
4. Deploy the API and dashboard from the same reviewed revision. The Windows host bundle discovers `/api/admin/users/:id/vehicles` automatically. Rebuild with the established hosting process; preserve the service configuration and existing DHL report-download flow.
5. Verify login, scoped views, account creation and reassignment in the serving environment before handing credentials to customers. Keep the previous release available for rollback. If reverting application code, disable new owner accounts first; leave the additive access table for a reviewed follow-up rather than dropping it blindly.

The migration runner supports the same Neon/loopback PostgreSQL targets as the Windows adapter. It never loads, prints or saves customer passwords. Migration and deployment are separate operations; a branch or build does not activate the feature.

## Create and maintain an owner

In the web dashboard, open **Admin → Users → Add User**, select **Vehicle Owner**, enter a unique username, customer name and secure password, then select vehicles. Existing owners have the same checklist under **Edit**. Mobile administrators can also search and edit the checkbox list.

For a workbook with one customer per column, open **Use a plate list**, choose the file and the intended customer column, review the match count, then add or replace the selection. Matching normalizes surrounding whitespace and letter case only. Unmatched and ambiguous plates prevent bulk application. No vehicle is created, moved, renamed or guessed from an unmatched plate. Check that the selected count equals the source customer's distinct plate count before saving.

Account changes and the supplied selection save together. Closing the form without saving changes nothing. A failed catalog load blocks saving an owner selection, preventing accidental removal of hidden grants. The catalog includes all pages and preserves selections when searching or filtering.

Use a separate account for each customer. Do not reuse a driver/supervisor account or assign a whole fleet to approximate ownership. If a customer needs multiple named logins, create separate owner accounts and explicitly select the vehicles for each.

## Authorization design

- `user_vehicle_access` has a composite primary key and same-company foreign keys to both users and vehicles. Owners cannot edit it.
- Every authenticated request resolves the account's current active role, fleet and company. Old JWT claims do not retain an administrator role after demotion or allow disabled accounts to keep using the API.
- Owner vehicle grants are fetched for each request and included in SQL before aggregate counts, pagination and individual-record results. Child inspection/issue data is fetched only after the parent is authorized.
- Export download links remain short lived, signed and single use. Owner links store the exact vehicle selection at issuance. Download-time validation intersects it with current grants, so removals revoke access and later additions cannot expand an existing owner link. Fleet-based tickets are also constrained by current account permissions.
- Owners cannot submit inspections, mutate issues or maintenance, send vendor emails, import records or upload evidence. Owner dashboard/unit-status reads do not record telematics activity as a side effect.
- Mobile owner views bypass the existing company/fleet offline vehicle cache, which cannot safely represent a revocable per-user selection.
- PostgreSQL row policies provide an additional boundary when using the scoped database client, which now also sets `app.user_id`. API guards remain required for connections that bypass RLS.

## Verification before release

Run the existing root tests and typecheck, dashboard build, and Windows hosting tests. Review the authorization tests for unrelated vehicles in the same fleet, assigned vehicles in different fleets, zero grants, multiple owners, company mismatches, revoked grants, direct record URLs, stale sessions and report downloads. Verify the rendered web checklist and owner Vehicles page with an empty history/GPS state. Test with synthetic accounts first, then reconcile the customer's source file against the live catalog.

Production account provisioning and customer plate data are intentionally not embedded in this public repository. The administrator applies the private source workbook after deployment.
