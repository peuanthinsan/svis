import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import { getOwnerVehicleIds } from '../lib/vehicle-access';
import { verifyAuth } from '../lib/api-auth';
import { getTodayThai, getMondayOfWeekThai } from '../lib/thai-date';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await verifyAuth(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const sql = neon(process.env.DATABASE_URL!);
    const today = getTodayThai();
    const monday = getMondayOfWeekThai();
    const { id, search } = req.query;
    // Drivers and supervisors stay in their fleet. Owners span fleets only
    // through the explicit vehicle allowlist applied to every query below.
    const isAdmin = user.role === 'admin';
    const isOwner = user.role === 'vehicle_owner';
    const fleetId = (isAdmin || isOwner) ? (req.query.fleetId as string | undefined) : (user.fleetId || undefined);
    if (!isAdmin && !isOwner && !fleetId) return res.status(403).json({ error: 'Forbidden' });

    const ownerVehicleIds = await getOwnerVehicleIds(sql, user);

    // Single vehicle by ID
    if (id && typeof id === 'string') {
      const result = await sql`
        SELECT
          v.id, v.plate_number, v.vehicle_type, v.fleet_id, v.is_active,
          d.overall_status as daily_result,
          d.inspector_name as daily_checked_by,
          CASE WHEN d.id IS NOT NULL THEN 'checked' ELSE 'pending' END as daily_status,
          CASE WHEN EXISTS (SELECT 1 FROM inspection_logs WHERE vehicle_id = v.id AND company_id = ${user.companyId} AND inspection_date >= ${monday} AND inspection_date <= ${today} AND frequency = 'weekly') THEN 'checked' ELSE 'pending' END as weekly_status
        FROM vehicle_master v
        LEFT JOIN LATERAL (SELECT id, overall_status, inspector_name FROM inspection_logs WHERE vehicle_id = v.id AND company_id = ${user.companyId} AND inspection_date = ${today} AND frequency = 'daily' LIMIT 1) d ON true
        WHERE v.id = ${id} AND v.company_id = ${user.companyId}
          AND (${ownerVehicleIds}::uuid[] IS NULL OR v.id = ANY(${ownerVehicleIds}::uuid[]))
      `;
      if (result.length === 0) return res.status(404).json({ error: 'Vehicle not found' });
      const v = result[0];
      // Non-admins may only read a vehicle in their own fleet (404, not 403, to avoid leaking existence).
      if (!isAdmin && !isOwner && v.fleet_id !== user.fleetId) {
        return res.status(404).json({ error: 'Vehicle not found' });
      }
      return res.status(200).json({
        ...v,
        today_status: v.daily_status,
        overall_status: v.daily_result,
        checked_by: v.daily_checked_by,
      });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
    const q = search ? `%${search as string}%` : undefined;

    let countResultPromise: PromiseLike<any[]>;
    if (fleetId && q) {
      countResultPromise = sql`SELECT COUNT(*)::int as total FROM vehicle_master WHERE company_id = ${user.companyId} AND (${ownerVehicleIds}::uuid[] IS NULL OR id = ANY(${ownerVehicleIds}::uuid[])) AND (${isOwner}::boolean OR is_active) AND fleet_id = ${fleetId as string} AND plate_number ILIKE ${q}`;
    } else if (fleetId) {
      countResultPromise = sql`SELECT COUNT(*)::int as total FROM vehicle_master WHERE company_id = ${user.companyId} AND (${ownerVehicleIds}::uuid[] IS NULL OR id = ANY(${ownerVehicleIds}::uuid[])) AND (${isOwner}::boolean OR is_active) AND fleet_id = ${fleetId as string}`;
    } else if (q) {
      countResultPromise = sql`SELECT COUNT(*)::int as total FROM vehicle_master WHERE company_id = ${user.companyId} AND (${ownerVehicleIds}::uuid[] IS NULL OR id = ANY(${ownerVehicleIds}::uuid[])) AND (${isOwner}::boolean OR is_active) AND plate_number ILIKE ${q}`;
    } else {
      countResultPromise = sql`SELECT COUNT(*)::int as total FROM vehicle_master WHERE company_id = ${user.companyId} AND (${ownerVehicleIds}::uuid[] IS NULL OR id = ANY(${ownerVehicleIds}::uuid[])) AND (${isOwner}::boolean OR is_active)`;
    }

    // The owner inventory is the full explicit assignment list, including
    // inactive vehicles. Operational roles retain their active-only lists.
    // Use LATERAL + EXISTS to guarantee exactly one row per vehicle
    let vehiclesPromise: PromiseLike<any[]>;
    if (fleetId && q) {
      vehiclesPromise = sql`
        SELECT v.id, v.plate_number, v.vehicle_type, v.fleet_id, v.is_active,
          CASE WHEN d.id IS NOT NULL THEN 'checked' ELSE 'pending' END as daily_status,
          d.overall_status as daily_result, d.inspector_name as daily_checked_by,
          CASE WHEN EXISTS (SELECT 1 FROM inspection_logs WHERE vehicle_id = v.id AND company_id = ${user.companyId} AND inspection_date >= ${monday} AND inspection_date <= ${today} AND frequency = 'weekly') THEN 'checked' ELSE 'pending' END as weekly_status
        FROM vehicle_master v
        LEFT JOIN LATERAL (SELECT id, overall_status, inspector_name FROM inspection_logs WHERE vehicle_id = v.id AND company_id = ${user.companyId} AND inspection_date = ${today} AND frequency = 'daily' LIMIT 1) d ON true
        WHERE v.company_id = ${user.companyId} AND (${ownerVehicleIds}::uuid[] IS NULL OR v.id = ANY(${ownerVehicleIds}::uuid[])) AND (${isOwner}::boolean OR v.is_active) AND v.fleet_id = ${fleetId as string} AND v.plate_number ILIKE ${q}
        ORDER BY v.plate_number LIMIT ${limit} OFFSET ${offset}`;
    } else if (fleetId) {
      vehiclesPromise = sql`
        SELECT v.id, v.plate_number, v.vehicle_type, v.fleet_id, v.is_active,
          CASE WHEN d.id IS NOT NULL THEN 'checked' ELSE 'pending' END as daily_status,
          d.overall_status as daily_result, d.inspector_name as daily_checked_by,
          CASE WHEN EXISTS (SELECT 1 FROM inspection_logs WHERE vehicle_id = v.id AND company_id = ${user.companyId} AND inspection_date >= ${monday} AND inspection_date <= ${today} AND frequency = 'weekly') THEN 'checked' ELSE 'pending' END as weekly_status
        FROM vehicle_master v
        LEFT JOIN LATERAL (SELECT id, overall_status, inspector_name FROM inspection_logs WHERE vehicle_id = v.id AND company_id = ${user.companyId} AND inspection_date = ${today} AND frequency = 'daily' LIMIT 1) d ON true
        WHERE v.company_id = ${user.companyId} AND (${ownerVehicleIds}::uuid[] IS NULL OR v.id = ANY(${ownerVehicleIds}::uuid[])) AND (${isOwner}::boolean OR v.is_active) AND v.fleet_id = ${fleetId as string}
        ORDER BY v.plate_number LIMIT ${limit} OFFSET ${offset}`;
    } else if (q) {
      vehiclesPromise = sql`
        SELECT v.id, v.plate_number, v.vehicle_type, v.fleet_id, v.is_active,
          CASE WHEN d.id IS NOT NULL THEN 'checked' ELSE 'pending' END as daily_status,
          d.overall_status as daily_result, d.inspector_name as daily_checked_by,
          CASE WHEN EXISTS (SELECT 1 FROM inspection_logs WHERE vehicle_id = v.id AND company_id = ${user.companyId} AND inspection_date >= ${monday} AND inspection_date <= ${today} AND frequency = 'weekly') THEN 'checked' ELSE 'pending' END as weekly_status
        FROM vehicle_master v
        LEFT JOIN LATERAL (SELECT id, overall_status, inspector_name FROM inspection_logs WHERE vehicle_id = v.id AND company_id = ${user.companyId} AND inspection_date = ${today} AND frequency = 'daily' LIMIT 1) d ON true
        WHERE v.company_id = ${user.companyId} AND (${ownerVehicleIds}::uuid[] IS NULL OR v.id = ANY(${ownerVehicleIds}::uuid[])) AND (${isOwner}::boolean OR v.is_active) AND v.plate_number ILIKE ${q}
        ORDER BY v.fleet_id, v.plate_number LIMIT ${limit} OFFSET ${offset}`;
    } else {
      vehiclesPromise = sql`
        SELECT v.id, v.plate_number, v.vehicle_type, v.fleet_id, v.is_active,
          CASE WHEN d.id IS NOT NULL THEN 'checked' ELSE 'pending' END as daily_status,
          d.overall_status as daily_result, d.inspector_name as daily_checked_by,
          CASE WHEN EXISTS (SELECT 1 FROM inspection_logs WHERE vehicle_id = v.id AND company_id = ${user.companyId} AND inspection_date >= ${monday} AND inspection_date <= ${today} AND frequency = 'weekly') THEN 'checked' ELSE 'pending' END as weekly_status
        FROM vehicle_master v
        LEFT JOIN LATERAL (SELECT id, overall_status, inspector_name FROM inspection_logs WHERE vehicle_id = v.id AND company_id = ${user.companyId} AND inspection_date = ${today} AND frequency = 'daily' LIMIT 1) d ON true
        WHERE v.company_id = ${user.companyId} AND (${ownerVehicleIds}::uuid[] IS NULL OR v.id = ANY(${ownerVehicleIds}::uuid[])) AND (${isOwner}::boolean OR v.is_active)
        ORDER BY v.fleet_id, v.plate_number LIMIT ${limit} OFFSET ${offset}`;
    }

    const [countResult, vehicles] = await Promise.all([
      countResultPromise,
      vehiclesPromise,
    ]);

    const mapped = vehicles.map((v: any) => ({
      ...v,
      today_status: v.daily_status,
      overall_status: v.daily_result,
      checked_by: v.daily_checked_by,
    }));

    res.status(200).json({ vehicles: mapped, total: countResult[0].total, limit, offset });
  } catch (error: any) {
    console.error('[API] Error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}
