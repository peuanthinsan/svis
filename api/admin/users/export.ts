import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import ExcelJS from 'exceljs';
import { requireAdmin } from '../../../lib/admin-auth';
import { ADMIN_USER_ROLES } from '../../../lib/owner-vehicle-assignment';

const VALID_ROLES = new Set<string>(ADMIN_USER_ROLES);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const role = typeof req.query.role === 'string' ? req.query.role : '';
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  if (role && !VALID_ROLES.has(role)) return res.status(400).json({ error: 'Invalid role' });

  try {
    const sql = neon(process.env.DATABASE_URL!);
    const pattern = `%${search}%`;
    const users = await sql`
      SELECT username, first_name, last_name, role, fleet_id, created_at
      FROM users
      WHERE company_id = ${admin.companyId}
        AND (${role || null}::text IS NULL OR role = ${role})
        AND (${search || null}::text IS NULL OR username ILIKE ${pattern} OR first_name ILIKE ${pattern} OR last_name ILIKE ${pattern} OR fleet_id ILIKE ${pattern})
      ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'supervisor' THEN 1 ELSE 2 END, first_name, id
    `;

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Users');
    sheet.columns = [
      { header: 'Username', key: 'username', width: 28 },
      { header: 'First Name', key: 'first_name', width: 20 },
      { header: 'Last Name', key: 'last_name', width: 24 },
      { header: 'Role', key: 'role', width: 16 },
      { header: 'Fleet ID', key: 'fleet_id', width: 18 },
      { header: 'Created At', key: 'created_at', width: 24 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const user of users) sheet.addRow(user);
    sheet.getColumn('created_at').numFmt = 'yyyy-mm-dd hh:mm';

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="users.xlsx"');
    return res.status(200).send(Buffer.from(buffer));
  } catch (error: any) {
    console.error('[API] User export error:', error.message);
    return res.status(500).json({ error: 'Export failed' });
  }
}
