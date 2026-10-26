import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import { verifyAuth } from '../../lib/api-auth';
import { isNonEmptyString } from '../../lib/validate';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { firstName, lastName } = req.body;
  const validLastName = user.role === 'vehicle_owner'
    ? typeof lastName === 'string' && lastName.trim().length <= 100
    : isNonEmptyString(lastName, 100);
  if (!isNonEmptyString(firstName, 100) || !validLastName) {
    return res.status(400).json({ error: 'First name and last name required' });
  }

  const sql = neon(process.env.DATABASE_URL!);

  try {
    const [updated] = await sql`
      UPDATE users SET first_name = ${firstName.trim()}, last_name = ${lastName.trim()}, updated_at = NOW()
      WHERE id = ${user.userId} AND company_id = ${user.companyId}
      RETURNING id, username, first_name, last_name, role, fleet_id, company_id
    `;
    if (!updated) return res.status(404).json({ error: 'User not found' });

    res.status(200).json({
      id: updated.id,
      username: updated.username,
      firstName: updated.first_name,
      lastName: updated.last_name,
      role: updated.role,
      fleetId: updated.fleet_id,
      companyId: updated.company_id,
      companySlug: user.companySlug,
      companyName: user.companyName,
    });
  } catch (error: any) {
    console.error('[API] Profile update error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}
