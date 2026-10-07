import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import { verifyAuth, AuthUser } from '../lib/api-auth';
import { getTodayThai } from '../lib/thai-date';

/**
 * Preventive maintenance (DHL feedback, July 2026):
 *  - engine check-up every 10,000 km
 *  - tire replacement every 40,000 km (metro) / 30,000 km (provincial) or 2 years, whichever first
 *  - battery replacement every 18 months
 * The dashboard shows vehicles estimated to hit a threshold within the next 30 days.
 * Mileage projections come from inspection_logs.mileage (odometer entered on every
 * inspection); admins and fleet supervisors maintain the replacement baselines.
 */

const SERVICE_INTERVAL_KM = 10_000;
const TIRE_INTERVAL_KM = { metro: 40_000, provincial: 30_000 } as const;
const TIRE_INTERVAL_MONTHS = 24;
const BATTERY_INTERVAL_MONTHS = 18;
const HORIZON_DAYS = 30;
/** Mileage history window used to estimate km/day. */
const USAGE_WINDOW_DAYS = 60;
/** Minimum days between two mileage readings for a trustworthy km/day estimate. */
const MIN_USAGE_SPAN_DAYS = 7;

type CategoryStatus = 'ok' | 'due' | 'overdue' | 'noData';

type Category = {
  status: CategoryStatus;
  /** Odometer reading at which the threshold is crossed (mileage-based rules). */
  dueAtKm?: number;
  kmRemaining?: number;
  /** Calendar deadline (date-based rules); YYYY-MM-DD. */
  dueDate?: string;
};

function addMonths(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + months, d));
  return date.toISOString().split('T')[0];
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().split('T')[0];
}

// Neon may return PostgreSQL DATE columns as Date objects in serverless
// runtimes. Normalize them before applying the date-based maintenance rules.
function dateOnly(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().split('T')[0];
  if (typeof value === 'string') return value.slice(0, 10);
  return null;
}

function worst(a: CategoryStatus, b: CategoryStatus): CategoryStatus {
  const order: CategoryStatus[] = ['overdue', 'due', 'ok', 'noData'];
  return order[Math.min(order.indexOf(a), order.indexOf(b))];
}

function mileageRule(
  baselineKm: number | null,
  intervalKm: number,
  latestKm: number | null,
  kmPerDay: number | null,
): Category {
  if (baselineKm === null || latestKm === null) return { status: 'noData' };
  const dueAtKm = baselineKm + intervalKm;
  const kmRemaining = dueAtKm - latestKm;
  if (kmRemaining <= 0) return { status: 'overdue', dueAtKm, kmRemaining };
  if (kmPerDay !== null && kmPerDay > 0 && kmRemaining <= kmPerDay * HORIZON_DAYS) {
    return { status: 'due', dueAtKm, kmRemaining };
  }
  return { status: 'ok', dueAtKm, kmRemaining };
}

function dateRule(baselineDate: string | null, intervalMonths: number, today: string): Category {
  if (!baselineDate) return { status: 'noData' };
  const dueDate = addMonths(baselineDate, intervalMonths);
  if (dueDate < today) return { status: 'overdue', dueDate };
  if (dueDate <= addDays(today, HORIZON_DAYS)) return { status: 'due', dueDate };
  return { status: 'ok', dueDate };
}

