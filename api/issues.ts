import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import { getOwnerVehicleIds } from '../lib/vehicle-access';
import { verifyAuth } from '../lib/api-auth';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { status, fleetId, search } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
  const sql = neon(process.env.DATABASE_URL!);

  try {
    const s = status as string | undefined;
    // Fleet scope is enforced here, not by RLS (the DATABASE_URL role bypasses it):
    // drivers/supervisors are fleet-bound; owners additionally require explicit vehicle grants.
    const isAdmin = user.role === 'admin';
    const isOwner = user.role === 'vehicle_owner';
    const f = (isAdmin || isOwner) ? (fleetId as string | undefined) : (user.fleetId || undefined);
    if (!isAdmin && !isOwner && !f) return res.status(403).json({ error: 'Forbidden' });
    const ownerVehicleIds = await getOwnerVehicleIds(sql, user);
    const q = search ? `%${search as string}%` : undefined;

    let issues;
    if (s && f && q) {
      issues = await sql`
        SELECT ir.*, vm.plate_number, vm.vehicle_type, vm.fleet_id as vehicle_fleet,
          il.inspector_name, il.inspection_date
        FROM issue_reports ir
        JOIN vehicle_master vm ON vm.id = ir.vehicle_id
        LEFT JOIN inspection_logs il ON il.id = ir.inspection_id AND il.company_id = ir.company_id AND il.vehicle_id = ir.vehicle_id
        WHERE ir.company_id = ${user.companyId}
          AND vm.company_id = ${user.companyId}
          AND (${ownerVehicleIds}::uuid[] IS NULL OR vm.id = ANY(${ownerVehicleIds}::uuid[])) AND ir.status = ${s} AND vm.fleet_id = ${f}
          AND (vm.plate_number ILIKE ${q} OR vm.fleet_id ILIKE ${q})
        ORDER BY ir.updated_at DESC NULLS LAST, ir.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    } else if (s && f) {
      issues = await sql`
        SELECT ir.*, vm.plate_number, vm.vehicle_type, vm.fleet_id as vehicle_fleet,
          il.inspector_name, il.inspection_date
        FROM issue_reports ir
        JOIN vehicle_master vm ON vm.id = ir.vehicle_id
        LEFT JOIN inspection_logs il ON il.id = ir.inspection_id AND il.company_id = ir.company_id AND il.vehicle_id = ir.vehicle_id
        WHERE ir.company_id = ${user.companyId}
          AND vm.company_id = ${user.companyId}
          AND (${ownerVehicleIds}::uuid[] IS NULL OR vm.id = ANY(${ownerVehicleIds}::uuid[])) AND ir.status = ${s} AND vm.fleet_id = ${f}
        ORDER BY ir.updated_at DESC NULLS LAST, ir.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    } else if (s && q) {
      issues = await sql`
        SELECT ir.*, vm.plate_number, vm.vehicle_type, vm.fleet_id as vehicle_fleet,
          il.inspector_name, il.inspection_date
        FROM issue_reports ir
        JOIN vehicle_master vm ON vm.id = ir.vehicle_id
        LEFT JOIN inspection_logs il ON il.id = ir.inspection_id AND il.company_id = ir.company_id AND il.vehicle_id = ir.vehicle_id
        WHERE ir.company_id = ${user.companyId}
          AND vm.company_id = ${user.companyId}
          AND (${ownerVehicleIds}::uuid[] IS NULL OR vm.id = ANY(${ownerVehicleIds}::uuid[])) AND ir.status = ${s} AND (vm.plate_number ILIKE ${q} OR vm.fleet_id ILIKE ${q})
        ORDER BY ir.updated_at DESC NULLS LAST, ir.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    } else if (f && q) {
      issues = await sql`
        SELECT ir.*, vm.plate_number, vm.vehicle_type, vm.fleet_id as vehicle_fleet,
          il.inspector_name, il.inspection_date
        FROM issue_reports ir
        JOIN vehicle_master vm ON vm.id = ir.vehicle_id
        LEFT JOIN inspection_logs il ON il.id = ir.inspection_id AND il.company_id = ir.company_id AND il.vehicle_id = ir.vehicle_id
        WHERE ir.company_id = ${user.companyId}
          AND vm.company_id = ${user.companyId}
          AND (${ownerVehicleIds}::uuid[] IS NULL OR vm.id = ANY(${ownerVehicleIds}::uuid[])) AND vm.fleet_id = ${f} AND (vm.plate_number ILIKE ${q} OR vm.fleet_id ILIKE ${q})
        ORDER BY ir.updated_at DESC NULLS LAST, ir.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    } else if (s) {
      issues = await sql`
        SELECT ir.*, vm.plate_number, vm.vehicle_type, vm.fleet_id as vehicle_fleet,
          il.inspector_name, il.inspection_date
        FROM issue_reports ir
        JOIN vehicle_master vm ON vm.id = ir.vehicle_id
        LEFT JOIN inspection_logs il ON il.id = ir.inspection_id AND il.company_id = ir.company_id AND il.vehicle_id = ir.vehicle_id
        WHERE ir.company_id = ${user.companyId}
          AND vm.company_id = ${user.companyId}
          AND (${ownerVehicleIds}::uuid[] IS NULL OR vm.id = ANY(${ownerVehicleIds}::uuid[])) AND ir.status = ${s}
        ORDER BY ir.updated_at DESC NULLS LAST, ir.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    } else if (f) {
      issues = await sql`
        SELECT ir.*, vm.plate_number, vm.vehicle_type, vm.fleet_id as vehicle_fleet,
          il.inspector_name, il.inspection_date
        FROM issue_reports ir
        JOIN vehicle_master vm ON vm.id = ir.vehicle_id
        LEFT JOIN inspection_logs il ON il.id = ir.inspection_id AND il.company_id = ir.company_id AND il.vehicle_id = ir.vehicle_id
        WHERE ir.company_id = ${user.companyId}
          AND vm.company_id = ${user.companyId}
          AND (${ownerVehicleIds}::uuid[] IS NULL OR vm.id = ANY(${ownerVehicleIds}::uuid[])) AND vm.fleet_id = ${f}
        ORDER BY ir.updated_at DESC NULLS LAST, ir.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    } else if (q) {
      issues = await sql`
        SELECT ir.*, vm.plate_number, vm.vehicle_type, vm.fleet_id as vehicle_fleet,
          il.inspector_name, il.inspection_date
        FROM issue_reports ir
        JOIN vehicle_master vm ON vm.id = ir.vehicle_id
        LEFT JOIN inspection_logs il ON il.id = ir.inspection_id AND il.company_id = ir.company_id AND il.vehicle_id = ir.vehicle_id
        WHERE ir.company_id = ${user.companyId}
          AND vm.company_id = ${user.companyId}
          AND (${ownerVehicleIds}::uuid[] IS NULL OR vm.id = ANY(${ownerVehicleIds}::uuid[]))
          AND (vm.plate_number ILIKE ${q} OR vm.fleet_id ILIKE ${q})
        ORDER BY ir.updated_at DESC NULLS LAST, ir.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    } else {
      issues = await sql`
        SELECT ir.*, vm.plate_number, vm.vehicle_type, vm.fleet_id as vehicle_fleet,
          il.inspector_name, il.inspection_date
        FROM issue_reports ir
        JOIN vehicle_master vm ON vm.id = ir.vehicle_id
        LEFT JOIN inspection_logs il ON il.id = ir.inspection_id AND il.company_id = ir.company_id AND il.vehicle_id = ir.vehicle_id
        WHERE ir.company_id = ${user.companyId}
          AND vm.company_id = ${user.companyId}
          AND (${ownerVehicleIds}::uuid[] IS NULL OR vm.id = ANY(${ownerVehicleIds}::uuid[]))
        ORDER BY ir.updated_at DESC NULLS LAST, ir.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    }

    // The linked failed inspection is the source of truth for defect evidence.
    // Backfill the response from its failed checklist results so an older or
    // previously refreshed issue row cannot hide photos from the latest fail.
    // Keep the checklist result records too so clients can identify which
    // checklist item each defect photo belongs to.
    const inspectionIds = issues.map((issue: any) => issue.inspection_id).filter(Boolean);
    if (inspectionIds.length > 0) {
      const failedEvidence = await sql`
        WITH failed_items AS (
          SELECT ir.inspection_id, ir.checklist_item_id, ir.photo_urls, ir.notes,
                 ci.item_name_th, ci.item_name_en, ci.section, ci.sort_order
          FROM inspection_results ir
          JOIN inspection_logs inspection ON inspection.id = ir.inspection_id
            AND inspection.company_id = ${user.companyId}
          JOIN checklist_items ci ON ci.id = ir.checklist_item_id
          WHERE ir.inspection_id = ANY(${inspectionIds}::uuid[])
            AND (${ownerVehicleIds}::uuid[] IS NULL OR inspection.vehicle_id = ANY(${ownerVehicleIds}::uuid[]))
            AND ir.result = 'fail'
            AND ci.company_id = ${user.companyId}
        ),
        failed_photos AS (
          SELECT ir.inspection_id,
                 ARRAY_AGG(photo_url ORDER BY ir.sort_order, ir.checklist_item_id, photo_order) AS defect_photo_urls
          FROM failed_items ir
          CROSS JOIN LATERAL unnest(ir.photo_urls) WITH ORDINALITY AS photo(photo_url, photo_order)
          GROUP BY ir.inspection_id
        )
        SELECT ir.inspection_id,
               JSONB_AGG(
                 JSONB_BUILD_OBJECT(
                   'checklist_item_id', ir.checklist_item_id,
                   'item_name_th', ir.item_name_th,
                   'item_name_en', ir.item_name_en,
                   'section', ir.section,
                   'notes', ir.notes,
                   'photo_urls', ir.photo_urls
                 )
                 ORDER BY ir.sort_order, ir.checklist_item_id
               ) AS failed_checklist_items,
               fp.defect_photo_urls
        FROM failed_items ir
        LEFT JOIN failed_photos fp ON fp.inspection_id = ir.inspection_id
        GROUP BY ir.inspection_id, fp.defect_photo_urls
      `;
      const evidenceByInspection = new Map<string, any>(
        failedEvidence.map((row: any) => [row.inspection_id, row]),
      );
      for (const issue of issues) {
        const evidence = evidenceByInspection.get(issue.inspection_id);
        if (evidence?.defect_photo_urls?.length) issue.defect_photo_urls = evidence.defect_photo_urls;
        issue.failed_checklist_items = evidence?.failed_checklist_items || [];
      }
    }
    res.status(200).json({ issues, limit, offset });
  } catch (error: any) {
    console.error('[API] Error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}
