import type { VercelRequest } from '@vercel/node';
import jwt from 'jsonwebtoken';
import { neon } from '@neondatabase/serverless';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET environment variable is not set');
}

export const BCRYPT_ROUNDS = 12;
export const JWT_EXPIRY = '7d';

export type AuthUser = {
  userId: string;
  username: string;
  role: 'driver' | 'supervisor' | 'admin' | 'vehicle_owner';
  fleetId: string;
  companyId: string;
  companySlug: string;
  companyName: string;
  firstName?: string;
  lastName?: string;
};

export function getJwtSecret(): string {
  if (!JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return JWT_SECRET;
}

export function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: JWT_EXPIRY });
}

export async function verifyAuth(req: VercelRequest): Promise<AuthUser | null> {
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || !/^Bearer\s+\S+$/i.test(authorization)) return null;
  const token = authorization.replace(/^Bearer\s+/i, '');

  try {
    const payload = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as any;
    // Tokens issued before the SVIS tenancy migration are intentionally invalidated.
    // This prevents an unscoped legacy session from ever falling through to all companies.
    if (!payload.companyId || !payload.userId) return null;
    // Roles and fleet assignments can change while a seven-day token is live.
    // Resolve them from the current active account so a demoted/disabled owner
    // cannot keep privileges from a stale JWT, including through token refresh.
    const sql = neon(process.env.DATABASE_URL!);
    const [current] = await sql`
      SELECT u.id, u.username, u.first_name, u.last_name, u.role, u.fleet_id,
             u.company_id, c.slug AS company_slug, c.name AS company_name
      FROM users u JOIN companies c ON c.id = u.company_id
      WHERE u.id = ${payload.userId} AND u.company_id = ${payload.companyId}
        AND u.is_active AND c.is_active
    `;
    if (!current || !['driver', 'supervisor', 'admin', 'vehicle_owner'].includes(current.role)) return null;
    return {
      userId: current.id,
      username: current.username,
      role: current.role,
      fleetId: current.fleet_id || '',
      companyId: current.company_id,
      companySlug: current.company_slug,
      companyName: current.company_name,
      firstName: current.first_name,
      lastName: current.last_name,
    };
  } catch {
    return null;
  }
}
