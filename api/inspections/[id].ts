import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import { getOwnerVehicleIds } from '../../lib/vehicle-access';
import { verifyAuth } from '../../lib/api-auth';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.query;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id required' });

  const sql = neon(process.env.DATABASE_URL!);

  try {
    const ownerVehicleIds = await getOwnerVehicleIds(sql, user);
    const [log] = await sql`
      SELECT il.*, vm.plate_number, vm.vehicle_type, vm.fleet_id as vehicle_fleet
      FROM inspection_logs il
      JOIN vehicle_master vm ON vm.id = il.vehicle_id
      WHERE il.id = ${id} AND il.company_id = ${user.companyId}
        AND vm.company_id = ${user.companyId}
        AND (${ownerVehicleIds}::uuid[] IS NULL OR vm.id = ANY(${ownerVehicleIds}::uuid[]))
    `;
    if (!log) return res.status(404).json({ error: 'Inspection not found' });

    // Fleet scope is enforced here, not by RLS (the DATABASE_URL role bypasses it):
    // a non-admin may only read an inspection for a vehicle in their own fleet.
    // 404 (not 403) so cross-fleet existence isn't confirmed.
    if (user.role !== 'admin' && user.role !== 'vehicle_owner' && log.vehicle_fleet !== user.fleetId) {
      return res.status(404).json({ error: 'Inspection not found' });
    }

    const results = await sql`
      SELECT ir.id, ir.result, ir.photo_urls, ir.notes,
        ci.item_name_th, ci.item_name_en, ci.vehicle_type as item_vehicle_type, ci.frequency
      FROM inspection_results ir
      JOIN checklist_items ci ON ci.id = ir.checklist_item_id
      WHERE ir.inspection_id = ${id} AND ci.company_id = ${user.companyId}
      ORDER BY ci.sort_order
    `;

    return res.status(200).json({ ...log, results });
  } catch (error: any) {
    console.error('[inspections/[id]]', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
