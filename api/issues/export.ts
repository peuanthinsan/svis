import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import { getOwnerVehicleIds } from '../../lib/vehicle-access';
import ExcelJS from 'exceljs';
import { verifyAuth } from '../../lib/api-auth';
import { brand, toArgb } from '../../branding';
import { isPubliclyFetchableHttpUrl } from '../../lib/validate';
import { vehicleTypeLabel } from '../../lib/types';

const MAX_PHOTOS = 3;

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  // SSRF guard: photo URLs originate from client-supplied inspection data, so refuse to
  // fetch anything that isn't a public http(s) target (blocks internal/metadata hosts).
  if (!isPubliclyFetchableHttpUrl(url)) return null;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return Buffer.from(new Uint8Array(await res.arrayBuffer())) as Buffer;
  } catch {
    return null;
  }
}

function imgExtension(url: string): 'jpeg' | 'png' | 'gif' {
  const u = url.toLowerCase();
  if (u.includes('.png')) return 'png';
  if (u.includes('.gif')) return 'gif';
  return 'jpeg';
}

function statusLabel(s: string) {
  if (s === 'open') return 'Open';
  if (s === 'in_progress') return 'In Progress';
  if (s === 'completed') return 'Completed';
  return s;
}

function vehicleLabel(t: string) {
  return vehicleTypeLabel(t);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { status, fleetId, dateStart, dateEnd } = req.query;
  const sql = neon(process.env.DATABASE_URL!);

  try {
    // Build dynamic query using neon's parameterized form
    const conditions: string[] = ['ir.company_id = $1', 'vm.company_id = $1'];
    const params: (string | string[] | null)[] = [user.companyId];
    const ownerVehicleIds = await getOwnerVehicleIds(sql, user);
    if (ownerVehicleIds !== null) {
      params.push(ownerVehicleIds);
      conditions.push(`vm.id = ANY($${params.length}::uuid[])`);
    }

    if (status) {
      params.push(status as string);
      conditions.push(`ir.status = $${params.length}`);
    }
    // Fleet scope is enforced here, not by RLS: non-admins can only export their own
    // fleet regardless of requested filters. Owners can narrow their vehicle allowlist by fleet.
    const isAdmin = user.role === 'admin';
    const isOwner = user.role === 'vehicle_owner';
    let effectiveFleetIds: string[] = [];
    if (!isAdmin && !isOwner) {
      if (!user.fleetId) return res.status(403).json({ error: 'Forbidden' });
      effectiveFleetIds = [user.fleetId];
    } else if (fleetId) {
      effectiveFleetIds = (fleetId as string).split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (effectiveFleetIds.length === 1) {
      params.push(effectiveFleetIds[0]);
      conditions.push(`vm.fleet_id = $${params.length}`);
    } else if (effectiveFleetIds.length > 1) {
      const placeholders = effectiveFleetIds.map((id) => {
        params.push(id);
        return `$${params.length}`;
      }).join(',');
      conditions.push(`vm.fleet_id IN (${placeholders})`);
    }
    if (dateStart) {
      params.push(dateStart as string);
      conditions.push(`il.inspection_date >= $${params.length}::date`);
    }
    if (dateEnd) {
      params.push(dateEnd as string);
      conditions.push(`il.inspection_date <= $${params.length}::date`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `
      SELECT ir.id, ir.status, ir.defect_photo_urls, ir.completion_photo_urls,
        ir.created_at,
        vm.plate_number, vm.vehicle_type, vm.fleet_id as vehicle_fleet,
        il.inspector_name, il.inspection_date
      FROM issue_reports ir
      JOIN vehicle_master vm ON vm.id = ir.vehicle_id
      LEFT JOIN inspection_logs il ON il.id = ir.inspection_id AND il.company_id = ir.company_id AND il.vehicle_id = ir.vehicle_id
      ${where}
      ORDER BY ir.created_at DESC
      LIMIT 1000
    `;

    const issues = await sql.query(query, params);

    // Build workbook
    const wb = new ExcelJS.Workbook();
    wb.creator = brand.appName;
    wb.created = new Date();

    const ws = wb.addWorksheet('Issues Report', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
    });

    // Column definitions — text cols + 3 defect photo cols + 3 repair photo cols
    const PHOTO_COL_W = 22;
    ws.columns = [
      { header: '#',               key: 'num',      width: 5  },
      { header: 'Plate Number',    key: 'plate',    width: 14 },
      { header: 'Fleet',           key: 'fleet',    width: 12 },
      { header: 'Vehicle Type',    key: 'vtype',    width: 14 },
      { header: 'Status',          key: 'status',   width: 14 },
      { header: 'Inspector',       key: 'inspector',width: 20 },
      { header: 'Inspection Date', key: 'date',     width: 16 },
      { header: 'Created',         key: 'created',  width: 14 },
      { header: 'Defect 1',  key: 'd1', width: PHOTO_COL_W },
      { header: 'Defect 2',  key: 'd2', width: PHOTO_COL_W },
      { header: 'Defect 3',  key: 'd3', width: PHOTO_COL_W },
      { header: 'Repair 1',  key: 'r1', width: PHOTO_COL_W },
      { header: 'Repair 2',  key: 'r2', width: PHOTO_COL_W },
      { header: 'Repair 3',  key: 'r3', width: PHOTO_COL_W },
    ];

    // Style header row
    const headerRow = ws.getRow(1);
    headerRow.height = 22;
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: toArgb(brand.primary) } };
      cell.font = { bold: true, size: 10, color: { argb: toArgb(brand.primaryText) } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = { bottom: { style: 'medium', color: { argb: toArgb(brand.accent) } } };
    });

    const STATUS_BG: Record<string, string> = {
      open:        'FFFCE4EC',
      in_progress: 'FFFFF8E1',
      completed:   'FFE8F5E9',
    };

    const TEXT_COLS_COUNT = 8;
    const PHOTO_ROW_H = 110; // points (~147px)

    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i] as any;
      const defectUrls: string[] = (issue.defect_photo_urls || []).slice(0, MAX_PHOTOS);
      const repairUrls: string[]  = (issue.completion_photo_urls || []).slice(0, MAX_PHOTOS);
      const hasPhotos = defectUrls.length > 0 || repairUrls.length > 0;

      const rowNum = i + 2; // 1-indexed, row 1 = header
      const row = ws.getRow(rowNum);
      row.height = hasPhotos ? PHOTO_ROW_H : 18;

      row.getCell('num').value      = i + 1;
      row.getCell('plate').value    = issue.plate_number;
      row.getCell('fleet').value    = issue.vehicle_fleet;
      row.getCell('vtype').value    = vehicleLabel(issue.vehicle_type);
      row.getCell('status').value   = statusLabel(issue.status);
      row.getCell('inspector').value = issue.inspector_name || '';
      row.getCell('date').value     = issue.inspection_date
        ? new Date(issue.inspection_date).toLocaleDateString('en-GB')
        : '';
      row.getCell('created').value  = new Date(issue.created_at).toLocaleDateString('en-GB');

      // Row styling
      const rowBg = i % 2 === 0 ? 'FFFFFFFF' : 'FFFAFAFA';
      row.eachCell({ includeEmpty: true }, (cell, colNum) => {
        if (colNum <= TEXT_COLS_COUNT) {
          cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
          cell.font   = { size: 10 };
          cell.alignment = { vertical: 'middle', wrapText: true };
          cell.border = { bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } } };
        }
      });

      // Status cell colour
      row.getCell('status').fill = {
        type: 'pattern', pattern: 'solid',
        fgColor: { argb: STATUS_BG[issue.status] || 'FFFFFFFF' },
      };
      row.getCell('status').font = { size: 10, bold: true };

      // Embed defect photos
      for (let p = 0; p < defectUrls.length; p++) {
        const buf = await fetchImageBuffer(defectUrls[p]);
        if (!buf) continue;
        // @ts-ignore — ExcelJS types compiled against older @types/node Buffer
        const imgId = wb.addImage({ buffer: buf, extension: imgExtension(defectUrls[p]) });
        ws.addImage(imgId, {
          tl: { col: TEXT_COLS_COUNT + p,     row: rowNum - 1 } as any,
          br: { col: TEXT_COLS_COUNT + p + 1, row: rowNum     } as any,
          editAs: 'oneCell',
        });
      }

      // Embed repair photos
      for (let p = 0; p < repairUrls.length; p++) {
        const buf = await fetchImageBuffer(repairUrls[p]);
        if (!buf) continue;
        // @ts-ignore — ExcelJS types compiled against older @types/node Buffer
        const imgId = wb.addImage({ buffer: buf, extension: imgExtension(repairUrls[p]) });
        ws.addImage(imgId, {
          tl: { col: TEXT_COLS_COUNT + MAX_PHOTOS + p,     row: rowNum - 1 } as any,
          br: { col: TEXT_COLS_COUNT + MAX_PHOTOS + p + 1, row: rowNum     } as any,
          editAs: 'oneCell',
        });
      }
    }

    // Freeze header row
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    // Auto-filter on header row
    ws.autoFilter = { from: 'A1', to: 'H1' };

    const buffer = await wb.xlsx.writeBuffer();
    const filename = `${brand.fileSlug}-issues-${new Date().toISOString().slice(0, 10)}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(Buffer.from(buffer).byteLength));
    res.status(200).end(Buffer.from(buffer));
  } catch (error: any) {
    console.error('[API] Export error:', error.message);
    res.status(500).json({ error: 'Export failed' });
  }
}
