import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import { getOwnerVehicleIds } from '../lib/vehicle-access';
import { sendInspectionFailEmail } from '../lib/email';
import { verifyAuth, AuthUser } from '../lib/api-auth';
import { logAudit } from '../lib/audit';
import { validateInspectionDate, validateInspectionFrequency, validateInspectionResults, validateMileage, validatePhotoUrls } from '../lib/inspection-validation';

async function handleGet(req: VercelRequest, res: VercelResponse, user: AuthUser) {
  const { vehicleId, date, since, carryover, frequency } = req.query;
  const sql = neon(process.env.DATABASE_URL!);

  try {
    if (!vehicleId) {
      return res.status(400).json({ error: 'vehicleId is required' });
    }
    const validFrequencies = ['daily', 'weekly', 'post_route'];
    if (
      frequency !== undefined &&
      (typeof frequency !== 'string' || !validFrequencies.includes(frequency))
    ) {
      return res.status(400).json({ error: 'Invalid frequency' });
    }
    const requestedFrequency = typeof frequency === 'string' ? frequency : null;

    const ownerVehicleIds = await getOwnerVehicleIds(sql, user);
    // Owners need a direct grant; drivers and supervisors stay in their fleet.
    const [veh] = await sql`
      SELECT fleet_id FROM vehicle_master
      WHERE id = ${vehicleId as string} AND company_id = ${user.companyId}
        AND (${ownerVehicleIds}::uuid[] IS NULL OR id = ANY(${ownerVehicleIds}::uuid[]))
    `;
    if (!veh || (user.role !== 'admin' && user.role !== 'vehicle_owner' && veh.fleet_id !== user.fleetId)) {
      return res.status(404).json({ error: 'Not found' });
    }

    // Carryover: checklist items that failed on an inspection whose issue is still
    // open — the next inspection pre-fills these as fail until the defect is resolved.
    if (carryover) {
      const items = await sql`
        SELECT DISTINCT ir.checklist_item_id, ci.item_name_th, ci.item_name_en
        FROM issue_reports irep
        JOIN inspection_results ir ON ir.inspection_id = irep.inspection_id AND ir.result = 'fail'
        JOIN checklist_items ci ON ci.id = ir.checklist_item_id
        WHERE irep.vehicle_id = ${vehicleId as string}
          AND irep.company_id = ${user.companyId}
          AND (${ownerVehicleIds}::uuid[] IS NULL OR irep.vehicle_id = ANY(${ownerVehicleIds}::uuid[]))
          AND irep.status IN ('open', 'in_progress')
      `;
      return res.status(200).json({ items });
    }

    let logs;
    if (date && requestedFrequency) {
      logs = await sql`
        SELECT il.*, vm.plate_number, vm.vehicle_type
        FROM inspection_logs il
        JOIN vehicle_master vm ON vm.id = il.vehicle_id
        WHERE il.vehicle_id = ${vehicleId as string}
          AND il.company_id = ${user.companyId}
          AND (${ownerVehicleIds}::uuid[] IS NULL OR il.vehicle_id = ANY(${ownerVehicleIds}::uuid[]))
          AND il.inspection_date = ${date as string}
          AND il.frequency = ${requestedFrequency}
        ORDER BY il.created_at DESC
      `;
    } else if (date) {
      logs = await sql`
        SELECT il.*, vm.plate_number, vm.vehicle_type
        FROM inspection_logs il
        JOIN vehicle_master vm ON vm.id = il.vehicle_id
        WHERE il.vehicle_id = ${vehicleId as string}
          AND il.company_id = ${user.companyId}
          AND (${ownerVehicleIds}::uuid[] IS NULL OR il.vehicle_id = ANY(${ownerVehicleIds}::uuid[]))
          AND il.inspection_date = ${date as string}
        ORDER BY il.created_at DESC
      `;
    } else if (since && requestedFrequency) {
      logs = await sql`
        SELECT il.*, vm.plate_number, vm.vehicle_type
        FROM inspection_logs il
        JOIN vehicle_master vm ON vm.id = il.vehicle_id
        WHERE il.vehicle_id = ${vehicleId as string}
          AND il.company_id = ${user.companyId}
          AND (${ownerVehicleIds}::uuid[] IS NULL OR il.vehicle_id = ANY(${ownerVehicleIds}::uuid[]))
          AND il.inspection_date >= ${since as string}
          AND il.frequency = ${requestedFrequency}
        ORDER BY il.created_at DESC
      `;
    } else if (since) {
      logs = await sql`
        SELECT il.*, vm.plate_number, vm.vehicle_type
        FROM inspection_logs il
        JOIN vehicle_master vm ON vm.id = il.vehicle_id
        WHERE il.vehicle_id = ${vehicleId as string}
          AND il.company_id = ${user.companyId}
          AND (${ownerVehicleIds}::uuid[] IS NULL OR il.vehicle_id = ANY(${ownerVehicleIds}::uuid[]))
          AND il.inspection_date >= ${since as string}
        ORDER BY il.created_at DESC
      `;
    } else if (requestedFrequency) {
      logs = await sql`
        SELECT il.*, vm.plate_number, vm.vehicle_type
        FROM inspection_logs il
        JOIN vehicle_master vm ON vm.id = il.vehicle_id
        WHERE il.vehicle_id = ${vehicleId as string}
          AND il.company_id = ${user.companyId}
          AND (${ownerVehicleIds}::uuid[] IS NULL OR il.vehicle_id = ANY(${ownerVehicleIds}::uuid[]))
          AND il.frequency = ${requestedFrequency}
        ORDER BY il.inspection_date DESC
        LIMIT 30
      `;
    } else {
      logs = await sql`
        SELECT il.*, vm.plate_number, vm.vehicle_type
        FROM inspection_logs il
        JOIN vehicle_master vm ON vm.id = il.vehicle_id
        WHERE il.vehicle_id = ${vehicleId as string}
          AND il.company_id = ${user.companyId}
          AND (${ownerVehicleIds}::uuid[] IS NULL OR il.vehicle_id = ANY(${ownerVehicleIds}::uuid[]))
        ORDER BY il.inspection_date DESC
        LIMIT 30
      `;
    }

    // Batch-fetch all results for these logs
    const logIds = logs.map((l: any) => l.id);
    if (logIds.length > 0) {
      const allResults = await sql`
        SELECT ir.inspection_id, ir.checklist_item_id, ir.result, ir.photo_urls, ir.notes,
               ci.item_name_th, ci.item_name_en, ci.sort_order, ci.section
        FROM inspection_results ir
        JOIN checklist_items ci ON ci.id = ir.checklist_item_id
        WHERE ir.inspection_id = ANY(${logIds}::uuid[])
          AND ci.company_id = ${user.companyId}
        ORDER BY ci.sort_order
      `;
      const resultsByInspection = new Map<string, any[]>();
      for (const r of allResults) {
        const list = resultsByInspection.get(r.inspection_id) || [];
        list.push(r);
        resultsByInspection.set(r.inspection_id, list);
      }
      for (const log of logs) {
        log.results = resultsByInspection.get(log.id) || [];
      }
    } else {
      for (const log of logs) {
        log.results = [];
      }
    }

    res.status(200).json(logs);
  } catch (error: any) {
    console.error('[API] Error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function handlePut(req: VercelRequest, res: VercelResponse, user: AuthUser) {
  const { inspectionId, results, photoUrls, notes, mileage, odometerPhotoUrl, vehicleUsable } = req.body;
  const sql = neon(process.env.DATABASE_URL!);

  try {
    if (!inspectionId) {
      return res.status(400).json({ error: 'inspectionId is required' });
    }
    const resultError = validateInspectionResults(results);
    if (resultError) return res.status(400).json({ error: resultError });
    const checklistItemIds = [...new Set(results.map((r: any) => r.checklistItemId).filter(Boolean))];
    const [checklistScope] = await sql`
      SELECT COUNT(*)::int AS count
      FROM checklist_items
      WHERE company_id = ${user.companyId}
        AND id = ANY(${checklistItemIds}::uuid[])
    `;
    if (checklistScope.count !== checklistItemIds.length) {
      return res.status(400).json({ error: 'Invalid checklist item' });
    }

    if (!validatePhotoUrls(photoUrls)) return res.status(400).json({ error: 'Invalid inspection photos' });
    const overallStatus = results.some((r: any) => r.result === 'fail') ? 'fail' : 'pass';
    const photosArray = photoUrls ?? [];
    const mileageNum = validateMileage(mileage) ? mileage : null;
    const odometerUrl = typeof odometerPhotoUrl === 'string' && odometerPhotoUrl ? odometerPhotoUrl : null;
    if (mileageNum === null || odometerUrl === null) {
      return res.status(400).json({ error: 'Mileage and odometer photo are required' });
    }

    // Get existing inspection for audit context
    const [existing] = await sql`
      SELECT inspector_id, inspector_name, vehicle_id, fleet_id, overall_status as old_status
      FROM inspection_logs
      WHERE id = ${inspectionId} AND company_id = ${user.companyId}
    `;
    if (!existing) {
      return res.status(404).json({ error: 'Inspection not found' });
    }

    // Supervisors may complete or correct inspections for their own fleet;
    // drivers remain limited to inspections they originally submitted.
    const canEdit = user.role === 'admin'
      || (user.role === 'supervisor' && existing.fleet_id === user.fleetId)
      || user.userId === existing.inspector_id;
    if (!canEdit) {
      return res.status(403).json({ error: 'Not authorized to edit this inspection' });
    }

    // Update inspection log (vehicle_usable stays NULL for clients that predate the question)
    const usable = typeof vehicleUsable === 'boolean' ? vehicleUsable : null;
    await sql`
      UPDATE inspection_logs
      SET overall_status = ${overallStatus},
          photo_urls = ${photosArray}::text[],
          notes = ${notes || ''},
          mileage = ${mileageNum},
          odometer_photo_url = ${odometerUrl},
          vehicle_usable = ${usable}
      WHERE id = ${inspectionId} AND company_id = ${user.companyId}
    `;

    // Delete old results and re-insert
    await sql`DELETE FROM inspection_results WHERE inspection_id = ${inspectionId}`;

    if (results.length > 0) {
      const rows = results.map((r: any) => ({
        checklist_item_id: r.checklistItemId,
        result: r.result,
        photo_urls: Array.isArray(r.photoUrls) ? r.photoUrls : [],
        notes: r.notes || '',
      }));
      await sql`
        INSERT INTO inspection_results (inspection_id, checklist_item_id, result, photo_urls, notes)
        SELECT ${inspectionId}::uuid, r.checklist_item_id::uuid, r.result, r.photo_urls, r.notes
        FROM json_to_recordset(${JSON.stringify(rows)}::json)
          AS r(checklist_item_id text, result text, photo_urls text[], notes text)
      `;
    }

    const defectPhotoUrls = results
      .filter((r: any) => r.result === 'fail')
      .flatMap((r: any) => Array.isArray(r.photoUrls) ? r.photoUrls : []);
    const issuePhotoUrls = defectPhotoUrls.length > 0 ? defectPhotoUrls : photosArray;

    // Keep one open issue per vehicle, but always create or refresh it when the
    // saved inspection contains a failure. This also repairs inspections that
    // were already marked fail before the issue record was created.
    if (overallStatus === 'fail') {
      const [openIssue] = await sql`
        SELECT id FROM issue_reports
        WHERE vehicle_id = ${existing.vehicle_id}
          AND company_id = ${user.companyId}
          AND status IN ('open', 'in_progress')
        LIMIT 1
      `;
      if (openIssue) {
        await sql`
          UPDATE issue_reports
          SET inspection_id = ${inspectionId},
              defect_photo_urls = ${issuePhotoUrls}::text[],
              updated_at = NOW()
          WHERE id = ${openIssue.id} AND company_id = ${user.companyId}
        `;
      } else {
        await sql`
          INSERT INTO issue_reports (inspection_id, vehicle_id, fleet_id, company_id, defect_photo_urls)
          VALUES (${inspectionId}, ${existing.vehicle_id}, ${existing.fleet_id}, ${user.companyId}, ${issuePhotoUrls}::text[])
        `;
      }
    }

    await logAudit({
      userId: existing.inspector_id,
      username: existing.inspector_name,
      action: 'inspection_updated',
      entityType: 'inspection',
      entityId: inspectionId,
      details: { vehicleId: existing.vehicle_id, overallStatus, previousStatus: existing.old_status },
    });

    res.status(200).json({ inspectionId, overallStatus });
  } catch (error: any) {
    console.error('[API] Error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleDelete(req: VercelRequest, res: VercelResponse, user: AuthUser) {
  const { inspectionId } = req.query;
  if (!inspectionId || typeof inspectionId !== 'string') {
    return res.status(400).json({ error: 'inspectionId is required' });
  }

  const sql = neon(process.env.DATABASE_URL!);

  try {
    const [existing] = await sql`
      SELECT id, inspector_id, inspector_name, vehicle_id, fleet_id
      FROM inspection_logs
      WHERE id = ${inspectionId} AND company_id = ${user.companyId}
    `;
    if (!existing) {
      return res.status(404).json({ error: 'Inspection not found' });
    }

    // Only original inspector or admin can delete
    if (user.role !== 'admin' && user.userId !== existing.inspector_id) {
      return res.status(403).json({ error: 'Not authorized to delete this inspection' });
    }

    // Delete related issue reports first
    await sql`
      DELETE FROM issue_reports
      WHERE inspection_id = ${inspectionId} AND company_id = ${user.companyId}
    `;
    // inspection_results cascade on delete (FK ON DELETE CASCADE)
    await sql`
      DELETE FROM inspection_logs
      WHERE id = ${inspectionId} AND company_id = ${user.companyId}
    `;

    await logAudit({
      userId: user.userId,
      username: user.username,
      action: 'inspection_deleted',
      entityType: 'inspection',
      entityId: inspectionId,
      details: { vehicleId: existing.vehicle_id, inspectorName: existing.inspector_name },
    });

    res.status(200).json({ deleted: true });
  } catch (error: any) {
    console.error('[API] Error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = await verifyAuth(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') return handleGet(req, res, user);
  if (user.role === 'vehicle_owner') return res.status(403).json({ error: 'Vehicle owners have read-only access' });
  if (req.method === 'PUT') return handlePut(req, res, user);
  if (req.method === 'DELETE') return handleDelete(req, res, user);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { vehicleId, inspectionDate, results, photoUrls, notes, frequency, mileage, odometerPhotoUrl, vehicleUsable } = req.body;
  // Derive inspector identity from verified JWT — never trust the client
  const inspectorId = user.userId;
  const inspectorName = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.username;
  const freq = validateInspectionFrequency(frequency) ? frequency : null;
  const mileageNum = validateMileage(mileage) ? mileage : null;
  const odometerUrl = typeof odometerPhotoUrl === 'string' && odometerPhotoUrl ? odometerPhotoUrl : null;
  const sql = neon(process.env.DATABASE_URL!);

  try {
    if (!vehicleId || !validateInspectionDate(inspectionDate) || !freq || !Array.isArray(results)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const resultError = validateInspectionResults(results);
    if (resultError) return res.status(400).json({ error: resultError });
    if (mileageNum === null || odometerUrl === null) {
      return res.status(400).json({ error: 'Mileage and odometer photo are required' });
    }
    if (!validatePhotoUrls(photoUrls)) return res.status(400).json({ error: 'Invalid inspection photos' });
    const overallStatus = results.some((r: any) => r.result === 'fail') ? 'fail' : 'pass';

    const [vehicleScope] = await sql`
      SELECT fleet_id
      FROM vehicle_master
      WHERE id = ${vehicleId} AND company_id = ${user.companyId}
    `;
    if (!vehicleScope || (user.role !== 'admin' && vehicleScope.fleet_id !== user.fleetId)) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }
    const fleetId = vehicleScope.fleet_id as string;
    const checklistItemIds = [...new Set(results.map((r: any) => r.checklistItemId).filter(Boolean))];
    const [checklistScope] = await sql`
      SELECT COUNT(*)::int AS count
      FROM checklist_items
      WHERE company_id = ${user.companyId}
        AND id = ANY(${checklistItemIds}::uuid[])
    `;
    if (checklistScope.count !== checklistItemIds.length) {
      return res.status(400).json({ error: 'Invalid checklist item' });
    }

    // Check for existing inspection (same vehicle + date + frequency)
    const existing = await sql`
      SELECT id, inspector_id, inspector_name FROM inspection_logs
      WHERE vehicle_id = ${vehicleId}
        AND company_id = ${user.companyId}
        AND inspection_date = ${inspectionDate}
        AND frequency = ${freq}
    `;

    if (existing.length > 0) {
      if (existing[0].inspector_id === inspectorId || user.role === 'admin') {
        return res.status(200).json({
          existingInspectionId: existing[0].id,
          message: 'Use PUT to update existing inspection',
        });
      } else {
        return res.status(409).json({
          error: `Already inspected by ${existing[0].inspector_name}`,
        });
      }
    }

    // Create inspection log (vehicle_usable stays NULL for clients that predate the question)
    const usable = typeof vehicleUsable === 'boolean' ? vehicleUsable : null;
    const photosArray = photoUrls ?? [];
    const [log] = await sql`
      INSERT INTO inspection_logs (vehicle_id, inspector_id, inspector_name, fleet_id, company_id, inspection_date, overall_status, photo_urls, notes, frequency, mileage, odometer_photo_url, vehicle_usable)
      VALUES (${vehicleId}, ${inspectorId}, ${inspectorName}, ${fleetId}, ${user.companyId}, ${inspectionDate}, ${overallStatus}, ${photosArray}::text[], ${notes || ''}, ${freq}, ${mileageNum}, ${odometerUrl}, ${usable})
      RETURNING id
    `;

    // Insert all results
    if (results.length > 0) {
      const rows = results.map((r: any) => ({
        checklist_item_id: r.checklistItemId,
        result: r.result,
        photo_urls: Array.isArray(r.photoUrls) ? r.photoUrls : [],
        notes: r.notes || '',
      }));
      await sql`
        INSERT INTO inspection_results (inspection_id, checklist_item_id, result, photo_urls, notes)
        SELECT ${log.id}::uuid, r.checklist_item_id::uuid, r.result, r.photo_urls, r.notes
        FROM json_to_recordset(${JSON.stringify(rows)}::json)
          AS r(checklist_item_id text, result text, photo_urls text[], notes text)
      `;
    }

    let issueId = null;
    if (overallStatus === 'fail') {
      const defectPhotoUrls = results
        .filter((r: any) => r.result === 'fail')
        .flatMap((r: any) => Array.isArray(r.photoUrls) ? r.photoUrls : []);
      const issuePhotoUrls = defectPhotoUrls.length > 0 ? defectPhotoUrls : (photoUrls || []);
      // A vehicle carries at most one open issue: a defect still unresolved on the
      // next inspection keeps its existing report instead of opening (and emailing
      // about) a new one, so the defect counts don't grow day by day.
      const [openIssue] = await sql`
        SELECT id FROM issue_reports
        WHERE vehicle_id = ${vehicleId}
          AND company_id = ${user.companyId}
          AND status IN ('open', 'in_progress')
        LIMIT 1
      `;
      if (openIssue) {
        issueId = openIssue.id;
        await sql`
          UPDATE issue_reports
          SET inspection_id = ${log.id},
              defect_photo_urls = ${issuePhotoUrls}::text[],
              updated_at = NOW()
          WHERE id = ${openIssue.id} AND company_id = ${user.companyId}
        `;
      } else {
        const [issue] = await sql`
          INSERT INTO issue_reports (inspection_id, vehicle_id, fleet_id, company_id, defect_photo_urls)
          VALUES (${log.id}, ${vehicleId}, ${fleetId}, ${user.companyId}, ${issuePhotoUrls}::text[])
          RETURNING id
        `;
        issueId = issue.id;

        // Send email notification to fleet manager (non-blocking)
        try {
          const [vehicle] = await sql`
            SELECT plate_number, vehicle_type, fleet_manager_email
            FROM vehicle_master
            WHERE id = ${vehicleId} AND company_id = ${user.companyId}
          `;

          if (vehicle?.fleet_manager_email) {
            // Build per-item failure details with names (from DB), notes, and photos
            const failedResults = results.filter((r: any) => r.result === 'fail');
            const failedItemIds = failedResults.map((r: any) => r.checklistItemId);

            const failedChecklist = await sql`
              SELECT id, item_name_en FROM checklist_items
              WHERE id = ANY(${failedItemIds}::uuid[])
                AND company_id = ${user.companyId}
            `;
            const nameById = new Map<string, string>(
              failedChecklist.map((c: any) => [c.id, c.item_name_en])
            );

            const failedItems = failedResults.map((r: any) => ({
              name: nameById.get(r.checklistItemId) || 'Unknown item',
              notes: r.notes || '',
              photoUrls: Array.isArray(r.photoUrls) ? r.photoUrls : [],
            }));

            await sendInspectionFailEmail({
              to: vehicle.fleet_manager_email,
              plateNumber: vehicle.plate_number,
              vehicleType: vehicle.vehicle_type,
              fleetId,
              inspectorName,
              inspectionDate,
              failedItems,
              photoUrls: photoUrls || [],
            });
          }
        } catch (emailErr: any) {
          console.warn('[Email] Failed to send inspection fail email:', emailErr.message);
        }
      }
    }

    await logAudit({
      userId: inspectorId,
      username: inspectorName,
      action: 'inspection_created',
      entityType: 'inspection',
      entityId: log.id,
      details: { vehicleId, overallStatus, inspectionDate },
    });

    res.status(201).json({ inspectionId: log.id, overallStatus, issueId });
  } catch (error: any) {
    console.error('[API] Error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}
