import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put } from '@vercel/blob';
import { verifyAuth } from '../lib/api-auth';
import { isImageBuffer, MAX_UPLOAD_SIZE } from '../lib/validate';

export const config = {
  api: {
    bodyParser: false,
  },
};

function parseMultipart(buffer: Buffer, boundary: string): Buffer | null {
  const boundaryStr = `--${boundary}`;
  const str = buffer.toString('binary');

  const start = str.indexOf('\r\n\r\n');
  if (start === -1) return null;

  const contentStart = start + 4;
  const end = str.indexOf(boundaryStr, contentStart);
  if (end === -1) return null;

  const contentEnd = end - 2;
  return Buffer.from(str.slice(contentStart, contentEnd), 'binary');
}

function sanitizeFilename(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 100) || `photo-${Date.now()}.jpg`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth required
  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (user.role === 'vehicle_owner') return res.status(403).json({ error: 'Vehicle owners have read-only access' });

  try {
    const filename = sanitizeFilename((req.query.filename as string) || `photo-${Date.now()}.jpg`);

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return res.status(500).json({ error: 'Storage not configured' });
    }

    // Collect raw body with size limit
    const chunks: Uint8Array<ArrayBufferLike>[] = [];
    let totalSize = 0;
    for await (const chunk of req) {
      totalSize += chunk.length;
      if (totalSize > MAX_UPLOAD_SIZE) {
        return res.status(413).json({ error: 'File too large (max 10 MB)' });
      }
      chunks.push(Uint8Array.from(chunk));
    }
    const body = Buffer.concat(chunks);

    // Extract image data from multipart form
    const contentType = req.headers['content-type'] || '';
    let imageData: Buffer;

    if (contentType.includes('multipart/form-data')) {
      const boundary = contentType.split('boundary=')[1];
      if (!boundary) {
        return res.status(400).json({ error: 'Missing boundary in multipart' });
      }
      const parsed = parseMultipart(body, boundary);
      if (!parsed || parsed.length === 0) {
        return res.status(400).json({ error: 'Could not parse image from form data' });
      }
      imageData = parsed;
    } else {
      imageData = body;
    }

    // Validate file is actually an image (magic bytes)
    if (!isImageBuffer(imageData)) {
      return res.status(400).json({ error: 'Invalid image file (JPEG/PNG only)' });
    }

    const blob = await put(filename, imageData, {
      access: 'public',
      token: process.env.BLOB_READ_WRITE_TOKEN,
      contentType: imageData[0] === 0x89 ? 'image/png' : 'image/jpeg',
    });

    res.status(200).json({ url: blob.url });
  } catch (error: any) {
    console.error('[Upload] Error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
}
