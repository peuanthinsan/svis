import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import ExcelJS from 'exceljs';
import { getJwtSecret, verifyAuth } from '../../lib/api-auth';
import { ExportRequestError, redeemExportTicket, resolveExportScope, type ExportScope } from '../../lib/export-download-ticket';
import { logExportFailure, setExportResponseHeaders } from '../../lib/export-http';
import { brand, toArgb } from '../../branding';
import { vehicleTypeLabel } from '../../lib/types';

function vehicleLabel(t: string) {
  return vehicleTypeLabel(t);
}

function statusLabel(s: string) {
  return s === 'pass' ? 'Pass' : s === 'fail' ? 'Fail' : s;
}

function cargoCheckLabel(s: string | null | undefined) {
  return s === 'pass' ? 'OK' : s === 'fail' ? 'Fail' : '';
}

function formatDate(d: string | Date | null | undefined) {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleDateString('en-GB');
}

function excelDate(d: string | Date | null | undefined) {
  if (!d) return '';
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
    ? new Date(`${d}T00:00:00Z`)
    : new Date(d);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setExportResponseHeaders(req, res, 'GET');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let scope: ExportScope;
    let sql: NeonQueryFunction<false, false>;
    if (Object.prototype.hasOwnProperty.call(req.query, 'downloadTicket')) {
      sql = neon(process.env.DATABASE_URL!);
      scope = await redeemExportTicket(sql, req.query.downloadTicket, getJwtSecret());
    } else {
      const user = await verifyAuth(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      scope = resolveExportScope(user, req.query);
      sql = neon(process.env.DATABASE_URL!);
    }
    // Ticket requests use only the stored scope: proxy/user query parameters
    // cannot change the authorized company, fleets or dates after issuance.
    const { companyId, fleetIds, dateStart, dateEnd } = scope;
    // Build dynamic WHERE for inspection-scoped queries
    const inspectionConditions: string[] = ['il.company_id = $1'];
    const inspectionParams: string[] = [companyId];

    if (fleetIds.length === 1) {
      inspectionParams.push(fleetIds[0]);
      inspectionConditions.push(`il.fleet_id = $${inspectionParams.length}`);
    } else if (fleetIds.length > 1) {
      const placeholders = fleetIds.map((id) => {
        inspectionParams.push(id);
        return `$${inspectionParams.length}`;
      }).join(',');
      inspectionConditions.push(`il.fleet_id IN (${placeholders})`);
    }
    if (dateStart) {
      inspectionParams.push(dateStart as string);
      inspectionConditions.push(`il.inspection_date >= $${inspectionParams.length}::date`);
    }
    if (dateEnd) {
      inspectionParams.push(dateEnd as string);
      inspectionConditions.push(`il.inspection_date <= $${inspectionParams.length}::date`);
    }
    const inspectionWhere = inspectionConditions.length > 0
      ? `WHERE ${inspectionConditions.join(' AND ')}`
      : '';

    // Aggregate fleet-level stats for the period
    const fleetStatsQuery = `
      SELECT
        il.fleet_id,
        COUNT(DISTINCT il.vehicle_id)::int AS vehicles_checked,
        COUNT(*)::int                     AS inspections,
        COUNT(*) FILTER (WHERE il.overall_status = 'pass')::int AS passed,
        COUNT(*) FILTER (WHERE il.overall_status = 'fail')::int AS failed
      FROM inspection_logs il
      ${inspectionWhere}
      GROUP BY il.fleet_id
      ORDER BY il.fleet_id
    `;
    const fleetStats = await sql.query(fleetStatsQuery, inspectionParams) as Array<{
      fleet_id: string;
      vehicles_checked: number;
      inspections: number;
      passed: number;
      failed: number;
    }>;

    // Fleet vehicle totals (scoped to selected fleets if provided)
    const totalsConditions: string[] = ['company_id = $1'];
    const totalsParams: string[] = [companyId];
    if (fleetIds.length === 1) {
      totalsParams.push(fleetIds[0]);
      totalsConditions.push(`fleet_id = $${totalsParams.length}`);
    } else if (fleetIds.length > 1) {
      const placeholders = fleetIds.map((id) => {
        totalsParams.push(id);
        return `$${totalsParams.length}`;
      }).join(',');
      totalsConditions.push(`fleet_id IN (${placeholders})`);
    }
    const totalsWhere = totalsConditions.length > 0
      ? `WHERE ${totalsConditions.join(' AND ')}`
      : '';
    const fleetTotalsQuery = `
      SELECT fleet_id, COUNT(*)::int AS total
      FROM vehicle_master
      ${totalsWhere}
      GROUP BY fleet_id
      ORDER BY fleet_id
    `;
    const fleetTotals = await sql.query(fleetTotalsQuery, totalsParams) as Array<{
      fleet_id: string;
      total: number;
    }>;
    const totalMap = Object.fromEntries(fleetTotals.map((f) => [f.fleet_id, f.total]));

    // Inspection detail rows (capped)
    const detailQuery = `
      SELECT
        il.inspection_date,
        il.fleet_id,
        il.inspector_name,
        il.overall_status,
        il.frequency,
        il.created_at,
        vm.plate_number,
        vm.vehicle_type,
        (
          SELECT cargo_result.result
          FROM inspection_results cargo_result
          JOIN checklist_items cargo_item ON cargo_item.id = cargo_result.checklist_item_id
          WHERE cargo_result.inspection_id = il.id
            AND LOWER(TRIM(cargo_item.item_name_en)) = 'cargo box 7-point check'
          LIMIT 1
        ) AS cargo_box_check,
        (
          SELECT STRING_AGG(
            COALESCE(NULLIF(TRIM(failed_item.item_name_en), ''), NULLIF(TRIM(failed_item.item_name_th), ''), 'Checklist item')
              || CASE WHEN NULLIF(TRIM(failed_result.notes), '') IS NOT NULL
                THEN ': ' || TRIM(failed_result.notes) ELSE '' END,
            E'\n' ORDER BY failed_item.sort_order NULLS LAST
          )
          FROM inspection_results failed_result
          JOIN checklist_items failed_item ON failed_item.id = failed_result.checklist_item_id
          WHERE failed_result.inspection_id = il.id
            AND failed_result.result = 'fail'
        ) AS failed_remarks
      FROM inspection_logs il
      JOIN vehicle_master vm ON vm.id = il.vehicle_id
      ${inspectionWhere}
      ORDER BY il.inspection_date DESC, il.created_at DESC
      LIMIT 5000
    `;
    const details = await sql.query(detailQuery, inspectionParams) as Array<{
      inspection_date: string;
      fleet_id: string;
      inspector_name: string | null;
      overall_status: string;
      frequency: string | null;
      created_at: string;
      plate_number: string;
      vehicle_type: string;
      cargo_box_check: string | null;
      failed_remarks: string | null;
    }>;

    // One row per checklist result, matching the information shown in the
    // saved-inspection detail view. Keep the inspection filters identical to
    // the summary/detail sheets so every workbook tab describes the same scope.
    const checklistDetailQuery = `
      SELECT
        il.id AS inspection_id,
        il.inspection_date,
        il.fleet_id,
        il.inspector_name,
        il.overall_status,
        il.frequency,
        il.mileage,
        il.vehicle_usable,
        il.odometer_photo_url,
        il.photo_urls AS inspection_photo_urls,
        vm.plate_number,
        vm.vehicle_type,
        ir.result,
        ir.notes,
        ir.photo_urls AS result_photo_urls,
        ci.sort_order,
        ci.item_name_th,
        ci.item_name_en,
        ci.section
      FROM inspection_logs il
      JOIN vehicle_master vm ON vm.id = il.vehicle_id
      LEFT JOIN inspection_results ir ON ir.inspection_id = il.id
      LEFT JOIN checklist_items ci ON ci.id = ir.checklist_item_id
      ${inspectionWhere}
      ORDER BY il.inspection_date DESC, il.created_at DESC, ci.sort_order NULLS LAST
      LIMIT 50000
    `;
    const checklistDetails = await sql.query(checklistDetailQuery, inspectionParams) as Array<{
      inspection_id: string;
      inspection_date: string;
      fleet_id: string;
      inspector_name: string | null;
      overall_status: string;
      frequency: string | null;
      mileage: number | null;
      vehicle_usable: boolean | null;
      odometer_photo_url: string | null;
      inspection_photo_urls: string[] | null;
      plate_number: string;
      vehicle_type: string;
      result: string | null;
      notes: string | null;
      result_photo_urls: string[] | null;
      sort_order: number | null;
      item_name_th: string | null;
      item_name_en: string | null;
      section: string | null;
    }>;

    // Totals across period
    let totalInspections = 0;
    let totalPassed = 0;
    let totalFailed = 0;
    let totalVehiclesChecked = 0;
    for (const s of fleetStats) {
      totalInspections += s.inspections;
      totalPassed += s.passed;
      totalFailed += s.failed;
      totalVehiclesChecked += s.vehicles_checked;
    }
    const totalVehicles = fleetTotals.reduce((acc, f) => acc + f.total, 0);

    /* ─────────── Build workbook ─────────── */
    const wb = new ExcelJS.Workbook();
    wb.creator = brand.appName;
    wb.created = new Date();

    const YELLOW = toArgb(brand.primary);
    const RED    = toArgb(brand.accent);
    const TEXT   = toArgb(brand.primaryText);
    const GREEN  = 'FFE8F5E9';
    const REDBG  = 'FFFCE4EC';

    /* ─── Summary sheet ─── */
    const sum = wb.addWorksheet('Summary', {
      pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1 },
    });
    sum.columns = [{ width: 32 }, { width: 28 }];

    const title = sum.addRow([`${brand.appName} — Dashboard Report`]);
    title.font = { bold: true, size: 16, color: { argb: 'FF1A1A1A' } };
    sum.mergeCells('A1:B1');
    title.height = 26;

    sum.addRow([]);

    const filtersRows: [string, string][] = [
      ['Generated', new Date().toLocaleString('en-GB')],
      ['Fleets',   fleetIds.length > 0 ? fleetIds.join(', ') : 'All'],
      ['From',     (dateStart as string) || 'All time'],
      ['To',       (dateEnd as string)   || 'All time'],
    ];
    for (const [k, v] of filtersRows) {
      const r = sum.addRow([k, v]);
      r.getCell(1).font = { bold: true, color: { argb: 'FF555555' } };
      r.getCell(2).alignment = { wrapText: true };
    }

    sum.addRow([]);
    const statsHeader = sum.addRow(['Metric', 'Value']);
    statsHeader.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
      cell.font = { bold: true, color: { argb: TEXT } };
      cell.border = { bottom: { style: 'medium', color: { argb: RED } } };
    });

    const passRate = totalInspections > 0
      ? `${Math.round((totalPassed / totalInspections) * 100)}%`
      : '—';

    const metrics: [string, string | number][] = [
      ['Total vehicles in scope', totalVehicles],
      ['Unique vehicles inspected', totalVehiclesChecked],
      ['Total inspections', totalInspections],
      ['Passed', totalPassed],
      ['Failed', totalFailed],
      ['Pass rate', passRate],
    ];
    for (const [k, v] of metrics) {
      const r = sum.addRow([k, v]);
      r.getCell(1).font = { size: 11 };
      r.getCell(2).font = { size: 11, bold: true };
      if (k === 'Passed') r.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
      if (k === 'Failed') r.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: REDBG } };
    }

    /* ─── Fleet breakdown sheet ─── */
    const fleetSheet = wb.addWorksheet('By Fleet', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
    });
    fleetSheet.columns = [
      { header: 'Fleet',         key: 'fleet',    width: 14 },
      { header: 'Vehicles',      key: 'vehicles', width: 12 },
      { header: 'Inspected',     key: 'checked',  width: 12 },
      { header: 'Inspections',   key: 'total',    width: 14 },
      { header: 'Passed',        key: 'passed',   width: 12 },
      { header: 'Failed',        key: 'failed',   width: 12 },
      { header: 'Pass Rate',     key: 'rate',     width: 12 },
    ];
    const fleetHeader = fleetSheet.getRow(1);
    fleetHeader.height = 22;
    fleetHeader.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
      cell.font = { bold: true, size: 10, color: { argb: TEXT } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = { bottom: { style: 'medium', color: { argb: RED } } };
    });

    // Build the union of fleet_ids we need to display
    const displayFleets = new Set<string>([
      ...fleetStats.map((s) => s.fleet_id),
      ...fleetTotals.map((f) => f.fleet_id),
    ]);
    const sortedFleets = Array.from(displayFleets).sort();
    const statsMap = Object.fromEntries(fleetStats.map((s) => [s.fleet_id, s]));

    sortedFleets.forEach((fid, i) => {
      const s = statsMap[fid];
      const insp = s?.inspections ?? 0;
      const passed = s?.passed ?? 0;
      const failed = s?.failed ?? 0;
      const checked = s?.vehicles_checked ?? 0;
      const rate = insp > 0 ? `${Math.round((passed / insp) * 100)}%` : '—';

      const row = fleetSheet.addRow({
        fleet:    fid,
        vehicles: totalMap[fid] ?? 0,
        checked,
        total:    insp,
        passed,
        failed,
        rate,
      });
      const rowBg = i % 2 === 0 ? 'FFFFFFFF' : 'FFFAFAFA';
      row.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
        cell.font = { size: 10 };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } } };
      });
      if (failed > 0) {
        row.getCell('failed').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: REDBG } };
        row.getCell('failed').font = { size: 10, bold: true };
      }
    });

    // Totals row
    const totalRow = fleetSheet.addRow({
      fleet:    'TOTAL',
      vehicles: totalVehicles,
      checked:  totalVehiclesChecked,
      total:    totalInspections,
      passed:   totalPassed,
      failed:   totalFailed,
      rate:     passRate,
    });
    totalRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
      cell.font = { size: 10, bold: true };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = { top: { style: 'medium', color: { argb: RED } } };
    });

    fleetSheet.views = [{ state: 'frozen', ySplit: 1 }];
    fleetSheet.autoFilter = { from: 'A1', to: 'G1' };

    /* ─── Inspections detail sheet ─── */
    const detail = wb.addWorksheet('Inspections', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
    });
    detail.columns = [
      { header: '#',               key: 'num',       width: 5  },
      { header: 'Date',            key: 'date',      width: 13 },
      { header: 'Plate Number',    key: 'plate',     width: 14 },
      { header: 'Fleet',           key: 'fleet',     width: 12 },
      { header: 'Vehicle Type',    key: 'vtype',     width: 14 },
      { header: 'Frequency',       key: 'frequency', width: 12 },
      { header: 'Inspector',       key: 'inspector', width: 22 },
      { header: 'Status',          key: 'status',    width: 10 },
      { header: 'Logged At',       key: 'created',   width: 16 },
      { header: 'Cargo box 7-point check', key: 'cargoCheck', width: 22 },
      { header: 'Remark',           key: 'remark',    width: 32 },
    ];
    const detailHeader = detail.getRow(1);
    detailHeader.height = 22;
    detailHeader.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5B9BD5' } };
      cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = { bottom: { style: 'medium', color: { argb: RED } } };
    });

    details.forEach((row, i) => {
      const r = detail.addRow({
        num:       i + 1,
        date:      excelDate(row.inspection_date),
        plate:     row.plate_number,
        fleet:     row.fleet_id,
        vtype:     vehicleLabel(row.vehicle_type),
        frequency: row.frequency || 'daily',
        inspector: row.inspector_name || '',
        status:    statusLabel(row.overall_status),
        created:   excelDate(row.created_at),
        cargoCheck: cargoCheckLabel(row.cargo_box_check),
        remark:    row.failed_remarks || '',
      });
      r.getCell('date').numFmt = 'dd/mm/yyyy';
      r.getCell('created').numFmt = 'dd/mm/yyyy, hh:mm:ss';
      const rowBg = i % 2 === 0 ? 'FFFFFFFF' : 'FFFAFAFA';
      r.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
        cell.font = { size: 10 };
        cell.alignment = { vertical: 'middle' };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } } };
      });
      if (row.overall_status === 'fail') {
        r.getCell('status').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: REDBG } };
        r.getCell('status').font = { size: 10, bold: true };
      } else if (row.overall_status === 'pass') {
        r.getCell('status').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
      }
    });

    if (details.length === 0) {
      const empty = detail.addRow({ num: '', date: 'No inspections in this period.' });
      detail.mergeCells(`B${empty.number}:I${empty.number}`);
      empty.getCell('date').alignment = { horizontal: 'center' };
      empty.getCell('date').font = { italic: true, color: { argb: 'FF888888' } };
    }

    detail.views = [{ state: 'frozen', ySplit: 1 }];
    detail.autoFilter = { from: 'A1', to: 'K1' };
    if (details.length > 0) {
      detail.addTable({
        name: 'InspectionsTable',
        ref: `A1:K${details.length + 1}`,
        headerRow: true,
        totalsRow: false,
        style: { theme: 'TableStyleMedium2', showRowStripes: false },
        columns: [
          { name: '#' },
          { name: 'Date' },
          { name: 'Plate Number' },
          { name: 'Fleet' },
          { name: 'Vehicle Type' },
          { name: 'Frequency' },
          { name: 'Inspector' },
          { name: 'Status' },
          { name: 'Logged At' },
          { name: 'Cargo box 7-point check' },
          { name: 'Remark' },
        ],
        rows: details.map((_, i) => [
          i + 1,
          excelDate(details[i].inspection_date),
          details[i].plate_number,
          details[i].fleet_id,
          vehicleLabel(details[i].vehicle_type),
          details[i].frequency || 'daily',
          details[i].inspector_name || '',
          statusLabel(details[i].overall_status),
          excelDate(details[i].created_at),
          cargoCheckLabel(details[i].cargo_box_check),
          details[i].failed_remarks || '',
        ]),
      });
    }

    /* ─── Checklist detail sheet ─── */
    const checklist = wb.addWorksheet('Checklist Detail', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
    });
    checklist.columns = [
      { header: 'Inspection ID',       key: 'inspectionId', width: 38 },
      { header: 'Date',                key: 'date',         width: 13 },
      { header: 'Plate Number',        key: 'plate',        width: 14 },
      { header: 'Fleet',               key: 'fleet',        width: 12 },
      { header: 'Vehicle Type',        key: 'vtype',        width: 14 },
      { header: 'Inspection Type',     key: 'frequency',    width: 16 },
      { header: 'Inspector',           key: 'inspector',    width: 22 },
      { header: 'Status',              key: 'status',       width: 10 },
      { header: 'Mileage',             key: 'mileage',      width: 12 },
      { header: 'Vehicle Usable',      key: 'usable',       width: 16 },
      { header: 'Odometer Photo',      key: 'odometer',     width: 38 },
      { header: 'Checklist #',         key: 'itemNumber',   width: 12 },
      { header: 'Checklist Item (EN)',  key: 'itemEn',       width: 34 },
      { header: 'Checklist Item (TH)',  key: 'itemTh',       width: 34 },
      { header: 'Section',              key: 'section',      width: 14 },
      { header: 'Result',               key: 'result',       width: 10 },
      { header: 'Notes',                key: 'notes',        width: 32 },
      { header: 'Checklist Photos',     key: 'itemPhotos',   width: 42 },
      { header: 'Other Photos',         key: 'otherPhotos',  width: 42 },
    ];
    const checklistHeader = checklist.getRow(1);
    checklistHeader.height = 22;
    checklistHeader.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
      cell.font = { bold: true, size: 10, color: { argb: TEXT } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = { bottom: { style: 'medium', color: { argb: RED } } };
    });

    checklistDetails.forEach((row, i) => {
      const itemPhotos = (row.result_photo_urls || []).filter(Boolean).join(', ');
      const otherPhotos = (row.inspection_photo_urls || []).filter(Boolean).join(', ');
      const r = checklist.addRow({
        inspectionId: row.inspection_id,
        date: formatDate(row.inspection_date),
        plate: row.plate_number,
        fleet: row.fleet_id,
        vtype: vehicleLabel(row.vehicle_type),
        frequency: row.frequency || 'daily',
        inspector: row.inspector_name || '',
        status: statusLabel(row.overall_status),
        mileage: row.mileage ?? '',
        usable: row.vehicle_usable === null ? '' : row.vehicle_usable ? 'Yes' : 'No',
        odometer: row.odometer_photo_url || '',
        itemNumber: row.sort_order === null ? '' : row.sort_order + 1,
        itemEn: row.item_name_en || '',
        itemTh: row.item_name_th || '',
        section: row.section || '',
        result: row.result ? statusLabel(row.result) : '',
        notes: row.notes || '',
        itemPhotos,
        otherPhotos,
      });
      const rowBg = i % 2 === 0 ? 'FFFFFFFF' : 'FFFAFAFA';
      r.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
        cell.font = { size: 10 };
        cell.alignment = { vertical: 'top', wrapText: true };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } } };
      });
      if (row.result === 'fail') {
        r.getCell('result').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: REDBG } };
        r.getCell('result').font = { size: 10, bold: true };
      } else if (row.result === 'pass') {
        r.getCell('result').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
      }
    });

    if (checklistDetails.length === 0) {
      const empty = checklist.addRow({ inspectionId: 'No checklist details in this period.' });
      checklist.mergeCells(`A${empty.number}:S${empty.number}`);
      empty.getCell('inspectionId').alignment = { horizontal: 'center' };
      empty.getCell('inspectionId').font = { italic: true, color: { argb: 'FF888888' } };
    }
    checklist.views = [{ state: 'frozen', ySplit: 1 }];
    checklist.autoFilter = { from: 'A1', to: 'S1' };

    const buffer = await wb.xlsx.writeBuffer();
    const today = new Date().toISOString().slice(0, 10);
    const filename = `${brand.fileSlug}-dashboard-${today}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(Buffer.from(buffer).byteLength));
    res.status(200).end(Buffer.from(buffer));
  } catch (error) {
    if (error instanceof ExportRequestError) {
      return res.status(error.status).json({ error: error.message });
    }
    logExportFailure('dashboard_export_failed', error);
    res.status(500).json({ error: 'Export failed' });
  }
}
