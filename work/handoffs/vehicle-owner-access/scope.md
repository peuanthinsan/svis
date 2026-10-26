# Vehicle-owner access

Objective: add a read-only `vehicle_owner` role beside `admin`, `supervisor`, and `driver`, with administrator-managed per-vehicle access across existing fleets. Fleet membership must never be changed by owner assignment. Customer source data stays outside this public repository.

Base: `190e4ba92eb2538f8e6fc883d92a5374955b4637` (`main`). Working branch: `feat/vehicle-owner-access`.

Root: Codex; model GPT-6 Astra Pro; effort UNKNOWN; phase implementation. Root owns integration, shared authentication and role types, migrations, export download tickets/report, mobile role gating, verification and git. Delegated lanes do not commit, push, merge, deploy, or write a database.

Lane assignments:

- Read scope: `api/vehicles.ts`, `api/dashboard.ts`, `api/history.ts`, `api/inspections.ts`, `api/inspections/[id].ts`, `api/issues.ts`, `api/issues/[id].ts`, `api/issues/[id]/notify-vendor.ts`, `api/issues/export.ts`, `api/issues/import.ts`, `api/maintenance.ts`, `api/unit-status.ts`, `api/upload.ts`, `lib/vehicle-access.ts`, new `tests/vehicle-owner-read-access.test.mjs`.
- Account management: `api/admin/users/index.ts`, `api/admin/users/[id].ts`, `api/admin/users/import.ts`, `api/admin/users/export.ts`, new `api/admin/users/[id]/vehicles.ts`, new `lib/owner-vehicle-assignment.ts`, new `tests/owner-vehicle-assignment.test.mjs`.
- Dashboard UI: `web/src/**`, new `tests/vehicle-owner-ui.test.mjs`. Existing unrelated tests belong to root.
- Account lane extension after its first receipt: `app/(app)/admin/users.tsx`, new `tests/vehicle-owner-mobile-admin.test.mjs`; root retains shared mobile i18n.
- Read-scope lane extension after its first receipt: independent temporary PGlite verification of the migration and account helper, with read-only review of those sources.

Contract: membership table `user_vehicle_access(company_id UUID, user_id UUID, vehicle_id UUID, created_at TIMESTAMPTZ)`; unique membership per user/vehicle/company and same-company foreign keys. Shared helper `getOwnerVehicleIds(sql, user): Promise<string[] | null>` returns null for non-owner, the current assigned UUID list for owner (including empty array, which grants zero vehicles). Every owner data query must apply the allowlist in SQL before totals/pagination; optional fleet filters only narrow it. Owners cannot mutate vehicle, inspection, issue, maintenance or upload data. Admin routes remain admin-only.

Admin endpoint contract: GET `/api/admin/users/:id/vehicles` returns `{ vehicles, selectedVehicleIds }` where each vehicle has `id`, `plate_number`, `fleet_id`, `vehicle_type`; PUT accepts `{ vehicleIds: string[] }`, atomically validates same-company IDs, replaces membership, returns `{ vehicleIds }`. It operates on vehicle-owner accounts only. The UI may page catalog separately if needed, but cannot silently truncate. Owner account create/update accepts optional `vehicleIds` and performs account and assignments atomically. No owner fleet assignment is required. Existing user import/export recognizes `vehicle_owner`.

Acceptance: exact per-user vehicle visibility across fleets; no fleet movement; no company crossing; empty selections grant none; assignment removal affects next reads and outstanding export downloads; owner write requests denied; editable searchable checkbox list with visible selected count and bulk plate-list matching; old roles and export proxy flow preserved; meaningful authorization, typecheck and build validation.

Required opposite-provider review: WORKSPACE.md requests Claude review of Codex implementation. Claude CLI and tools are unavailable in this session; record independent Codex review as fallback, never claim it satisfies the opposite-provider gate. No publication or production change in this phase.
