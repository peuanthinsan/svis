import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import ExcelJS from 'exceljs';
import bcrypt from 'bcryptjs';
import { requireAdmin } from '../../../lib/admin-auth';
import { BCRYPT_ROUNDS, AuthUser } from '../../../lib/api-auth';
import { logAudit } from '../../../lib/audit';
import { ADMIN_USER_ROLES } from '../../../lib/owner-vehicle-assignment';

export const config = { api: { bodyParser: false } };

const MAX_IMPORT_SIZE = 5 * 1024 * 1024;
const VALID_ROLES = new Set<string>(ADMIN_USER_ROLES);
type Mode = 'add' | 'modify' | 'replace';
type ImportRow = { username: string; firstName: string; lastName: string; role: string; fleetId: string; password?: string; sourceRow: number };
type ExistingUser = { id: string; username: string; first_name: string; last_name: string; role: string; fleet_id: string; is_active: boolean };

function text(value: unknown): string {
  if (value && typeof value === 'object' && 'text' in value) return String((value as { text: unknown }).text || '').trim();
  return String(value ?? '').trim();
}

function key(value: unknown): string { return text(value).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function usernameFor(name: string): string { return name.toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''); }
function splitName(name: string): [string, string] { const parts = name.trim().split(/\s+/).filter(Boolean); return [parts.shift() || '', parts.join(' ')]; }
function roleFor(value: string): string {
  if (key(value) === 'vehicleowner') return 'vehicle_owner';
  if (/^admin\s*-\s*co$/i.test(value)) return 'admin';
  if (/^admin\s*-\s*/i.test(value)) return 'supervisor';
  return value.toLowerCase() === 'user' ? 'driver' : value.toLowerCase();
}

function getColumn(headers: Map<string, number>, names: string[]): number | undefined {
  for (const name of names) { const found = headers.get(key(name)); if (found) return found; }
  return undefined;
}

function rowIsStruck(row: ExcelJS.Row, columns: number[]): boolean {
  const populated = columns.filter((column) => text(row.getCell(column).value));
  return populated.length > 0 && populated.every((column) => row.getCell(column).font?.strike === true);
}

async function readBody(req: VercelRequest): Promise<{ data: Buffer; filename: string }> {
  const chunks: any[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.from(chunk as Uint8Array);
    size += part.length;
    if (size > MAX_IMPORT_SIZE) throw new Error('Import file is too large (maximum 5 MB)');
    chunks.push(part);
  }
  const body = Buffer.concat(chunks as any);
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.includes('multipart/form-data')) return { data: body, filename: String(req.query.filename || 'import.csv') };
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
  if (!boundary) throw new Error('Missing multipart boundary');
  const binary = body.toString('binary');
  const marker = `--${boundary}`;
  for (const part of binary.split(marker)) {
    if (!part.includes('filename=')) continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const header = part.slice(0, headerEnd);
    const filename = header.match(/filename="([^"]*)"/i)?.[1] || 'import.csv';
    const content = part.slice(headerEnd + 4).replace(/\r\n--$/, '');
    return { data: Buffer.from(content, 'binary'), filename };
  }
  throw new Error('No import file found');
}

