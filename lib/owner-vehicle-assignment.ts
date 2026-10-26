import type { NeonQueryFunction } from '@neondatabase/serverless';

type AssignmentDatabase = Pick<NeonQueryFunction<false, false>, 'query' | 'transaction'>;

export const ADMIN_USER_ROLES = ['driver', 'supervisor', 'admin', 'vehicle_owner'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class OwnerVehicleAssignmentError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'OwnerVehicleAssignmentError';
  }
}

/** An explicit empty list removes all grants. Missing selections are handled by callers. */
export function normalizeVehicleIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !UUID.test(id))) {
    throw new OwnerVehicleAssignmentError(400, 'vehicleIds must be an array of vehicle UUIDs');
  }
  return [...new Set((value as string[]).map((id) => id.toLowerCase()))];
}

type CreateAccount = {
  username: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  role: string;
  fleetId?: string;
  vehicleIds?: unknown;
};

type UpdateAccount = {
  firstName?: string;
  lastName?: string;
  role?: string;
  fleetId?: string;
  passwordHash?: string;
  vehicleIds?: unknown;
};

/** Validation and insertion share a statement: invalid vehicles cannot leave a new account behind. */
export async function createAccountWithVehicles(sql: AssignmentDatabase, companyId: string, input: CreateAccount) {
  const vehicleIds = input.vehicleIds === undefined ? [] : normalizeVehicleIds(input.vehicleIds);
  if (input.vehicleIds !== undefined && input.role !== 'vehicle_owner') {
    throw new OwnerVehicleAssignmentError(400, 'Vehicle selections require the vehicle owner role');
  }
  const rows = await sql.query(`WITH selected_vehicles AS MATERIALIZED (
      SELECT id FROM vehicle_master
      WHERE company_id = $1::uuid AND id = ANY($8::uuid[])
      FOR KEY SHARE
    ), created_user AS (
      INSERT INTO users (company_id, username, password_hash, first_name, last_name, role, fleet_id)
      SELECT $1::uuid, $2, $3, $4, $5, $6, $7
      WHERE (SELECT COUNT(*) FROM selected_vehicles) = cardinality($8::uuid[])
      RETURNING id, username, first_name, last_name, role, fleet_id
    ), granted AS (
      INSERT INTO user_vehicle_access (company_id, user_id, vehicle_id)
      SELECT $1::uuid, u.id, v.id FROM created_user u CROSS JOIN selected_vehicles v
      WHERE u.role = 'vehicle_owner'
      RETURNING vehicle_id
    )
    SELECT id, username, first_name, last_name, role, fleet_id FROM created_user`,
  [companyId, input.username, input.passwordHash, input.firstName, input.lastName,
    input.role, input.role === 'vehicle_owner' ? '' : input.fleetId || '', vehicleIds]);
  if (!rows.length) {
    throw new OwnerVehicleAssignmentError(400, 'One or more selected vehicles are unavailable in this company');
  }
  return rows[0];
}

/**
 * Lock the account before the mutation statement obtains its READ COMMITTED snapshot.
 * Parallel edits replace the complete selection instead of accidentally combining grants.
 * No vehicle or fleet row is updated by this operation.
 */
