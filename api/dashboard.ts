import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import { verifyAuth } from '../lib/api-auth';
import { getTodayThai, getMondayOfWeekThai } from '../lib/thai-date';
import { fetchSheetVehicles, recordVehicleActivity, type SheetVehicle } from '../lib/unit-status-sheet';

type TypeKey = 'car' | 'van' | 'e_van' | 'motorcycle' | 'e_bike' | 'light_truck' | 'six_wheel_truck';
const TYPE_KEYS: TypeKey[] = ['car', 'van', 'e_van', 'motorcycle', 'e_bike', 'light_truck', 'six_wheel_truck'];

function emptyTypes(): Record<TypeKey, number> {
  return { car: 0, van: 0, e_van: 0, motorcycle: 0, e_bike: 0, light_truck: 0, six_wheel_truck: 0 };
}
function sumTypes(b: Record<TypeKey, number>): number {
  return TYPE_KEYS.reduce((s, k) => s + b[k], 0);
}
function pct(checked: number, total: number): number {
  return total > 0 ? Math.round((checked / total) * 100) : 0;
}

type VehicleRef = { vehicle_id: string; vehicle_type: TypeKey };
type ScopedVehicleRef = VehicleRef & { fleet_id: string };

/** Count vehicles per type, keeping each vehicle once. */
function countByType(refs: Iterable<VehicleRef>): Record<TypeKey, number> {
  const seen = new Set<string>();
  const out = emptyTypes();
  for (const r of refs) {
    if (seen.has(r.vehicle_id)) continue;
    seen.add(r.vehicle_id);
    out[r.vehicle_type] = (out[r.vehicle_type] ?? 0) + 1;
  }
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const sql = neon(process.env.DATABASE_URL!);
  const today = getTodayThai();
  const monday = getMondayOfWeekThai();

  // Admins may filter to one fleet via ?fleetId; non-admins are locked to their JWT fleet.
  // `fleet = null` means "all fleets in scope" (admins only). Fail closed: a non-admin with
  // no fleet is denied, never falls through to null → all fleets. Every query guards with
  // (fleet IS NULL OR col = fleet).
  const isAdmin = user.role === 'admin';
  const fleet: string | null = isAdmin ? ((req.query.fleetId as string) || null) : (user.fleetId || null);
  if (!isAdmin && !fleet) return res.status(403).json({ error: 'Forbidden' });

  try {
    let telematicsUnavailable = false;
    const [vehicleRows, inspectedRows, weeklyInspectedRows, oosRows, issueCount, defectRows, fleetTotals, fleetChecked, sheetVehicles] = await Promise.all([
      // All vehicles in scope (composition + plate matching against the GPS sheet).
      sql`
        SELECT id, plate_number, vehicle_type, fleet_id, tax_expiry_date
        FROM vehicle_master
        WHERE company_id = ${user.companyId}
          AND (${fleet}::text IS NULL OR fleet_id = ${fleet})
          AND is_active
      `,
      // Vehicles with today's daily (pre-route) / post-route inspection.
      sql`
        SELECT DISTINCT i.vehicle_id, i.frequency, v.vehicle_type
        FROM inspection_logs i
        JOIN vehicle_master v ON v.id = i.vehicle_id
        WHERE i.inspection_date = ${today}
          AND i.company_id = ${user.companyId}
          AND i.frequency IN ('daily', 'post_route')
          AND v.is_active
          AND (${fleet}::text IS NULL OR v.fleet_id = ${fleet})
      `,
      // Vehicles with a weekly inspection this week (Monday..today, Bangkok).
      sql`
        SELECT DISTINCT i.vehicle_id, v.vehicle_type
        FROM inspection_logs i
        JOIN vehicle_master v ON v.id = i.vehicle_id
        WHERE i.frequency = 'weekly'
          AND i.company_id = ${user.companyId}
          AND i.inspection_date >= ${monday}
          AND i.inspection_date <= ${today}
          AND v.is_active
          AND (${fleet}::text IS NULL OR v.fleet_id = ${fleet})
      `,
      // Out of service: vehicles whose most recent answered "vehicle usable?" is No.
      // (today = that latest not-usable inspection happened today)
      sql`
        SELECT
          COUNT(*) FILTER (WHERE NOT vehicle_usable)::int AS total,
          COUNT(*) FILTER (WHERE NOT vehicle_usable AND inspection_date = ${today}::date)::int AS today
        FROM (
          SELECT DISTINCT ON (il.vehicle_id) il.vehicle_usable, il.inspection_date
          FROM inspection_logs il
          JOIN vehicle_master v ON v.id = il.vehicle_id
          WHERE il.vehicle_usable IS NOT NULL
            AND il.company_id = ${user.companyId}
            AND v.is_active
            AND (${fleet}::text IS NULL OR v.fleet_id = ${fleet})
          ORDER BY il.vehicle_id, il.inspection_date DESC, il.created_at DESC
        ) latest
      `,
      // Vehicles with a defect = distinct vehicles with an open/in-progress issue
      // (a vehicle with several defects counts once; today = first reported today).
      sql`
        SELECT
          COUNT(DISTINCT vehicle_id)::int AS total,
          (COUNT(DISTINCT vehicle_id) FILTER (
            WHERE (ir.created_at AT TIME ZONE 'Asia/Bangkok')::date = ${today}::date
          ))::int AS today
        FROM issue_reports ir
        JOIN vehicle_master vm ON vm.id = ir.vehicle_id AND vm.is_active
        WHERE ir.status IN ('open', 'in_progress')
          AND ir.company_id = ${user.companyId}
          AND (${fleet}::text IS NULL OR ir.fleet_id = ${fleet})
      `,
      // Defect vehicle list (drives the Notify-vendor rows).
      sql`
        SELECT ir.id AS issue_id, vm.plate_number AS plate, ir.fleet_id, ir.status,
          (${today}::date - (ir.created_at AT TIME ZONE 'Asia/Bangkok')::date)::int AS age_days,
          ir.vendor_notified_at,
          (vm.vendor_email IS NOT NULL AND vm.vendor_email != '') AS has_vendor_email
        FROM issue_reports ir
        JOIN vehicle_master vm ON vm.id = ir.vehicle_id AND vm.is_active
        WHERE ir.status IN ('open', 'in_progress')
          AND ir.company_id = ${user.companyId}
          AND (${fleet}::text IS NULL OR ir.fleet_id = ${fleet})
        ORDER BY ir.created_at ASC
        LIMIT 50
      `,
      // Per-fleet totals + daily completion (fleet filter options).
      sql`
        SELECT fleet_id, COUNT(*)::int AS total
        FROM vehicle_master
        WHERE company_id = ${user.companyId}
          AND (${fleet}::text IS NULL OR fleet_id = ${fleet})
          AND is_active
        GROUP BY fleet_id
        ORDER BY fleet_id
      `,
      sql`
        SELECT v.fleet_id, COUNT(DISTINCT i.vehicle_id)::int AS checked
        FROM inspection_logs i
        JOIN vehicle_master v ON v.id = i.vehicle_id
        WHERE i.inspection_date = ${today} AND i.frequency = 'daily'
          AND i.company_id = ${user.companyId}
          AND v.is_active
          AND (${fleet}::text IS NULL OR v.fleet_id = ${fleet})
        GROUP BY v.fleet_id
      `,
      // Telematics snapshot (null = sheet not configured; degrade to fleet-size denominators).
      fetchSheetVehicles(sql, user.companyId, { companySlug: user.companySlug }).catch((err): SheetVehicle[] | null => {
        telematicsUnavailable = true;
        console.warn('[dashboard] GPS sheet unavailable:', err.message);
        return null;
      }),
    ]);

    // Composition + total fleet size.
    const byType = emptyTypes();
    const vehicleByPlate = new Map<string, ScopedVehicleRef>();
    for (const r of vehicleRows as any[]) {
      byType[r.vehicle_type as TypeKey] += 1;
      vehicleByPlate.set(r.plate_number, {
        vehicle_id: r.id,
        vehicle_type: r.vehicle_type,
        fleet_id: r.fleet_id,
      });
    }
    const totalVehicles = sumTypes(byType);

    // Active = telematics shows usage (GPS online) — per client definition (comment 1).
    const telematics = sheetVehicles !== null;
    let activeTodayIds = new Set<string>();
    let activeTodayByType = emptyTypes();
    let weeklyActiveIds = new Set<string>();
    let weeklyActiveByType = emptyTypes();

    if (telematics) {
      const activeRefs: VehicleRef[] = [];
      for (const v of sheetVehicles!) {
        if (v.gpsStatus === 'offline') continue;
        const ref = vehicleByPlate.get(v.plateNumber);
        if (ref) activeRefs.push(ref);
      }
      activeTodayByType = countByType(activeRefs);
      activeTodayIds = new Set(activeRefs.map(r => r.vehicle_id));

      // Persist today's snapshot while reading the week's activity. Unioning the
      // current refs makes the result correct even if the read wins the race.
      const [weeklyActiveRows] = await Promise.all([
        sql`
          SELECT DISTINCT a.vehicle_id, v.vehicle_type
          FROM vehicle_activity_log a
          JOIN vehicle_master v ON v.id = a.vehicle_id
          WHERE a.activity_date >= ${monday}
            AND a.activity_date <= ${today}
            AND a.company_id = ${user.companyId}
            AND (${fleet}::text IS NULL OR v.fleet_id = ${fleet})
        `,
        recordVehicleActivity(sql, sheetVehicles!, today, user.companyId),
      ]);
      const weeklyActivityRefs = [...weeklyActiveRows as VehicleRef[], ...activeRefs];
      weeklyActiveByType = countByType(weeklyActivityRefs);
      weeklyActiveIds = new Set(weeklyActivityRefs.map(r => r.vehicle_id));
    }

    // Completion numerators: inspected vehicles, restricted to the Active set when
    // telematics is available (comments 2-4: completed vs Active vehicles).
    const inspected = inspectedRows as Array<VehicleRef & { frequency: string }>;
    const dailyRefs = inspected.filter(r => r.frequency === 'daily');
    const postRouteRefs = inspected.filter(r => r.frequency === 'post_route');
    const weeklyRefs = weeklyInspectedRows as VehicleRef[];

    const restrict = (refs: VehicleRef[], activeIds: Set<string>) =>
      telematics ? refs.filter(r => activeIds.has(r.vehicle_id)) : refs;

    const dailyByType = countByType(restrict(dailyRefs, activeTodayIds));
    const postRouteByType = countByType(restrict(postRouteRefs, activeTodayIds));
    const weeklyByType = countByType(restrict(weeklyRefs, weeklyActiveIds));

    // Reuse this same telematics snapshot for the GPS counters/table so a fleet
    // switch performs one sheet download and returns one internally consistent view.
    const dailyIds = new Set(dailyRefs.map((r) => r.vehicle_id));
    const postRouteIds = new Set(postRouteRefs.map((r) => r.vehicle_id));
    const weeklyIds = new Set(weeklyRefs.map((r) => r.vehicle_id));
    const unitVehicles = sheetVehicles?.flatMap((v) => {
      const ref = vehicleByPlate.get(v.plateNumber);
      if (!ref) return [];
      const inspections = {
        preRoute: dailyIds.has(ref.vehicle_id),
        postRoute: postRouteIds.has(ref.vehicle_id),
        weekly: weeklyIds.has(ref.vehicle_id),
      };
      const isGpsActive = v.gpsStatus !== 'offline';
      return [{
        ...v,
        fleet: ref.fleet_id,
        inspections,
        needsAttention: isGpsActive &&
          !(inspections.preRoute && inspections.postRoute && inspections.weekly),
      }];
    }) ?? [];
    const unitStatus = sheetVehicles === null
      ? telematicsUnavailable
        ? null
        : { configured: false, vehicles: [] }
      : {
          configured: true,
          date: today,
          vehicles: unitVehicles,
          summary: {
            total: unitVehicles.length,
            running: unitVehicles.filter((v) => v.gpsStatus === 'running').length,
            stopped: unitVehicles.filter((v) => v.gpsStatus === 'stopped').length,
            offline: unitVehicles.filter((v) => v.gpsStatus === 'offline').length,
            needsAttention: unitVehicles.filter((v) => v.needsAttention).length,
          },
        };

    const oosTotal = (oosRows as any[])[0]?.total ?? 0;
    const oosToday = (oosRows as any[])[0]?.today ?? 0;
    const defectTotal = (issueCount as any[])[0]?.total ?? 0;
    const defectToday = (issueCount as any[])[0]?.today ?? 0;

    // Denominators: Active vehicles when telematics is configured, fleet size otherwise.
    const dailyDenom = telematics ? activeTodayByType : byType;
    const weeklyDenom = telematics ? weeklyActiveByType : byType;
    const activeByType = telematics ? activeTodayByType : byType;
    const activeCount = telematics ? activeTodayIds.size : totalVehicles - oosTotal;

    const completion = (checkedByType: Record<TypeKey, number>, denomByType: Record<TypeKey, number>) => {
      const checked = sumTypes(checkedByType);
      const total = sumTypes(denomByType);
      return {
        checked,
        total,
        pending: Math.max(0, total - checked),
        percentage: pct(checked, total),
        byType: checkedByType,
        totalByType: denomByType,
      };
    };

    const checkedMap = Object.fromEntries((fleetChecked as any[]).map((r) => [r.fleet_id, r.checked]));
    const fleets = (fleetTotals as any[]).map((f) => ({
      fleetId: f.fleet_id,
      total: f.total,
      checked: checkedMap[f.fleet_id] || 0,
      pending: f.total - (checkedMap[f.fleet_id] || 0),
    }));

    const preDeparture = completion(dailyByType, dailyDenom);

    res.status(200).json({
      date: today,
      fleetId: fleet,
      totalVehicles,
      byType,
      telematics,
      unitStatus,
      active: {
        checked: activeCount,
        total: totalVehicles,
        pending: Math.max(0, totalVehicles - activeCount),
        percentage: pct(activeCount, totalVehicles),
        byType: activeByType,
        totalByType: byType,
      },
      preDeparture,
      postRoute: completion(postRouteByType, dailyDenom),
      weekly: completion(weeklyByType, weeklyDenom),
      outOfService: { total: oosTotal, today: oosToday },
      withDefect: {
        total: defectTotal,
        today: defectToday,
        vehicles: (defectRows as any[]).map((d) => ({
          issueId: d.issue_id,
          plate: d.plate,
          fleetId: d.fleet_id,
          status: d.status,
          ageDays: d.age_days,
          vendorNotifiedAt: d.vendor_notified_at ?? null,
          hasVendorEmail: d.has_vendor_email ?? false,
        })),
      },
      fleets,
      vehicleTax: (vehicleRows as any[])
        .filter((v) => v.tax_expiry_date)
        .map((v) => ({
          vehicleId: v.id,
          plate: v.plate_number,
          fleetId: v.fleet_id,
          expiryDate: v.tax_expiry_date,
        }))
        .sort((a, b) => String(a.expiryDate).localeCompare(String(b.expiryDate))),
      // Back-compat alias (= pre-departure / daily completion).
      overall: {
        total: preDeparture.total,
        checked: preDeparture.checked,
        pending: preDeparture.pending,
        percentage: preDeparture.percentage,
      },
    });
  } catch (error: any) {
    console.error('[API] Error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}
