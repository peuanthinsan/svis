import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import { requireAdmin } from '../../../lib/admin-auth';
import { BCRYPT_ROUNDS } from '../../../lib/api-auth';
import { isNonEmptyString, isUUID, MIN_PASSWORD_LENGTH } from '../../../lib/validate';
import { ADMIN_USER_ROLES, OwnerVehicleAssignmentError, updateAccountWithVehicles } from '../../../lib/owner-vehicle-assignment';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { id } = req.query;
  if (!isUUID(id)) {
    return res.status(400).json({ error: 'Valid user ID required' });
  }

  const sql = neon(process.env.DATABASE_URL!);

  if (req.method === 'PUT') {
    const { firstName, lastName, role, fleetId, password, vehicleIds } = req.body || {};
    if (role !== undefined && !(ADMIN_USER_ROLES as readonly string[]).includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    const validLastName = role === 'vehicle_owner'
      ? typeof lastName === 'string' && lastName.length <= 100
      : isNonEmptyString(lastName, 100);
    if ((firstName !== undefined && !isNonEmptyString(firstName, 100))
      || (lastName !== undefined && !validLastName)) {
      return res.status(400).json({ error: 'Invalid name: first name is required; last name is required except for vehicle owners (maximum 100 characters each)' });
    }
    if (fleetId !== undefined && (typeof fleetId !== 'string' || fleetId.length > 128)) {
      return res.status(400).json({ error: 'Invalid fleet ID' });
    }
    try {
      let passwordHash: string | undefined;
      if (password) {
        if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > 200) {
          return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
        }
        passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      }
      const user = await updateAccountWithVehicles(sql, admin.companyId, id, {
        firstName, lastName, role, fleetId, passwordHash, vehicleIds,
      });
      return res.status(200).json(user);
    } catch (error: any) {
      if (error instanceof OwnerVehicleAssignmentError) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error('[API] Error:', error.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const result = await sql`
        DELETE FROM users
        WHERE id = ${id} AND company_id = ${admin.companyId}
        RETURNING id
      `;
      if (result.length === 0) return res.status(404).json({ error: 'User not found' });
      return res.status(200).json({ deleted: true });
    } catch (error: any) {
      console.error('[API] Error:', error.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