export async function updateAccountWithVehicles(
  sql: AssignmentDatabase, companyId: string, userId: string, input: UpdateAccount,
) {
  const hasSelection = input.vehicleIds !== undefined;
  const vehicleIds = hasSelection ? normalizeVehicleIds(input.vehicleIds) : [];
  const [existing, updated] = await sql.transaction([
    sql.query('SELECT id, role, last_name FROM users WHERE id = $1::uuid AND company_id = $2::uuid FOR UPDATE',
      [userId, companyId]),
    sql.query(`WITH selected_vehicles AS MATERIALIZED (
        SELECT id FROM vehicle_master
        WHERE company_id = $1::uuid AND id = ANY($9::uuid[])
        FOR KEY SHARE
      ), updated_user AS (
        UPDATE users u SET
          first_name = COALESCE($3::text, u.first_name),
          last_name = COALESCE($4::text, u.last_name),
          role = COALESCE($5::text, u.role),
          fleet_id = CASE WHEN COALESCE($5::text, u.role) = 'vehicle_owner' THEN '' ELSE COALESCE($6::text, u.fleet_id) END,
          password_hash = COALESCE($7::text, u.password_hash),
          updated_at = NOW()
        WHERE u.id = $2::uuid AND u.company_id = $1::uuid
          AND ($5::text IS NULL OR $5::text = 'vehicle_owner'
            OR length(btrim(COALESCE($4::text, u.last_name))) > 0)
          AND (NOT $8::boolean OR (
            COALESCE($5::text, u.role) = 'vehicle_owner'
            AND (SELECT COUNT(*) FROM selected_vehicles) = cardinality($9::uuid[])
          ))
        RETURNING u.id, u.username, u.first_name, u.last_name, u.role, u.fleet_id
      ), removed AS (
        DELETE FROM user_vehicle_access a USING updated_user u
        WHERE a.company_id = $1::uuid AND a.user_id = u.id
          AND (u.role <> 'vehicle_owner' OR ($8::boolean AND NOT (a.vehicle_id = ANY($9::uuid[]))))
        RETURNING a.vehicle_id
      ), granted AS (
        INSERT INTO user_vehicle_access (company_id, user_id, vehicle_id)
        SELECT $1::uuid, u.id, v.id FROM updated_user u CROSS JOIN selected_vehicles v
        WHERE u.role = 'vehicle_owner' AND $8::boolean
        ON CONFLICT DO NOTHING
        RETURNING vehicle_id
      )
      SELECT id, username, first_name, last_name, role, fleet_id FROM updated_user`,
    [companyId, userId, input.firstName ?? null, input.lastName ?? null, input.role ?? null,
      input.fleetId ?? null, input.passwordHash ?? null, hasSelection, vehicleIds]),
  ], { isolationLevel: 'ReadCommitted' });
  if (!existing.length) throw new OwnerVehicleAssignmentError(404, 'User not found');
  if (hasSelection && (input.role ?? existing[0].role) !== 'vehicle_owner') {
    throw new OwnerVehicleAssignmentError(400, 'Vehicle selections require the vehicle owner role');
  }
  if (!updated.length) {
    if (input.role && input.role !== 'vehicle_owner' && !(input.lastName ?? existing[0].last_name ?? '').trim()) {
      throw new OwnerVehicleAssignmentError(400, 'Last name is required for this role');
    }
    throw new OwnerVehicleAssignmentError(400, 'One or more selected vehicles are unavailable in this company');
  }
  return updated[0];
}

/** Return the full catalog, including inactive vehicles, so an edit cannot drop hidden selections. */
export async function getOwnerVehicleSelection(sql: AssignmentDatabase, companyId: string, userId: string) {
  // One statement keeps the catalog and selection in one snapshot on both the
  // Neon adapter and the Windows host's transaction/savepoint adapter.
  const users = await sql.query(`SELECT u.id, u.role,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', v.id, 'plate_number', v.plate_number, 'fleet_id', v.fleet_id,
        'vehicle_type', v.vehicle_type, 'is_active', v.is_active
      ) ORDER BY v.fleet_id, v.plate_number, v.id)
      FROM vehicle_master v WHERE v.company_id = $1::uuid), '[]'::jsonb) AS vehicles,
      ARRAY(SELECT a.vehicle_id::text FROM user_vehicle_access a
        WHERE a.company_id = $1::uuid AND a.user_id = u.id AND u.role = 'vehicle_owner'
        ORDER BY a.vehicle_id) AS selected_vehicle_ids
    FROM users u WHERE u.id = $2::uuid AND u.company_id = $1::uuid`, [companyId, userId]);
  if (!users.length) throw new OwnerVehicleAssignmentError(404, 'User not found');
  if (users[0].role !== 'vehicle_owner') {
    throw new OwnerVehicleAssignmentError(400, 'Vehicle selections require the vehicle owner role');
  }
  return { vehicles: users[0].vehicles, selectedVehicleIds: users[0].selected_vehicle_ids as string[] };
}
