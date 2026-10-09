/**
 * Shared access to the telematics Google Sheet (unit_status_sheet_url setting).
 * Both /api/unit-status and /api/dashboard read GPS state from here; the dashboard
 * additionally derives the "Active" metric from it, so the fetching/parsing and the
 * daily activity-log recording live in one place.
 */

export type GpsStatus = 'running' | 'stopped' | 'offline';

export type SheetVehicle = {
  plateNumber: string;
  fleet: string;
  driverName: string;
  gpsStatus: GpsStatus;
  ignition: boolean;
  speed: number;
  lastFixTime: string;
  updatedAt: string;
};

type NeonSql = (strings: TemplateStringsArray, ...params: any[]) => Promise<any[]>;

/** Convert a Google Sheets edit URL to a CSV export URL. */
export function toSheetCsvUrl(url: string): string | null {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) return null;
  const id = match[1];
  const gidMatch = url.match(/[#?&]gid=(\d+)/);
  const gid = gidMatch ? gidMatch[1] : '0';
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

export function parseGpsStatus(raw: string): GpsStatus {
  const s = raw.trim().toLowerCase();
  if (s === 'running') return 'running';
  if (s === 'stop') return 'stopped';
  return 'offline';
}

const DHL_OFFLINE_AFTER_MS = 60 * 60 * 1000;

/** Device timestamps without an offset are Bangkok time, never server-local time. */
function parseDeviceTime(raw: string): number | null {
  const parts = raw.trim().match(
    /^(\d{4})([.-])(\d{2})\2(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/i,
  );
  if (!parts) return null;
  const [, year, , month, day, hour, minute, seconds = '00', fraction = '', zone = '+07:00'] = parts;
  // Date.parse normalizes impossible dates such as February 30; reject those first.
  const calendar = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +seconds));
  if (calendar.getUTCFullYear() !== +year || calendar.getUTCMonth() !== +month - 1 ||
      calendar.getUTCDate() !== +day || calendar.getUTCHours() !== +hour ||
      calendar.getUTCMinutes() !== +minute || calendar.getUTCSeconds() !== +seconds) return null;
  const time = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${seconds}${fraction}${zone}`);
  return Number.isFinite(time) ? time : null;
}

/**
 * DHL connectivity is independent of ignition: OFF/Stop and ON/Idle stay online
 * through 60 minutes without another device report. UpdatedAt is the sheet's
 * refresh time and must not restart this window.
 */
export function resolveDhlGpsStatus(
  vehicle: { status?: string; ignition?: string; speed?: number; lastFixTime?: string },
  now: number = Date.now(),
): GpsStatus {
  const lastReport = parseDeviceTime(vehicle.lastFixTime ?? '');
  if (lastReport === null || lastReport > now || now - lastReport > DHL_OFFLINE_AFTER_MS) {
    return 'offline';
  }
  const ignition = (vehicle.ignition ?? '').trim().toUpperCase();
  const status = (vehicle.status ?? '').trim().toLowerCase();
  if (ignition === 'OFF') return 'stopped';
  if (status === 'running' || status === 'moving') return 'running';
  if (status === 'stop' || status === 'stopped' || status === 'idle') return 'stopped';
  // A fresh device packet supersedes a premature upstream Offline label.
  if (ignition === 'ON') return (vehicle.speed ?? 0) > 0 ? 'running' : 'stopped';
  return 'offline';
}

const GPS_STATUS_PRIORITY: Record<GpsStatus, number> = {
  offline: 0,
  stopped: 1,
  running: 2,
};

/**
 * Keep one deterministic row per plate before any dashboard calculation.
 * DHL uses the latest valid device report, then status priority for timestamp
 * ties. Other tenants retain status priority. All consumers use the same row.
 */
function dedupeVehicles(vehicles: SheetVehicle[], now?: number): SheetVehicle[] {
  const byPlate = new Map<string, SheetVehicle>();
  const reportTime = (vehicle: SheetVehicle) => {
    const time = parseDeviceTime(vehicle.lastFixTime);
    return time !== null && time <= now! ? time : -Infinity;
  };
  for (const vehicle of vehicles) {
    const current = byPlate.get(vehicle.plateNumber);
    const recency = now === undefined || !current ? 0 :
      reportTime(vehicle) > reportTime(current) ? 1 :
      reportTime(vehicle) < reportTime(current) ? -1 : 0;
    if (!current || recency > 0 ||
        (recency === 0 && GPS_STATUS_PRIORITY[vehicle.gpsStatus] > GPS_STATUS_PRIORITY[current.gpsStatus])) {
      byPlate.set(vehicle.plateNumber, vehicle);
    }
  }
  return [...byPlate.values()];
}

async function fetchSheetCsv(csvUrl: string): Promise<string> {
  const res = await fetch(csvUrl, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
  return res.text();
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/"/g, ''));
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? ''; });
    return row;
  });
}

/**
 * Read the configured sheet and return one entry per vehicle row.
 * Returns null when no sheet URL is configured; throws on an invalid URL
 * or fetch failure so callers can decide how to degrade.
 */
export async function fetchSheetVehicles(
  sql: NeonSql,
  companyId: string,
  options: { companySlug?: string; now?: number } = {},
): Promise<SheetVehicle[] | null> {
  const settingsRows = await sql`
    SELECT value FROM app_settings
    WHERE key = 'unit_status_sheet_url' AND company_id = ${companyId}
  `;
  const sheetUrl = settingsRows[0]?.value?.trim() ?? '';
  if (!sheetUrl) return null;

  const csvUrl = toSheetCsvUrl(sheetUrl);
  if (!csvUrl) throw new Error('Invalid Google Sheets URL');

  const rows = parseCsv(await fetchSheetCsv(csvUrl));
  const dhl = options.companySlug === 'dhl';
  const now = options.now ?? Date.now();
  return dedupeVehicles(rows
    .filter(r => r.VehicleNo)
    .map(r => ({
      plateNumber: r.VehicleNo.trim(),
      fleet: r.Fleet ?? '',
      driverName: r.DriverName ?? '',
      gpsStatus: dhl ? resolveDhlGpsStatus({
        status: r.Status,
        ignition: r.Ignition,
        speed: parseFloat(r.Speed ?? '0') || 0,
        lastFixTime: r.LastFixTime,
      }, now) : parseGpsStatus(r.Status ?? ''),
      ignition: (r.Ignition ?? '').toUpperCase() === 'ON',
      speed: parseFloat(r.Speed ?? '0') || 0,
      lastFixTime: r.LastFixTime ?? '',
      updatedAt: r.UpdatedAt ?? '',
    })), dhl ? now : undefined);
}

/**
 * Record today's GPS-online vehicles into vehicle_activity_log (idempotent upsert).
 * "Active" per client definition = telematics shows usage that day, i.e. the GPS
 * unit reported running/stopped rather than offline.
 */
export async function recordVehicleActivity(
  sql: NeonSql,
  vehicles: SheetVehicle[],
  today: string,
  companyId: string,
): Promise<void> {
  const activePlates = vehicles.filter(v => v.gpsStatus !== 'offline').map(v => v.plateNumber);
  if (activePlates.length === 0) return;
  await sql`
    INSERT INTO vehicle_activity_log (activity_date, vehicle_id, company_id)
    SELECT ${today}::date, v.id, ${companyId}::uuid
    FROM vehicle_master v
    WHERE v.company_id = ${companyId}
      AND v.plate_number = ANY(${activePlates}::text[])
    ON CONFLICT DO NOTHING
  `;
}
