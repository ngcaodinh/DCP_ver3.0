import type { Request, Response } from 'express';
import { getLogger } from '../config/logger';

const logger = getLogger();

/**
 * Proxy tile requests từ OpenStreetMap để tránh lộ GPS coordinates ra ngoài.
 * [A-NEW3 fix] Thay vì client tải tile trực tiếp từ tile.openstreetmap.org,
 * proxy qua backend để:
 * 1. Không lộ IP commissioner + GPS coordinates tới third-party
 * 2. Có audit trail cho tile access
 * 3. Implement rate limiting và caching
 * 
 * Route: GET /api/tiles/:z/:x/:y.png
 */
export async function proxyOsmTile(req: Request, res: Response): Promise<void> {
  const { z, x, y } = req.params;
  
  // Validate tile coordinates
  const zNum = parseInt(z, 10);
  const xNum = parseInt(x, 10);
  const yNum = parseInt(y, 10);
  
  if (!Number.isFinite(zNum) || !Number.isFinite(xNum) || !Number.isFinite(yNum)) {
    res.status(400).json({ error: 'Invalid tile coordinates' });
    return;
  }
  
  // Validate zoom level (OSM supports 0-19)
  if (zNum < 0 || zNum > 19) {
    res.status(400).json({ error: 'Invalid zoom level' });
    return;
  }
  
  // Validate x/y bounds for given zoom level
  const maxTileIndex = Math.pow(2, zNum) - 1;
  if (xNum < 0 || xNum > maxTileIndex || yNum < 0 || yNum > maxTileIndex) {
    res.status(400).json({ error: 'Tile coordinates out of bounds' });
    return;
  }

  try {
    // Fetch tile từ OSM tile server với round-robin subdomain (a/b/c)
    const subdomains = ['a', 'b', 'c'];
    const subdomain = subdomains[Math.floor(Math.random() * subdomains.length)];
    const tileUrl = `https://${subdomain}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
    
    const response = await fetch(tileUrl, {
      headers: {
        'User-Agent': 'DCP-Oracle-System/1.0 (contact: admin@dcp.example.com)'
      }
    });
    
    if (!response.ok) {
      logger.warn('OSM tile fetch failed.', {
        z, x, y, status: response.status
      });
      res.status(response.status).json({ error: 'Tile not found' });
      return;
    }
    
    const imageBuffer = await response.arrayBuffer();
    
    // Set cache headers (tiles thay đổi rất ít, cache 7 ngày)
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=604800, immutable',
      'X-Tile-Proxy': 'DCP-Backend'
    });
    
    res.send(Buffer.from(imageBuffer));
    
  } catch (error) {
    logger.error('Tile proxy error.', {
      z, x, y,
      errorMessage: (error as Error).message
    });
    res.status(500).json({ error: 'Failed to fetch tile' });
  }
}