async function handleGet(req: VercelRequest, res: VercelResponse, user: AuthUser) {
  const sql = neon(process.env.DATABASE_URL!);
  const today = getTodayThai();
  const windowStart = addDays(today, -USAGE_WINDOW_DAYS);

  const isAdmin = user.role === 'admin';
  const fleet: string | null = isAdmin ? ((req.query.fleetId as string) || null) : (user.fleetId || null);
  if (!isAdmin && !fleet) return res.status(403).json({ error: 'Forbidden' });

  try {
    const rows = await sql`
      SELECT v.id, v.plate_number, v.fleet_id, v.vehicle_type, v.region,
        v.tax_expiry_date,
        m.last_service_date, m.last_service_mileage,
        m.last_tire_change_date, m.last_tire_change_mileage,
        m.last_battery_change_date,
        latest.mileage AS latest_mileage, latest.inspection_date AS latest_date,
        earliest.mileage AS earliest_mileage, earliest.inspection_date AS earliest_date
      FROM vehicle_master v
      LEFT JOIN vehicle_maintenance m ON m.vehicle_id = v.id
      LEFT JOIN LATERAL (
        SELECT mileage, inspection_date FROM inspection_logs
        WHERE vehicle_id = v.id
          AND company_id = ${user.companyId}
          AND mileage IS NOT NULL
        ORDER BY inspection_date DESC, created_at DESC LIMIT 1
      ) latest ON true
      LEFT JOIN LATERAL (
        SELECT mileage, inspection_date FROM inspection_logs
        WHERE vehicle_id = v.id
          AND company_id = ${user.companyId}
          AND mileage IS NOT NULL
          AND inspection_date >= ${windowStart}
        ORDER BY inspection_date ASC, created_at ASC LIMIT 1
      ) earliest ON true
      WHERE v.company_id = ${user.companyId}
        AND (${fleet}::text IS NULL OR v.fleet_id = ${fleet})
      ORDER BY v.plate_number
    `;

    const vehicles = (rows as any[]).map((r) => {
      const latestKm: number | null = r.latest_mileage ?? null;
      const latestDate = dateOnly(r.latest_date);
      const earliestDate = dateOnly(r.earliest_date);
      const lastServiceDate = dateOnly(r.last_service_date);
      const lastTireChangeDate = dateOnly(r.last_tire_change_date);
      const lastBatteryChangeDate = dateOnly(r.last_battery_change_date);
      const taxExpiryDate = dateOnly(r.tax_expiry_date);

      // Average daily usage from the mileage recorded on inspections.
      let kmPerDay: number | null = null;
      if (
        r.earliest_mileage !== null && r.latest_mileage !== null &&
        earliestDate && latestDate && earliestDate !== latestDate
      ) {
        const spanDays =
          (Date.parse(latestDate) - Date.parse(earliestDate)) / 86_400_000;
        const kmDiff = r.latest_mileage - r.earliest_mileage;
        if (spanDays >= MIN_USAGE_SPAN_DAYS && kmDiff >= 0) {
          kmPerDay = kmDiff / spanDays;
        }
      }

      const region: 'metro' | 'provincial' = r.region === 'provincial' ? 'provincial' : 'metro';
      const checkup = mileageRule(r.last_service_mileage, SERVICE_INTERVAL_KM, latestKm, kmPerDay);

      // Tires: km rule OR 2-year rule, whichever comes first.
      const tiresKm = mileageRule(r.last_tire_change_mileage, TIRE_INTERVAL_KM[region], latestKm, kmPerDay);
      const tiresDate = dateRule(lastTireChangeDate, TIRE_INTERVAL_MONTHS, today);
      const tires: Category = {
        status: worst(tiresKm.status, tiresDate.status),
        dueAtKm: tiresKm.dueAtKm,
        kmRemaining: tiresKm.kmRemaining,
        dueDate: tiresDate.dueDate,
      };

      const battery = dateRule(lastBatteryChangeDate, BATTERY_INTERVAL_MONTHS, today);

      return {
        vehicleId: r.id,
        plate: r.plate_number,
        fleetId: r.fleet_id,
        vehicleType: r.vehicle_type,
        region,
        latestMileage: latestKm,
        kmPerDay: kmPerDay === null ? null : Math.round(kmPerDay),
        lastServiceDate,
        lastServiceMileage: r.last_service_mileage ?? null,
        lastTireChangeDate,
        lastTireChangeMileage: r.last_tire_change_mileage ?? null,
        lastBatteryChangeDate,
        taxExpiryDate,
        checkup,
        tires,
        battery,
      };
    });

    const summarize = (pick: (v: (typeof vehicles)[number]) => Category) => ({
      due: vehicles.filter((v) => pick(v).status === 'due').length,
      overdue: vehicles.filter((v) => pick(v).status === 'overdue').length,
      noData: vehicles.filter((v) => pick(v).status === 'noData').length,
    });

    res.status(200).json({
      date: today,
      horizonDays: HORIZON_DAYS,
      vehicles,
      summary: {
        checkup: summarize((v) => v.checkup),
        tires: summarize((v) => v.tires),
        battery: summarize((v) => v.battery),
      },
    });
  } catch (error: any) {
    console.error('[maintenance]', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function handlePut(req: VercelRequest, res: VercelResponse, user: AuthUser) {
  if (user.role !== 'admin' && user.role !== 'supervisor') {
    return res.status(403).json({ error: 'Admin or supervisor access required' });
  }
  if (user.role === 'supervisor' && !user.fleetId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const {
    vehicleId, region,
    lastServiceDate, lastServiceMileage,
    lastTireChangeDate, lastTireChangeMileage,
    lastBatteryChangeDate,
    taxExpiryDate,
  } = req.body;

  if (!vehicleId) return res.status(400).json({ error: 'vehicleId is required' });
  if (region !== undefined && region !== 'metro' && region !== 'provincial') {
    return res.status(400).json({ error: 'region must be metro or provincial' });
  }

  const asDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const asKm = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
  const writeFleet = user.role === 'admin' ? null : user.fleetId;
  const lostAccess = () => res.status(user.role === 'admin' ? 404 : 403).json({ error: 'Vehicle no longer accessible' });

  const sql = neon(process.env.DATABASE_URL!);
  try {
    const [vehicle] = await sql`
      SELECT id, fleet_id FROM vehicle_master
      WHERE id = ${vehicleId} AND company_id = ${user.companyId}
    `;
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
    if (user.role === 'supervisor' && vehicle.fleet_id !== user.fleetId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (region !== undefined) {
      const [updated] = await sql`
        UPDATE vehicle_master SET region = ${region}
        WHERE id = ${vehicleId} AND company_id = ${user.companyId}
          AND (${writeFleet}::text IS NULL OR fleet_id = ${writeFleet})
        RETURNING id
      `;
      if (!updated) return lostAccess();
    }
    if (taxExpiryDate !== undefined) {
      const [updated] = await sql`
        UPDATE vehicle_master SET tax_expiry_date = ${asDate(taxExpiryDate)}
        WHERE id = ${vehicleId} AND company_id = ${user.companyId}
          AND (${writeFleet}::text IS NULL OR fleet_id = ${writeFleet})
        RETURNING id
      `;
      if (!updated) return lostAccess();
    }
    const [saved] = await sql`
      INSERT INTO vehicle_maintenance AS existing (
        vehicle_id, company_id, last_service_date, last_service_mileage,
        last_tire_change_date, last_tire_change_mileage, last_battery_change_date, updated_at
      )
      SELECT
        ${vehicleId}, ${user.companyId}, ${asDate(lastServiceDate)}, ${asKm(lastServiceMileage)},
        ${asDate(lastTireChangeDate)}, ${asKm(lastTireChangeMileage)}, ${asDate(lastBatteryChangeDate)}, NOW()
      FROM vehicle_master v
      WHERE v.id = ${vehicleId} AND v.company_id = ${user.companyId}
        AND (${writeFleet}::text IS NULL OR v.fleet_id = ${writeFleet})
      FOR UPDATE OF v
      ON CONFLICT (vehicle_id) DO UPDATE SET
        last_service_date = EXCLUDED.last_service_date,
        last_service_mileage = EXCLUDED.last_service_mileage,
        last_tire_change_date = EXCLUDED.last_tire_change_date,
        last_tire_change_mileage = EXCLUDED.last_tire_change_mileage,
        last_battery_change_date = EXCLUDED.last_battery_change_date,
        updated_at = NOW()
      WHERE existing.company_id = EXCLUDED.company_id
      RETURNING vehicle_id
    `;
    if (!saved) return lostAccess();
    res.status(200).json({ ok: true });
  } catch (error: any) {
    console.error('[maintenance]', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method === 'GET') return handleGet(req, res, user);
  if (req.method === 'PUT') return handlePut(req, res, user);
  return res.status(405).json({ error: 'Method not allowed' });
}
