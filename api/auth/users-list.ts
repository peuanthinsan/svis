import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const companySlug = typeof req.query.company === 'string' ? req.query.company : 'dhl';
  const sql = neon(process.env.DATABASE_URL!);
  try {
    const rows = await sql`
      SELECT u.username, u.first_name, u.last_name, u.first_name || ' ' || u.last_name AS name, u.role
      FROM users u JOIN companies c ON c.id = u.company_id
      WHERE u.is_active AND c.is_active AND c.slug = ${companySlug}
      ORDER BY first_name, last_name
    `;
    const drivers: string[] = [];
    const staff: string[] = [];
    const driverAccounts: Array<{ username: string; displayName: string; role: 'driver' }> = [];
    const staffAccounts: Array<{ username: string; displayName: string; role: 'supervisor' | 'admin' | 'vehicle_owner' }> = [];
    for (const row of rows) {
      const name = String(row.name || '').trim();
      if (!name) continue;
      if (row.role === 'driver') {
        drivers.push(name);
        driverAccounts.push({ username: row.username as string, displayName: name, role: 'driver' });
      } else if (row.role === 'supervisor' || row.role === 'admin' || row.role === 'vehicle_owner') {
        staff.push(name);
        staffAccounts.push({ username: row.username as string, displayName: name, role: row.role });
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ drivers, staff, driverAccounts, staffAccounts });
  } catch (error: any) {
    console.error('[API] User list error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
