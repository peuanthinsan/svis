import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import { getOwnerVehicleIds } from '../../lib/vehicle-access';
import { verifyAuth } from '../../lib/api-auth';
import { logAudit } from '../../lib/audit';

const VALID_STATUSES = ['open', 'in_progress', 'completed'];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = await verifyAuth(req);
  if (!user) {
    console.warn('[API] Unauthenticated request to', req.url);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (user.role === 'vehicle_owner' && req.method !== 'GET') {
    return res.status(403).json({ error: 'Vehicle owners have read-only access' });
  }

  const { id } = req.query;
  const sql = neon(process.env.DATABASE_URL!);

  if (req.method === 'GET') {
    try {
      const ownerVehicleIds = await getOwnerVehicleIds(sql, user);
      const [issue] = await sql`
        SELECT ir.*, vm.plate_number, vm.vehicle_type, vm.fleet_id as vehicle_fleet,
          il.inspector_name, il.inspection_date
        FROM issue_reports ir
        JOIN vehicle_master vm ON vm.id = ir.vehicle_id
        LEFT JOIN inspection_logs il ON il.id = ir.inspection_id AND il.company_id = ir.company_id AND il.vehicle_id = ir.vehicle_id
        WHERE ir.id = ${id as string} AND ir.company_id = ${user.companyId}
          AND vm.company_id = ${user.companyId}
          AND (${ownerVehicleIds}::uuid[] IS NULL OR vm.id = ANY(${ownerVehicleIds}::uuid[]))
      `;
      if (!issue) return res.status(404).json({ error: 'Issue not found' });
      // Fleet scope is enforced here, not by RLS: a non-admin may only read an
      // issue for a vehicle in their own fleet (404, not 403, to avoid leaking existence).
      if (user.role !== 'admin' && user.role !== 'vehicle_owner' && issue.vehicle_fleet !== user.fleetId) {
        return res.status(404).json({ error: 'Issue not found' });
      }
      const failedPhotos = await sql`
        SELECT ARRAY_AGG(photo_url) AS defect_photo_urls
        FROM inspection_results ir
        JOIN inspection_logs inspection ON inspection.id = ir.inspection_id
          AND inspection.company_id = ${user.companyId}
        CROSS JOIN LATERAL unnest(ir.photo_urls) AS photo_url
        WHERE ir.inspection_id = ${issue.inspection_id}::uuid
          AND (${ownerVehicleIds}::uuid[] IS NULL OR inspection.vehicle_id = ANY(${ownerVehicleIds}::uuid[]))
          AND ir.result = 'fail'
      `;
      if (failedPhotos[0]?.defect_photo_urls?.length) {
        issue.defect_photo_urls = failedPhotos[0].defect_photo_urls;
      }
      return res.status(200).json(issue);
    } catch (error: any) {
      console.error('[API] Error:', error.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });

  const { status, completionPhotoUrls, forceClose } = req.body;

  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  // Changing an issue's status is a supervisor/mechanic action — drivers may not close defects.
  if (user.role === 'driver') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Closing an issue requires proof-of-repair photos (business rule: repair closure needs evidence).
  const isAuthorizedForceClose = forceClose === true && user.role === 'admin';
  if (status === 'completed' && !isAuthorizedForceClose && (!Array.isArray(completionPhotoUrls) || completionPhotoUrls.length === 0)) {
    return res.status(400).json({ error: 'Completion photo required to close an issue' });
  }

  try {
    // Validate status transition + enforce fleet ownership (RLS is inert on this connection).
    const [issue] = await sql`
      SELECT ir.status, vm.fleet_id AS vehicle_fleet
      FROM issue_reports ir
      JOIN vehicle_master vm ON vm.id = ir.vehicle_id
      WHERE ir.id = ${id as string} AND ir.company_id = ${user.companyId}`;
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    if (user.role !== 'admin' && issue.vehicle_fleet !== user.fleetId) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    if (completionPhotoUrls) {
      await sql`
        UPDATE issue_reports
        SET status = ${status}, completion_photo_urls = ${completionPhotoUrls}::text[], updated_at = NOW()
        WHERE id = ${id as string} AND company_id = ${user.companyId}
      `;
    } else {
      await sql`
        UPDATE issue_reports
        SET status = ${status}, updated_at = NOW()
        WHERE id = ${id as string} AND company_id = ${user.companyId}
      `;
    }

    await logAudit({
      userId: user.userId,
      username: user.username || 'system',
      action: 'issue_status_changed',
      entityType: 'issue',
      entityId: id as string,
      details: { oldStatus: issue.status, newStatus: status, forceClose: isAuthorizedForceClose },
    });

    res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('[API] Error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}
