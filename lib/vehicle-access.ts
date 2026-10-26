import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { AuthUser } from './api-auth';

/**
 * null preserves fleet-based access for the existing roles. An owner's empty
 * list deliberately grants nothing. Load for each request so an administrator's
 * changes take effect without asking the owner to sign in again.
 */
export async function getOwnerVehicleIds(
  sql: NeonQueryFunction<false, false>, user: AuthUser,
): Promise<string[] | null> {
  if (user.role !== 'vehicle_owner') return null;
  const rows = await sql`
    SELECT access.vehicle_id
    FROM user_vehicle_access access
    JOIN vehicle_master vehicle ON vehicle.id = access.vehicle_id
      AND vehicle.company_id = access.company_id
    WHERE access.user_id = ${user.userId}
      AND access.company_id = ${user.companyId}
    ORDER BY access.vehicle_id
  `;
  return rows.map((row) => row.vehicle_id as string);
}
