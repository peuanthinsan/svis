import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import { verifyAuth } from '../lib/api-auth';

function isHistoryDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { startDate, endDate, search } = req.query;
  const outOfService = req.query.outOfService === 'true';
  // Non-admins always see their own fleet from the JWT (fail closed).
  const isAdmin = user.role === 'admin';
  const fleetId = isAdmin ? (req.query.fleetId as string | undefined) : (user.fleetId || undefined);
  if (!isAdmin && !fleetId) return res.status(403).json({ error: 'Forbidden' });
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 100, 1), 500);
  const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
  const vehicleSearch = typeof search === 'string' ? search.trim() : '';
  const vehiclePattern = `%${vehicleSearch}%`;

  const datesMissing = startDate === undefined && endDate === undefined;
  if ((!outOfService && datesMissing) || (!datesMissing && (
    !isHistoryDate(startDate) || !isHistoryDate(endDate) || startDate > endDate
  ))) {
    return res.status(400).json({ error: 'Valid startDate and endDate required (YYYY-MM-DD)' });
  }

  try {
    const sql = neon(process.env.DATABASE_URL!);
    if (outOfService) {
      const fromDate = datesMissing ? null : startDate as string;
      const toDate = datesMissing ? null : endDate as string;
      // Resolve each vehicle's current answer before date/search filters. A newer
      // usable answer clears an older No, while an unanswered inspection does not.
      // Both counts and page rows share one filtered CTE and database snapshot.
      const [result] = await sql`
        WITH latest_answered AS (
          SELECT DISTINCT ON (il.vehicle_id)
            il.*, vm.plate_number, vm.vehicle_type, vm.fleet_id AS current_fleet_id
          FROM inspection_logs il
          JOIN vehicle_master vm ON vm.id = il.vehicle_id
          WHERE il.vehicle_usable IS NOT NULL
            AND il.company_id = ${user.companyId}
            AND vm.company_id = ${user.companyId}
            AND vm.is_active
            AND (${fleetId || null}::text IS NULL OR vm.fleet_id = ${fleetId || null})
          ORDER BY il.vehicle_id, il.inspection_date DESC, il.created_at DESC
        ), filtered AS (
          SELECT * FROM latest_answered
          WHERE vehicle_usable = false
            AND (${fromDate}::date IS NULL OR inspection_date >= ${fromDate}::date)
            AND (${toDate}::date IS NULL OR inspection_date <= ${toDate}::date)
            AND (${vehicleSearch || null}::text IS NULL OR plate_number ILIKE ${vehiclePattern})
        ), paged AS (
          SELECT * FROM filtered
          ORDER BY inspection_date DESC, created_at DESC, id DESC
          LIMIT ${limit} OFFSET ${offset}
        )
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE overall_status = 'pass')::int AS passed,
          COUNT(*) FILTER (WHERE overall_status = 'fail')::int AS failed,
          COALESCE((SELECT json_agg(paged ORDER BY inspection_date DESC, created_at DESC, id DESC)
            FROM paged), '[]'::json) AS inspections
        FROM filtered
      `;
      const inspections = result.inspections.map(({ current_fleet_id, ...inspection }: any) => ({
        ...inspection,
        fleet_id: current_fleet_id,
      }));
      return res.status(200).json({
        total: result.total,
        passed: result.passed,
        failed: result.failed,
        inspections,
      });
    }

    let inspections;
    if (fleetId) {
      inspections = await sql`
        SELECT il.*, vm.plate_number, vm.vehicle_type
        FROM inspection_logs il
        JOIN vehicle_master vm ON vm.id = il.vehicle_id
        WHERE il.inspection_date >= ${startDate as string}
          AND il.inspection_date <= ${endDate as string}
          AND il.company_id = ${user.companyId}
          AND il.fleet_id = ${fleetId as string}
          AND (${vehicleSearch || null}::text IS NULL OR vm.plate_number ILIKE ${vehiclePattern})
        ORDER BY il.inspection_date DESC, il.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      inspections = await sql`
        SELECT il.*, vm.plate_number, vm.vehicle_type
        FROM inspection_logs il
        JOIN vehicle_master vm ON vm.id = il.vehicle_id
        WHERE il.inspection_date >= ${startDate as string}
          AND il.inspection_date <= ${endDate as string}
          AND il.company_id = ${user.companyId}
          AND (${vehicleSearch || null}::text IS NULL OR vm.plate_number ILIKE ${vehiclePattern})
        ORDER BY il.inspection_date DESC, il.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    }

    let countResult;
    if (fleetId) {
      countResult = await sql`
        SELECT
          COUNT(*)::int as total,
          COUNT(*) FILTER (WHERE overall_status = 'pass')::int as passed,
          COUNT(*) FILTER (WHERE overall_status = 'fail')::int as failed
        FROM inspection_logs
        WHERE inspection_date >= ${startDate as string}
          AND inspection_date <= ${endDate as string}
          AND company_id = ${user.companyId}
          AND fleet_id = ${fleetId as string}
          AND (${vehicleSearch || null}::text IS NULL OR EXISTS (
            SELECT 1 FROM vehicle_master vm
            WHERE vm.id = inspection_logs.vehicle_id AND vm.plate_number ILIKE ${vehiclePattern}
          ))
      `;
    } else {
      countResult = await sql`
        SELECT
          COUNT(*)::int as total,
          COUNT(*) FILTER (WHERE overall_status = 'pass')::int as passed,
          COUNT(*) FILTER (WHERE overall_status = 'fail')::int as failed
        FROM inspection_logs
        WHERE inspection_date >= ${startDate as string}
          AND inspection_date <= ${endDate as string}
          AND company_id = ${user.companyId}
          AND (${vehicleSearch || null}::text IS NULL OR EXISTS (
            SELECT 1 FROM vehicle_master vm
            WHERE vm.id = inspection_logs.vehicle_id AND vm.plate_number ILIKE ${vehiclePattern}
          ))
      `;
    }

    const { total, passed, failed } = countResult[0];

    res.status(200).json({
      total,
      passed,
      failed,
      inspections,
    });
  } catch (error: any) {
    console.error('[API] Error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}
