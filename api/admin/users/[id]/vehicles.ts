import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import { requireAdmin } from '../../../../lib/admin-auth';
import { isUUID } from '../../../../lib/validate';
import {
  getOwnerVehicleSelection,
  normalizeVehicleIds,
  OwnerVehicleAssignmentError,
  updateAccountWithVehicles,
} from '../../../../lib/owner-vehicle-assignment';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  res.setHeader('Cache-Control', 'no-store');
  const { id } = req.query;
  if (!isUUID(id)) return res.status(400).json({ error: 'Valid user ID required' });
  if (req.method !== 'GET' && req.method !== 'PUT') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sql = neon(process.env.DATABASE_URL!);
    if (req.method === 'GET') {
      return res.status(200).json(await getOwnerVehicleSelection(sql, admin.companyId, id));
    }
    const vehicleIds = normalizeVehicleIds(req.body?.vehicleIds);
    await updateAccountWithVehicles(sql, admin.companyId, id, { vehicleIds });
    return res.status(200).json({ vehicleIds });
  } catch (error: any) {
    if (error instanceof OwnerVehicleAssignmentError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('[API] Vehicle assignment error:', error.code || 'UNKNOWN');
    return res.status(500).json({ error: 'Unable to save vehicle assignments' });
  }
}