async function parseRows(data: Buffer, filename: string): Promise<{ rows: ImportRow[]; skippedStruck: number }> {
  const rows: ImportRow[] = [];
  let skippedStruck = 0;
  const isXlsx = filename.toLowerCase().endsWith('.xlsx') || data.subarray(0, 2).toString() === 'PK';
  if (isXlsx) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(data as any);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error('Workbook has no worksheets');
    const headers = new Map<string, number>();
    sheet.getRow(1).eachCell((cell, column) => headers.set(key(cell.value), column));
    const usernameCol = getColumn(headers, ['username', 'user name', 'login']);
    const firstCol = getColumn(headers, ['first name', 'firstname']);
    const lastCol = getColumn(headers, ['last name', 'lastname', 'surname']);
    const nameCol = getColumn(headers, ['name', 'employee name', 'name - surname']);
    const emailCol = getColumn(headers, ['email', 'e-mail', 'email address']);
    const roleCol = getColumn(headers, ['role', 'position']);
    const fleetCol = getColumn(headers, ['fleet', 'fleet id', 'service center', 'sub section']);
    const passwordCol = getColumn(headers, ['password', 'pw']);
    if ((!usernameCol && !nameCol && !emailCol) || !roleCol) throw new Error('Required columns: Username (or Name/Email) and Role');
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      let hasValues = false;
      row.eachCell((cell) => { if (text(cell.value)) hasValues = true; });
      if (!hasValues) continue;
      if (rowIsStruck(row, [usernameCol, firstCol, lastCol, nameCol, emailCol, roleCol, fleetCol, passwordCol].filter(Boolean) as number[])) { skippedStruck++; continue; }
      const name = nameCol ? text(row.getCell(nameCol).value) : [firstCol ? text(row.getCell(firstCol).value) : '', lastCol ? text(row.getCell(lastCol).value) : ''].filter(Boolean).join(' ');
      const role = roleFor(roleCol ? text(row.getCell(roleCol).value) : '');
      const [firstName, lastName] = role === 'vehicle_owner'
        ? nameCol ? [name, ''] : [firstCol ? text(row.getCell(firstCol).value) : '', lastCol ? text(row.getCell(lastCol).value) : '']
        : splitName(name);
      const email = emailCol ? text(row.getCell(emailCol).value).toLowerCase() : '';
      const username = (usernameCol ? text(row.getCell(usernameCol).value) : '') || usernameFor(name || email.split('@')[0]);
      rows.push({ username, firstName, lastName, role, fleetId: fleetCol ? text(row.getCell(fleetCol).value) : '', password: passwordCol ? text(row.getCell(passwordCol).value) || undefined : undefined, sourceRow: rowNumber });
    }
  } else {
    const lines = data.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) throw new Error('CSV file is empty');
    const parseCsv = (line: string) => { const cells: string[] = []; let value = ''; let quoted = false; for (let i = 0; i < line.length; i++) { const char = line[i]; if (char === '"' && line[i + 1] === '"') { value += '"'; i++; } else if (char === '"') quoted = !quoted; else if (char === ',' && !quoted) { cells.push(value.trim()); value = ''; } else value += char; } cells.push(value.trim()); return cells; };
    const headers = new Map(parseCsv(lines[0]).map((value, index) => [key(value), index]));
    const col = (names: string[]) => names.map((name) => headers.get(key(name))).find((index) => index !== undefined);
    const usernameCol = col(['username', 'user name', 'login']); const firstCol = col(['first name', 'firstname']); const lastCol = col(['last name', 'lastname', 'surname']); const nameCol = col(['name', 'employee name', 'name - surname']); const emailCol = col(['email', 'e-mail', 'email address']); const roleCol = col(['role', 'position']); const fleetCol = col(['fleet', 'fleet id', 'service center', 'sub section']); const passwordCol = col(['password', 'pw']);
    if ((usernameCol === undefined && nameCol === undefined && emailCol === undefined) || roleCol === undefined) throw new Error('Required columns: Username (or Name/Email) and Role');
    for (let i = 1; i < lines.length; i++) {
      const cells = parseCsv(lines[i]);
      const name = nameCol !== undefined ? cells[nameCol] || '' : [firstCol !== undefined ? cells[firstCol] : '', lastCol !== undefined ? cells[lastCol] : ''].filter(Boolean).join(' ');
      const role = roleFor(cells[roleCol] || '');
      const [firstName, lastName] = role === 'vehicle_owner'
        ? nameCol !== undefined ? [name, ''] : [firstCol !== undefined ? cells[firstCol] || '' : '', lastCol !== undefined ? cells[lastCol] || '' : '']
        : splitName(name);
      const email = emailCol !== undefined ? (cells[emailCol] || '').toLowerCase() : '';
      const username = (usernameCol !== undefined ? cells[usernameCol] : '') || usernameFor(name || email.split('@')[0]);
      rows.push({ username, firstName, lastName, role, fleetId: fleetCol !== undefined ? cells[fleetCol] || '' : '', password: passwordCol !== undefined ? cells[passwordCol] || undefined : undefined, sourceRow: i + 1 });
    }
  }
  return { rows, skippedStruck };
}

function validateRows(rows: ImportRow[]): string[] {
  const errors: string[] = []; const seen = new Set<string>();
  rows.forEach((row) => {
    const username = row.username.toLowerCase();
    if (!username || !row.firstName || (row.role !== 'vehicle_owner' && !row.lastName)) {
      errors.push(`Row ${row.sourceRow}: username and first name are required; last name is required except for vehicle owners`);
    }
    if (row.firstName.length > 100 || row.lastName.length > 100) errors.push(`Row ${row.sourceRow}: names must be at most 100 characters`);
    if (!VALID_ROLES.has(row.role)) errors.push(`Row ${row.sourceRow}: invalid role "${row.role}"`);
    if (seen.has(username)) errors.push(`Row ${row.sourceRow}: duplicate username "${row.username}"`);
    seen.add(username);
  });
  return errors;
}

