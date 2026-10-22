import type { VercelRequest, VercelResponse } from '@vercel/node';

const ALLOWED_ORIGINS = new Set([
  'https://svis.songdeegps.com',
  'https://songdee-svis.vercel.app',
]);

/** Apply before auth/method checks so allowed callers can read error responses. */
export function setExportResponseHeaders(req: VercelRequest, res: VercelResponse, method: 'GET' | 'POST') {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const previousVary = res.getHeader('Vary');
  const vary = String(previousVary ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!vary.some((value) => value.toLowerCase() === 'origin')) vary.push('Origin');
  res.setHeader('Vary', vary.join(', '));
  const origin = req.headers.origin;
  if (typeof origin === 'string' && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', `${method}, OPTIONS`);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  }
}

/** Never include exception messages: upstream errors can contain SQL parameters. */
export function logExportFailure(event: 'export_ticket_issue_failed' | 'dashboard_export_failed', error: unknown) {
  const candidate = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code = typeof candidate === 'string' && /^[A-Z0-9_]{1,32}$/.test(candidate) ? candidate : 'UNKNOWN';
  console.error(JSON.stringify({ event, code }));
}
