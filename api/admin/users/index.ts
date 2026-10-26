import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import { requireAdmin } from '../../../lib/admin-auth';
import { BCRYPT_ROUNDS } from '../../../lib/api-auth';
import { isNonEmptyString, MIN_PASSWORD_LENGTH } from '../../../lib/validate';
import { ADMIN_USER_ROLES, createAccountWithVehicles, OwnerVehicleAssignmentError } from '../../../lib/owner-vehicle-assignment';

const VALID_ROLES: readonly string[] = ADMIN_USER_ROLES;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const sql = neon(process.env.DATABASE_URL!);

  if (req.method === 'GET') {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
      const offset = parseInt(req.query.offset as string) || 0;
      const { search, role } = req.query;
      if (role && !VALID_ROLES.includes(role as string)) {
        return res.status(400).json({ error: 'Invalid role' });
      }
      let users;
      if (search && role) {
        const pattern = `%${search as string}%`;
        users = await sql`
          SELECT id, username, first_name, last_name, role, fleet_id, created_at
          FROM users
          WHERE company_id = ${admin.companyId}
            AND role = ${role as string}
            AND (username ILIKE ${pattern} OR first_name ILIKE ${pattern} OR last_name ILIKE ${pattern} OR fleet_id ILIKE ${pattern})
          ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'supervisor' THEN 1 ELSE 2 END, first_name, id
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (search) {
        const pattern = `%${search as string}%`;
        users = await sql`
          SELECT id, username, first_name, last_name, role, fleet_id, created_at
          FROM users
          WHERE company_id = ${admin.companyId}
            AND (username ILIKE ${pattern} OR first_name ILIKE ${pattern} OR last_name ILIKE ${pattern} OR fleet_id ILIKE ${pattern})
          ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'supervisor' THEN 1 ELSE 2 END, first_name, id
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (role) {
        users = await sql`
          SELECT id, username, first_name, last_name, role, fleet_id, created_at
          FROM users
          WHERE company_id = ${admin.companyId} AND role = ${role as string}
          ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'supervisor' THEN 1 ELSE 2 END, first_name, id
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else {
        users = await sql`
          SELECT id, username, first_name, last_name, role, fleet_id, created_at
          FROM users
          WHERE company_id = ${admin.companyId}
          ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'supervisor' THEN 1 ELSE 2 END, first_name, id
          LIMIT ${limit} OFFSET ${offset}
        `;
      }
      return res.status(200).json(users);
    } catch (error: any) {
      console.error('[API] Error:', error.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'POST') {
    const { username, password, firstName, lastName, role, fleetId, vehicleIds } = req.body || {};
    const validLastName = role === 'vehicle_owner'
      ? lastName === undefined || (typeof lastName === 'string' && lastName.length <= 100)
      : isNonEmptyString(lastName, 100);
    if (!isNonEmptyString(username, 50) || !isNonEmptyString(password, 200) ||
        !isNonEmptyString(firstName, 100) || !validLastName || !role) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    if (fleetId !== undefined && (typeof fleetId !== 'string' || fleetId.length > 128)) {
      return res.status(400).json({ error: 'Invalid fleet ID' });
    }
    try {
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const user = await createAccountWithVehicles(sql, admin.companyId, {
        username, passwordHash, firstName, lastName: lastName ?? '', role, fleetId, vehicleIds,
      });
      return res.status(201).json(user);
    } catch (error: any) {
      if (error instanceof OwnerVehicleAssignmentError) {
        return res.status(error.status).json({ error: error.message });
      }
      if (error.message?.includes('unique')) {
        return res.status(409).json({ error: 'Username already exists' });
      }
      console.error('[API] Error:', error.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
