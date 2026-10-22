import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { AuthUser } from './api-auth';

export const EXPORT_TICKET_TTL_SECONDS = 5 * 60;
export const MAX_OUTSTANDING_EXPORT_TICKETS = 10;

const TICKET_ISSUER = 'svis';
const TICKET_AUDIENCE = 'dashboard-export-download';
const TICKET_PURPOSE = 'dashboard-export';
const KEY_CONTEXT = 'SVIS/export-download-ticket/key/v1';
const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'svis-export-ticket', v: 1 })).toString('base64url');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ExportScope = {
  userId: string;
  companyId: string;
  fleetIds: string[];
  dateStart?: string;
  dateEnd?: string;
};

type TicketDatabase = Pick<NeonQueryFunction<false, false>, 'query' | 'transaction'>;

export class ExportRequestError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ExportRequestError';
  }
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ExportRequestError(400, `Invalid ${key}`);
  return value;
}

function validDate(value: string | undefined, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) {
    throw new ExportRequestError(400, `Invalid ${key}; use YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ExportRequestError(400, `Invalid ${key}; use a real calendar date`);
  }
  return value;
}

function validFleet(fleet: string): boolean {
  return fleet.length > 0 && fleet.length <= 128 && !/[\u0000-\u001f\u007f]/.test(fleet);
}

/** Resolve every authorization-sensitive filter before issuing a capability. */
export function resolveExportScope(user: AuthUser, input: unknown): ExportScope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ExportRequestError(400, 'Invalid export filters');
  }
  if (!UUID.test(user.userId) || !UUID.test(user.companyId)
    || !['admin', 'supervisor', 'driver'].includes(user.role)) {
    throw new ExportRequestError(401, 'Unauthorized');
  }
  const fields = input as Record<string, unknown>;
  const fleetId = optionalString(fields, 'fleetId');
  if (fleetId !== undefined && fleetId.length > 4096) {
    throw new ExportRequestError(400, 'Too many fleet filters');
  }
  let fleetIds = [...new Set((fleetId || '').split(',').map((id) => id.trim()).filter(Boolean))];
  if (fleetIds.length > 100 || fleetIds.some((id) => !validFleet(id))) {
    throw new ExportRequestError(400, 'Invalid fleet filters');
  }
  if (user.role !== 'admin') {
    if (typeof user.fleetId !== 'string' || !validFleet(user.fleetId) || !user.fleetId.trim()) {
      throw new ExportRequestError(403, 'A fleet assignment is required to export reports');
    }
    // A requested fleet never expands a non-admin's authenticated fleet scope.
    fleetIds = [user.fleetId];
  }
  const dateStart = validDate(optionalString(fields, 'dateStart'), 'dateStart');
  const dateEnd = validDate(optionalString(fields, 'dateEnd'), 'dateEnd');
  if (dateStart && dateEnd && dateStart > dateEnd) {
    throw new ExportRequestError(400, 'dateStart must not be after dateEnd');
  }
  return { userId: user.userId, companyId: user.companyId, fleetIds, dateStart, dateEnd };
}

function signature(value: string, sessionSecret: string): Buffer {
  if (!sessionSecret) throw new Error('Export ticket signing is not configured');
  // Domain separation prevents a download capability from being a session JWT.
  const key = createHmac('sha256', sessionSecret).update(KEY_CONTEXT).digest();
  return createHmac('sha256', new Uint8Array(key)).update(value).digest();
}

function invalidTicket(): ExportRequestError {
  return new ExportRequestError(410, 'Download link is invalid, expired, or already used. Request a new export.');
}

export function signExportTicket(sessionSecret: string, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + EXPORT_TICKET_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({
    iss: TICKET_ISSUER,
    aud: TICKET_AUDIENCE,
    purpose: TICKET_PURPOSE,
    jti: randomBytes(32).toString('base64url'),
    iat: issuedAt,
    exp: expiresAt,
  })).toString('base64url');
  const unsigned = `${HEADER}.${payload}`;
  const token = `${unsigned}.${signature(unsigned, sessionSecret).toString('base64url')}`;
  return {
    token,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

/** Validate the fixed token envelope before consulting the ticket store. */
export function verifyExportTicket(token: unknown, sessionSecret: string, now = Date.now()): string {
  if (typeof token !== 'string' || token.length > 1024) throw invalidTicket();
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER || !/^[A-Za-z0-9_-]+$/.test(parts[1])
    || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) throw invalidTicket();
  const supplied = Buffer.from(parts[2], 'base64url');
  const expected = signature(`${parts[0]}.${parts[1]}`, sessionSecret);
  if (supplied.length !== expected.length || supplied.toString('base64url') !== parts[2]
    || !timingSafeEqual(new Uint8Array(supplied), new Uint8Array(expected))) throw invalidTicket();
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw invalidTicket();
  }
  const seconds = Math.floor(now / 1000);
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)
    || claims.iss !== TICKET_ISSUER || claims.aud !== TICKET_AUDIENCE || claims.purpose !== TICKET_PURPOSE
    || typeof claims.jti !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(claims.jti)
    || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)
    || (claims.iat as number) > seconds || (claims.exp as number) <= seconds
    || (claims.exp as number) - (claims.iat as number) !== EXPORT_TICKET_TTL_SECONDS) throw invalidTicket();
  return createHash('sha256').update(token).digest('hex');
}

export async function issueExportTicket(
  sql: TicketDatabase, scope: ExportScope, sessionSecret: string, now = Date.now(),
): Promise<{ downloadUrl: string; expiresAt: string }> {
  const ticket = signExportTicket(sessionSecret, now);
  // Serialize issuance per user. The subsequent statements receive fresh
  // READ COMMITTED snapshots, so concurrent issuers cannot exceed the cap.
  const [, owners, , inserted] = await sql.transaction([
    sql.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED', []),
    sql.query('SELECT id FROM users WHERE id = $1::uuid AND company_id = $2::uuid FOR UPDATE',
      [scope.userId, scope.companyId]),
    sql.query(`DELETE FROM export_download_tickets
      WHERE user_id = $1::uuid AND company_id = $2::uuid AND expires_at <= CURRENT_TIMESTAMP`,
    [scope.userId, scope.companyId]),
    sql.query(`INSERT INTO export_download_tickets
      (token_hash, user_id, company_id, fleet_ids, date_start, date_end, expires_at)
      SELECT $1, $2::uuid, $3::uuid, $4::text[], $5::date, $6::date, $7::timestamptz
      WHERE EXISTS (SELECT 1 FROM users WHERE id = $2::uuid AND company_id = $3::uuid)
        AND (SELECT COUNT(*) FROM export_download_tickets
             WHERE user_id = $2::uuid AND company_id = $3::uuid
               AND expires_at > CURRENT_TIMESTAMP) < $8
      RETURNING token_hash`,
    [ticket.tokenHash, scope.userId, scope.companyId, scope.fleetIds,
      scope.dateStart ?? null, scope.dateEnd ?? null, ticket.expiresAt, MAX_OUTSTANDING_EXPORT_TICKETS]),
  ]);
  if (owners.length === 0) throw new ExportRequestError(401, 'Unauthorized');
  if (inserted.length === 0) {
    throw new ExportRequestError(429, 'Too many pending export downloads. Use an existing link or try again in five minutes.');
  }
  return {
    downloadUrl: `/api/dashboard/export?downloadTicket=${encodeURIComponent(ticket.token)}`,
    expiresAt: ticket.expiresAt,
  };
}

export async function redeemExportTicket(
  sql: TicketDatabase, token: unknown, sessionSecret: string, now = Date.now(),
): Promise<ExportScope> {
  const tokenHash = verifyExportTicket(token, sessionSecret, now);
  // A single atomic statement permits exactly one concurrent GET to redeem.
  // An aborted generation/transfer needs a new ticket; HEAD never reaches here.
  const rows = await sql.query(`DELETE FROM export_download_tickets
    WHERE token_hash = $1 AND expires_at > CURRENT_TIMESTAMP
    RETURNING user_id::text AS user_id, company_id::text AS company_id,
              fleet_ids, date_start::text AS date_start, date_end::text AS date_end`, [tokenHash]);
  if (rows.length !== 1) throw invalidTicket();
  const row = rows[0];
  if (!UUID.test(row.user_id) || !UUID.test(row.company_id) || !Array.isArray(row.fleet_ids)
    || row.fleet_ids.length > 100 || row.fleet_ids.some((id: unknown) => typeof id !== 'string' || !validFleet(id))) {
    throw invalidTicket();
  }
  return {
    userId: row.user_id,
    companyId: row.company_id,
    fleetIds: row.fleet_ids,
    dateStart: row.date_start ?? undefined,
    dateEnd: row.date_end ?? undefined,
  };
}
