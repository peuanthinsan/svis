import type { VercelRequest, VercelResponse } from '@vercel/node';
import { neon } from '@neondatabase/serverless';
import { getJwtSecret, verifyAuth } from '../../lib/api-auth';
import { ExportRequestError, issueExportTicket, resolveExportScope } from '../../lib/export-download-ticket';
import { logExportFailure, setExportResponseHeaders } from '../../lib/export-http';

export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setExportResponseHeaders(req, res, 'POST');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const user = await verifyAuth(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      return res.status(415).json({ error: 'Use application/json for export filters' });
    }
    const scope = resolveExportScope(user, req.body);
    const sql = neon(process.env.DATABASE_URL!);
    const ticket = await issueExportTicket(sql, scope, getJwtSecret());
    return res.status(200).json(ticket);
  } catch (error) {
    if (error instanceof ExportRequestError) {
      if (error.status === 429) res.setHeader('Retry-After', '300');
      return res.status(error.status).json({ error: error.message });
    }
    logExportFailure('export_ticket_issue_failed', error);
    return res.status(500).json({ error: 'Unable to prepare export download' });
  }
}
