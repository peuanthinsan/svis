import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import { verifyAuth } from '../lib/api-auth';
import { getTodayThai, getMondayOfWeekThai } from '../lib/thai-date';
import { fetchSheetVehicles, recordVehicleActivity, type GpsStatus } from '../lib/unit-status-sheet';

type InspectionFlags = {
  preRoute: boolean;
  postRoute: boolean;
  weekly: boolean;
};

type UnitRow = {
  plateNumber: string;
  fleet: string;
  driverName: string;
  gpsStatus: GpsStatus;
  ignition: boolean;
  speed: number;
  lastFixTime: string;
  updatedAt: string;
  inspections: InspectionFlags;
  // Derived: GPS active but at least one due inspection (pre-route today,
  // post-route today, weekly this week) not yet submitted.
  needsAttention: boolean;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const sql = neon(process.env.DATABASE_URL!);
  const today = getTodayThai();
  const monday = getMondayOfWeekThai();

  // Admins may select one fleet; every other role is locked to its JWT fleet.
  // A missing non-admin fleet must fail closed rather than exposing company-wide data.
  const isAdmin = user.role === 'admin';
  const fleet: string | null = isAdmin ? ((req.query.fleetId as string) || null) : (user.fleetId || null);
  if (!isAdmin && !fleet) return res.status(403).json({ error: 'Forbidden' });

  try {
    // Fetch GPS data and inspection completion (per frequency) in parallel.
    const [sheetVehicles, fleetVehicles, dailyRows, weeklyRows] = await Promise.all([
      fetchSheetVehicles(sql, user.companyId, { companySlug: user.companySlug }),
      // Database fleet membership is authoritative. The sheet's Fleet column may be
      // stale or mislabeled, so it must not decide which vehicles a user can see.
      sql`
        SELECT plate_number, fleet_id
        FROM vehicle_master
        WHERE company_id = ${user.companyId}
          AND (${fleet}::text IS NULL OR fleet_id = ${fleet})
          AND is_active
      `,
      sql`
        SELECT DISTINCT v.plate_number, i.frequency
        FROM inspection_logs i
        JOIN vehicle_master v ON v.id = i.vehicle_id
        WHERE i.inspection_date = ${today}
          AND i.company_id = ${user.companyId}
          AND i.frequency IN ('daily', 'post_route')
          AND (${fleet}::text IS NULL OR v.fleet_id = ${fleet})
      `,
      sql`
        SELECT DISTINCT v.plate_number
        FROM inspection_logs i
        JOIN vehicle_master v ON v.id = i.vehicle_id
        WHERE i.frequency = 'weekly'
          AND i.company_id = ${user.companyId}
          AND i.inspection_date >= ${monday}
          AND i.inspection_date <= ${today}
          AND (${fleet}::text IS NULL OR v.fleet_id = ${fleet})
      `,
    ]);

    if (sheetVehicles === null) {
      return res.status(200).json({ configured: false, vehicles: [] });
    }

    // Remember which vehicles were GPS-online today (feeds the Active donut).
    // Awaited: a detached promise may be cut off when the serverless response ends.
    await recordVehicleActivity(sql, sheetVehicles, today, user.companyId).catch((err) =>
      console.warn('[unit-status] activity log upsert failed:', err.message),
    );

    const preRoutePlates = new Set(
      dailyRows.filter((r: any) => r.frequency === 'daily').map((r: any) => r.plate_number as string),
    );
    const postRoutePlates = new Set(
      dailyRows.filter((r: any) => r.frequency === 'post_route').map((r: any) => r.plate_number as string),
    );
    const weeklyPlates = new Set(weeklyRows.map((r: any) => r.plate_number as string));
    const fleetByPlate = new Map(
      fleetVehicles.map((v: any) => [v.plate_number as string, v.fleet_id as string]),
    );

    const scopedVehicles: UnitRow[] = sheetVehicles.flatMap((v) => {
      const vehicleFleet = fleetByPlate.get(v.plateNumber);
      if (!vehicleFleet) return [];
      const isGpsActive = v.gpsStatus !== 'offline';
      const inspections: InspectionFlags = {
        preRoute: preRoutePlates.has(v.plateNumber),
        postRoute: postRoutePlates.has(v.plateNumber),
        weekly: weeklyPlates.has(v.plateNumber),
      };
      const allDone = inspections.preRoute && inspections.postRoute && inspections.weekly;
      return {
        ...v,
        fleet: vehicleFleet,
        inspections,
        needsAttention: isGpsActive && !allDone,
      };
    });

    return res.status(200).json({
      configured: true,
      date: today,
      vehicles: scopedVehicles,
      summary: {
        total: scopedVehicles.length,
        running: scopedVehicles.filter(v => v.gpsStatus === 'running').length,
        stopped: scopedVehicles.filter(v => v.gpsStatus === 'stopped').length,
        offline: scopedVehicles.filter(v => v.gpsStatus === 'offline').length,
        needsAttention: scopedVehicles.filter(v => v.needsAttention).length,
      },
    });
  } catch (error: any) {
    if (error.message === 'Invalid Google Sheets URL') {
      return res.status(422).json({ error: error.message });
    }
    console.error('[unit-status]', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