async function buildPlan(sql: any, admin: AuthUser, mode: Mode, rows: ImportRow[]) {
  const existing = await sql`SELECT id, username, first_name, last_name, role, fleet_id, is_active FROM users WHERE company_id = ${admin.companyId}` as ExistingUser[];
  const byUsername = new Map(existing.map((user) => [user.username.toLowerCase(), user]));
  const inserts = rows.filter((row) => !byUsername.has(row.username.toLowerCase()));
  const updates = rows.filter((row) => byUsername.has(row.username.toLowerCase()));
  const errors: string[] = [];
  if (mode === 'add' && updates.length) errors.push(`Already exists: ${updates.map((row) => row.username).join(', ')}`);
  if (mode === 'modify' && inserts.length) errors.push(`Not found: ${inserts.map((row) => row.username).join(', ')}`);
  for (const row of mode === 'add' ? inserts : mode === 'modify' ? updates : rows) if (!row.password && !byUsername.has(row.username.toLowerCase())) errors.push(`Missing password for new user: ${row.username}`);
  const deactivate = mode === 'replace' ? existing.filter((user) => user.is_active && !rows.some((row) => row.username.toLowerCase() === user.username.toLowerCase()) && user.id !== admin.userId) : [];
  return { existing, inserts, updates, deactivate, errors };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const admin = await requireAdmin(req, res); if (!admin) return;
  if (req.method !== 'POST' && req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' });
  const mode = String(req.query.mode || '') as Mode; if (!['add', 'modify', 'replace'].includes(mode)) return res.status(400).json({ error: 'Mode must be add, modify, or replace' });
  try {
    const { data, filename } = await readBody(req); const parsed = await parseRows(data, filename); const validationErrors = validateRows(parsed.rows); const sql = neon(process.env.DATABASE_URL!); const plan = await buildPlan(sql, admin, mode, parsed.rows); const errors = [...validationErrors, ...plan.errors];
    const summary = { mode, sourceRows: parsed.rows.length, skippedStruck: parsed.skippedStruck, add: mode === 'modify' ? 0 : plan.inserts.length, modify: mode === 'add' ? 0 : plan.updates.length, deactivate: plan.deactivate.length, errors };
    if (req.method === 'POST') return res.status(200).json({ summary });
    if (errors.length) return res.status(400).json({ error: 'Import validation failed', summary });
    if (mode === 'replace' && parsed.rows.length === 0) return res.status(400).json({ error: 'Replace requires at least one valid row' });
    const queries: any[] = [];
    for (const row of mode === 'modify' ? plan.updates : mode === 'add' ? plan.inserts : parsed.rows) {
      const current = plan.existing.find((user) => user.username.toLowerCase() === row.username.toLowerCase());
      const hash = row.password ? await bcrypt.hash(row.password, BCRYPT_ROUNDS) : null;
      const fleetId = row.role === 'vehicle_owner' ? '' : row.fleetId;
      if (current) {
        queries.push(sql.query('UPDATE users SET first_name = $1, last_name = $2, role = $3, fleet_id = $4, is_active = true, password_hash = COALESCE($5, password_hash), updated_at = NOW() WHERE id = $6 AND company_id = $7', [row.firstName, row.lastName, row.role, fleetId, hash, current.id, admin.companyId]));
        // Owner-to-owner import preserves the checklist. Converting roles revokes it.
        if (row.role !== 'vehicle_owner') queries.push(sql.query('DELETE FROM user_vehicle_access WHERE user_id = $1::uuid AND company_id = $2::uuid', [current.id, admin.companyId]));
      } else queries.push(sql.query('INSERT INTO users (company_id, username, password_hash, first_name, last_name, role, fleet_id, is_active) VALUES ($1, $2, $3, $4, $5, $6, $7, true)', [admin.companyId, row.username, hash, row.firstName, row.lastName, row.role, fleetId]));
    }
    for (const user of plan.deactivate) queries.push(sql.query('UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1 AND company_id = $2', [user.id, admin.companyId]));
    await sql.transaction(queries);
    await logAudit({ userId: admin.userId, username: admin.username, action: `users_import_${mode}`, entityType: 'user', details: summary });
    return res.status(200).json({ imported: true, summary });
  } catch (error: any) { console.error('[API] User import error:', error.message); return res.status(400).json({ error: error.message || 'Import failed' }); }
}
