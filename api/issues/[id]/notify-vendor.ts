import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import { verifyAuth } from '../../../lib/api-auth';
import { sendVendorNotifyEmail } from '../../../lib/email';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (user.role !== 'admin' && user.role !== 'supervisor') return res.status(403).json({ error: 'Forbidden' });

  const { id } = req.query;
  const sql = neon(process.env.DATABASE_URL!);

  try {
    const [row] = await sql`
      SELECT ir.id, ir.fleet_id, ir.defect_photo_urls, ir.vendor_notified_at,
             ir.created_at,
             vm.plate_number, vm.vehicle_type, vm.vendor_email
      FROM issue_reports ir
      JOIN vehicle_master vm ON vm.id = ir.vehicle_id
      WHERE ir.id = ${id as string}
        AND ir.company_id = ${user.companyId}
        AND (${user.role}::text = 'admin' OR ir.fleet_id = ${user.fleetId || ''})
    `;

    if (!row) return res.status(404).json({ error: 'Issue not found' });
    if (!row.vendor_email) return res.status(422).json({ error: 'No vendor email set for this vehicle' });

    const reportedAt = new Date(row.created_at).toLocaleDateString('th-TH', {
      timeZone: 'Asia/Bangkok', year: 'numeric', month: 'long', day: 'numeric',
    });

    await sendVendorNotifyEmail({
      to: row.vendor_email,
      plateNumber: row.plate_number,
      vehicleType: row.vehicle_type,
      fleetId: row.fleet_id,
      reportedAt,
      defectPhotoUrls: row.defect_photo_urls || [],
    });

    const [updated] = await sql`
      UPDATE issue_reports SET vendor_notified_at = NOW()
      WHERE id = ${id as string} AND company_id = ${user.companyId}
      RETURNING vendor_notified_at
    `;

    return res.status(200).json({
      notifiedAt: updated.vendor_notified_at,
      vendorEmail: row.vendor_email,
    });
  } catch (error: any) {
    console.error('[API] notify-vendor error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
