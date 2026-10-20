import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import os from 'os';
import net from 'net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cache storage for scraped data
let cache = {
  matches: [],
  channels: [],
  lastUpdated: 0
};
const CACHE_TTL = 3 * 60 * 1000; // 3 minutes

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// --------------------------------------------------------------------------
// 1. Anti-SSRF and Safe URL Validation
// --------------------------------------------------------------------------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    // 0.0.0.0/8
    if (parts[0] === 0) return true;
    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    // 127.0.0.0/8 (Loopback)
    if (parts[0] === 127) return true;
    // 169.254.0.0/16 (Link-local)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
    // Broadcast
    if (ip === '255.255.255.255') return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    // ::1 (Loopback)
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
    // :: (Unspecified)
    if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;
    // Unique Local fc00::/7
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    // Link Local fe80::/10
    if (normalized.startsWith('fe80:')) return true;
    return false;
  }
  return false;
}

function isSafeExternalUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { safe: false, reason: 'URL nula o no válida' };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    return { safe: false, reason: 'Formato de URL no válido' };
  }

  // Strictly enforce http or https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `Protocolo no permitido: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost and standard private names
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === '0.0.0.0'
  ) {
    return { safe: false, reason: 'Acceso a host local prohibido (Anti-SSRF)' };
  }

  // Check IP addresses directly
  if (isPrivateIp(hostname)) {
    return { safe: false, reason: 'Acceso a direcciones IP privadas prohibido (Anti-SSRF)' };
  }

  return { safe: true, url: parsed.href };
}

// Safe fetch helper with timeout
async function safeFetch(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        ...(options.headers || {})
      }
    });
    return res;
  } finally {
    clearTimeout(id);
  }
}

// --------------------------------------------------------------------------
// 2. Scraper & Parser (UTF-8 Clean)
// --------------------------------------------------------------------------
function parseMatches(html) {
  const matches = [];
  const parts = html.split(/<li>\s*<a href=["']#["']>/i);
  const IGNORED_PATHS = ['dmca.php', 'aviso-legal.php', 'politica.php', 'contacto.php', 'terms.php'];

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const headerEnd = part.indexOf('</a>');
    if (headerEnd === -1) continue;
    const header = part.substring(0, headerEnd);

    const timeMatch = header.match(/<span class=["']t["']>([^<]+)<\/span>/i);
    const time = timeMatch ? timeMatch[1].trim() : '';
    const cleanHeader = header.replace(/<span[\s\S]*?<\/span>/gi, '').replace(/<[^>]+>/g, '').trim();

    let tournament = 'Fútbol';
    let eventName = cleanHeader;
    if (cleanHeader.includes(':')) {
      const segs = cleanHeader.split(':');
      tournament = segs[0].trim();
      eventName = segs.slice(1).join(':').trim();
    }

    const ulStart = part.indexOf('<ul>', headerEnd);
    const ulEnd = part.indexOf('</ul>', ulStart);
    const options = [];

    if (ulStart !== -1 && ulEnd !== -1) {
      const optionsHtml = part.substring(ulStart, ulEnd);
      const optRegex = /<a href=["']([^"']+)["']>([^<]+)<\/a>/gi;
      let optMatch;
      while ((optMatch = optRegex.exec(optionsHtml)) !== null) {
        const url = optMatch[1].trim();
        const rawName = optMatch[2].trim();

        if (IGNORED_PATHS.some(ign => url.toLowerCase().includes(ign) || rawName.toLowerCase().includes('dmca') || rawName.toLowerCase().includes('aviso'))) {
          continue;
        }

        options.push({
          url,
          name: rawName,
          isHD: rawName.toUpperCase().includes('(HD)') || rawName.toUpperCase().includes('HD')
        });
      }
    }

    if (options.length > 0) {
      matches.push({
        id: 'match-' + i,
        tournament,
        title: eventName,
        fullTitle: cleanHeader,
        time: time || 'EN VIVO',
        options
      });
    }
  }
  return matches;
}

function parseChannels(html) {
  const channels = [];
  const parts = html.split(/<div class=["']menu["']>\s*<a href=["']#["']>/i);

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const headerEnd = part.indexOf('</a>');
    if (headerEnd === -1) continue;
    const header = part.substring(0, headerEnd).replace(/<[^>]+>/g, '').trim();

    const ulStart = part.indexOf('<ul>', headerEnd);
    const ulEnd = part.indexOf('</ul>', ulStart);
    const options = [];

    if (ulStart !== -1 && ulEnd !== -1) {
      const optionsHtml = part.substring(ulStart, ulEnd);
      const optRegex = /<a href=["']([^"']+)["']>([^<]+)<\/a>/gi;
      let optMatch;
      while ((optMatch = optRegex.exec(optionsHtml)) !== null) {
        const url = optMatch[1].trim();
        const name = optMatch[2].trim();
        options.push({
          url,
          name,
          isHD: name.toUpperCase().includes('(HD)') || name.toUpperCase().includes('HD')
        });
      }
    }

    if (options.length > 0) {
      let category = 'Otros';
      const upper = header.toUpperCase();
      if (upper.includes('CAPO')) category = 'Capo Deportes';
      else if (upper.includes('ESPN')) category = 'ESPN';
      else if (upper.includes('DSPORTS') || upper.includes('DIRECTV')) category = 'DSPORTS';
      else if (upper.includes('WIN')) category = 'Win Sports';
      else if (upper.includes('TNT')) category = 'TNT Sports';
      else if (upper.includes('FOX')) category = 'Fox Sports';
      else if (upper.includes('TYC') || upper.includes('GOL')) category = 'Fútbol TV';

      channels.push({
        id: 'chan-' + i,
        name: header,
        category,
        options
      });
    }
  }
  return channels;
}

async function refreshCache() {
  try {
    const [homeRes, chanRes] = await Promise.all([
      safeFetch('https://pirlotv.la/'),
      safeFetch('https://pirlotv.la/canales-en-vivo.php')
    ]);

    if (homeRes.ok) {
      const homeHtml = await homeRes.text();
      cache.matches = parseMatches(homeHtml);
    }
    if (chanRes.ok) {
      const chanHtml = await chanRes.text();
      cache.channels = parseChannels(chanHtml);
    }
    cache.lastUpdated = Date.now();
    console.log(`[Cache Updated] ${cache.matches.length} partidos, ${cache.channels.length} canales.`);
  } catch (err) {
    console.error('[Cache Update Error]:', err.message);
  }
}

// --------------------------------------------------------------------------
// 3. Multi-tier Recursive Stream Resolver
// --------------------------------------------------------------------------
async function resolveStream(startUrl) {
  let currentUrl = startUrl.startsWith('/') ? 'https://pirlotv.la' + startUrl : startUrl;
  let referer = 'https://pirlotv.la/';
  let lastEmbed = currentUrl;

  for (let depth = 0; depth < 5; depth++) {
    const b64Match = currentUrl.match(/[?&]r=([a-zA-Z0-9+/=]+)/);
    if (b64Match) {
      try {
        currentUrl = Buffer.from(b64Match[1], 'base64').toString('utf-8');
      } catch (e) {}
    }

    if (currentUrl.startsWith('//')) currentUrl = 'https:' + currentUrl;
    
    // SSRF Check on resolved hops
    const safetyCheck = isSafeExternalUrl(currentUrl);
    if (!safetyCheck.safe) {
      console.warn(`[Resolver Blocked Hop] ${safetyCheck.reason} -> ${currentUrl}`);
      break;
    }

    lastEmbed = currentUrl;

    try {
      const res = await safeFetch(currentUrl, {
        headers: { 'Referer': referer }
      });
      if (!res.ok) break;
      const html = await res.text();

      // 1. Check for array of streamUrls (e.g. xstream.st / capo pro)
      const m3u8Match = html.match(/const streamUrls\s*=\s*(\[[^\]]+\])/i);
      if (m3u8Match) {
        const streamUrls = JSON.parse(m3u8Match[1].replace(/\\u0026/g, '&'));
        return {
          ok: true,
          mode: 'hls',
          streamUrls,
          embedUrl: currentUrl,
          referer,
          depth
        };
      }

      // 2. Check for playbackURL (e.g. streamtp99a / domhsd)
      const playbackMatch = html.match(/playbackURL\s*=\s*["']([^"']+)["']/i);
      if (playbackMatch) {
        const cleanPlayback = playbackMatch[1].replace(/\\\//g, '/');
        return {
          ok: true,
          mode: 'hls',
          streamUrls: [cleanPlayback],
          embedUrl: currentUrl,
          referer: currentUrl,
          depth
        };
      }

      // 3. Check for Clappr / source m3u8
      const clapprMatch = html.match(/source:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
      if (clapprMatch) {
        return {
          ok: true,
          mode: 'hls',
          streamUrls: [clapprMatch[1]],
          embedUrl: currentUrl,
          referer: currentUrl,
          depth
        };
      }

      // 4. Check for JWPlayer / Video file: '...m3u8'
      const fileMatch = html.match(/file:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
      if (fileMatch) {
        return {
          ok: true,
          mode: 'hls',
          streamUrls: [fileMatch[1]],
          embedUrl: currentUrl,
          referer: currentUrl,
          depth
        };
      }

      // 5. Look for nested iframe
      const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (!iframeMatch) break;

      referer = currentUrl;
      let nextUrl = iframeMatch[1].trim();

      if (nextUrl.startsWith('//')) {
        nextUrl = 'https:' + nextUrl;
      } else if (nextUrl.startsWith('/')) {
        const origin = new URL(currentUrl).origin;
        nextUrl = origin + nextUrl;
      } else if (!nextUrl.startsWith('http')) {
        nextUrl = new URL(nextUrl, currentUrl).href;
      }

      currentUrl = nextUrl;
    } catch (e) {
      console.warn(`[Resolver Hop ${depth} Error]:`, e.message);
      break;
    }
  }

  return {
    ok: true,
    mode: 'embed',
    streamUrls: [],
    embedUrl: lastEmbed,
    referer
  };
}

// --------------------------------------------------------------------------
// 4. API Endpoints
// --------------------------------------------------------------------------

// Schedule
app.get('/api/schedule', async (req, res) => {
  if (Date.now() - cache.lastUpdated > CACHE_TTL || cache.matches.length === 0) {
    await refreshCache();
  }
  res.json({
    ok: true,
    lastUpdated: cache.lastUpdated,
    matches: cache.matches
  });
});

// Channels
app.get('/api/channels', async (req, res) => {
  if (Date.now() - cache.lastUpdated > CACHE_TTL || cache.channels.length === 0) {
    await refreshCache();
  }
  res.json({
    ok: true,
    lastUpdated: cache.lastUpdated,
    channels: cache.channels
  });
});

// Manual refresh
app.get('/api/refresh', async (req, res) => {
  await refreshCache();
  res.json({
    ok: true,
    matchesCount: cache.matches.length,
    channelsCount: cache.channels.length,
    lastUpdated: cache.lastUpdated
  });
});

// Stream resolver with Anti-SSRF
app.get('/api/resolve', async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ ok: false, error: 'Parámetro url es obligatorio' });
  }

  // If it's a relative path on pirlotv, allow it; if absolute, validate safety
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const safety = isSafeExternalUrl(url);
    if (!safety.safe) {
      return res.status(403).json({ ok: false, error: safety.reason });
    }
  }

  try {
    const result = await resolveStream(url);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------------------------------------------------------
// 5. Auto-Speed Benchmark Endpoint
// --------------------------------------------------------------------------
app.post('/api/probe-fastest', async (req, res) => {
  const options = req.body && Array.isArray(req.body.options) ? req.body.options : [];
  if (options.length === 0) {
    return res.status(400).json({ ok: false, error: 'Lista de opciones vacía' });
  }

  // Evaluate all options in parallel with 4000ms max timeout per probe
  const probePromises = options.map(async (opt, index) => {
    try {
      const resolved = await resolveStream(opt.url);
      if (!resolved || !resolved.ok) {
        return { ...opt, index, available: false, latencyMs: 9999, mode: 'unknown' };
      }

      if (resolved.mode === 'hls' && resolved.streamUrls && resolved.streamUrls.length > 0) {
        const testTarget = resolved.streamUrls[0];
        // Probe HLS manifest speed with a lightweight fetch
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2800);
        const probeStart = performance.now();
        try {
          const testRes = await fetch(testTarget, {
            method: 'GET',
            headers: {
              'User-Agent': USER_AGENT,
              'Referer': resolved.referer || 'https://xstream.st/'
            },
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          // Read first chunk and cancel body to free network
          if (testRes.body && testRes.body.cancel) testRes.body.cancel();
          const latencyMs = Math.round(performance.now() - probeStart);

          return {
            ...opt,
            index,
            available: testRes.ok,
            latencyMs: testRes.ok ? latencyMs : 9999,
            mode: 'hls',
            resolvedStream: resolved
          };
        } catch (fetchErr) {
          clearTimeout(timeoutId);
          return { ...opt, index, available: false, latencyMs: 9999, mode: 'hls' };
        }
      } else if (resolved.mode === 'embed' && resolved.embedUrl) {
        // Probe Embed responsiveness
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2800);
        const probeStart = performance.now();
        try {
          const testRes = await fetch(resolved.embedUrl, {
            method: 'HEAD',
            headers: {
              'User-Agent': USER_AGENT,
              'Referer': resolved.referer || 'https://cdplay.live/'
            },
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          const latencyMs = Math.round(performance.now() - probeStart);
          return {
            ...opt,
            index,
            available: testRes.ok || testRes.status === 405, // some hosts deny HEAD with 405 but are active
            latencyMs: latencyMs,
            mode: 'embed',
            resolvedStream: resolved
          };
        } catch (embedErr) {
          clearTimeout(timeoutId);
          return { ...opt, index, available: true, latencyMs: 850, mode: 'embed', resolvedStream: resolved };
        }
      }

      return { ...opt, index, available: false, latencyMs: 9999, mode: 'unknown' };
    } catch (err) {
      return { ...opt, index, available: false, latencyMs: 9999, mode: 'error' };
    }
  });

  const settled = await Promise.allSettled(probePromises);
  const results = settled.map((s, i) => s.status === 'fulfilled' ? s.value : { ...options[i], available: false, latencyMs: 9999 });

  // Sort ranking: available HLS first sorted by latencyMs asc, then available embed by latencyMs asc, then unavailable
  results.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (a.mode === 'hls' && b.mode !== 'hls') return -1;
    if (a.mode !== 'hls' && b.mode === 'hls') return 1;
    return a.latencyMs - b.latencyMs;
  });

  const fastest = results.find(r => r.available) || results[0];

  res.json({
    ok: true,
    ranked: results,
    fastestIndex: fastest ? fastest.index : 0
  });
});

// --------------------------------------------------------------------------
// 6. Network Info (LAN Mobile Handoff)
// --------------------------------------------------------------------------
app.get('/api/network-info', (req, res) => {
  const interfaces = os.networkInterfaces();
  let localIp = '127.0.0.1';

  // Find non-internal IPv4 (prioritize Wi-Fi or Ethernet: 192.168.x or 10.x or 172.x)
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (iface.address.startsWith('192.168.') || iface.address.startsWith('10.')) {
          localIp = iface.address;
          break;
        }
        if (localIp === '127.0.0.1') {
          localIp = iface.address;
        }
      }
    }
    if (localIp.startsWith('192.168.') || localIp.startsWith('10.')) break;
  }

  res.json({
    ok: true,
    ip: localIp,
    port: PORT,
    localUrl: `http://${localIp}:${PORT}`
  });
});

// --------------------------------------------------------------------------
// 7. M3U8 Playlist Proxy
// --------------------------------------------------------------------------
app.get('/api/stream/m3u8', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer || 'https://xstream.st/';

  if (!targetUrl) {
    return res.status(400).send('Parámetro url faltante');
  }

  const safety = isSafeExternalUrl(targetUrl);
  if (!safety.safe) {
    return res.status(403).send(`Acceso denegado: ${safety.reason}`);
  }

  try {
    const response = await safeFetch(targetUrl, {
      headers: {
        'Referer': referer,
        'Origin': new URL(referer).origin
      }
    });

    if (!response.ok) {
      return res.status(response.status).send(`Fallo al obtener m3u8: ${response.statusText}`);
    }

    const playlist = await response.text();
    const basePath = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

    // Rewrite playlist lines (both sub-playlists and media chunks)
    const lines = playlist.split('\n');
    const rewritten = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Rewrite URI attributes like #EXT-X-KEY:METHOD=...,URI="..." or #EXT-X-MAP:URI="..."
      if (trimmed.startsWith('#')) {
        return line.replace(/URI=["']([^"']+)["']/g, (m, uri) => {
          let absUri = (uri.startsWith('http://') || uri.startsWith('https://')) ? uri : new URL(uri, basePath).href;
          return `URI="/api/stream/ts?url=${encodeURIComponent(absUri)}&referer=${encodeURIComponent(referer)}"`;
        });
      }

      // Absolute target url
      let absoluteTarget;
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        absoluteTarget = trimmed;
      } else {
        absoluteTarget = new URL(trimmed, basePath).href;
      }

      const isSubPlaylist = absoluteTarget.includes('.m3u8');
      const endpoint = isSubPlaylist ? '/api/stream/m3u8' : '/api/stream/ts';
      return `${endpoint}?url=${encodeURIComponent(absoluteTarget)}&referer=${encodeURIComponent(referer)}`;
    }).join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(rewritten);
  } catch (err) {
    console.error('M3U8 proxy error:', err.message);
    res.status(502).send('Error proxying m3u8: ' + err.message);
  }
});

// --------------------------------------------------------------------------
// 8. Real High-Performance TS Segment Streaming (Zero RAM Buffering)
// --------------------------------------------------------------------------
app.get('/api/stream/ts', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer || 'https://xstream.st/';

  if (!targetUrl) {
    return res.status(400).send('Parámetro url faltante');
  }

  const safety = isSafeExternalUrl(targetUrl);
  if (!safety.safe) {
    return res.status(403).send(`Acceso denegado: ${safety.reason}`);
  }

  // AbortController connected to client socket closure to prevent RAM & worker leaks
  const controller = new AbortController();
  req.on('close', () => {
    controller.abort();
  });

  try {
    const upstreamHeaders = {
      'User-Agent': USER_AGENT,
      'Referer': referer,
      'Origin': new URL(referer).origin
    };

    // Forward Range header if requested by client player
    if (req.headers.range) {
      upstreamHeaders['Range'] = req.headers.range;
    }

    const response = await fetch(targetUrl, {
      headers: upstreamHeaders,
      signal: controller.signal
    });

    if (!response.ok && response.status !== 206) {
      return res.status(response.status).send('Fallo al obtener segmento de video');
    }

    // Set streaming headers
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    if (response.headers.has('content-length')) {
      res.setHeader('Content-Length', response.headers.get('content-length'));
    }
    if (response.status === 206 && response.headers.has('content-range')) {
      res.status(206);
      res.setHeader('Content-Range', response.headers.get('content-range'));
    }

    // Stream directly from response body without buffering in RAM
    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body);
      nodeStream.on('error', (err) => {
        if (!res.headersSent) res.status(502).end();
      });
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      // Client disconnected normally, no error log needed
      return;
    }
    console.error('TS streaming error:', err.message);
    if (!res.headersSent) {
      res.status(502).send('Error streaming video segment: ' + err.message);
    }
  }
});

// --------------------------------------------------------------------------
// 9. Sanitized Clean-Embed Proxy (postMessage Audio Control + Click Detection)
// --------------------------------------------------------------------------
app.get('/player/clean-embed', async (req, res) => {
  let embedUrl = req.query.url;
  const referer = req.query.referer || 'https://cdplay.live/';

  if (!embedUrl || embedUrl === 'about:blank') {
    return res.status(400).send('Parámetro url faltante');
  }

  if (embedUrl.startsWith('/')) {
    embedUrl = 'https://pirlotv.la' + embedUrl;
  } else if (embedUrl.startsWith('//')) {
    embedUrl = 'https:' + embedUrl;
  }

  const safety = isSafeExternalUrl(embedUrl);
  if (!safety.safe) {
    return res.status(403).send(`Acceso denegado: ${safety.reason}`);
  }

  let originHeader = 'https://cdplay.live';
  try {
    const parsed = new URL(embedUrl);
    if (parsed.origin && parsed.origin !== 'null') {
      originHeader = parsed.origin;
    }
  } catch (e) {}

  try {
    const response = await safeFetch(embedUrl, {
      headers: {
        'Referer': referer,
        'Origin': originHeader
      }
    });

    if (!response.ok) {
      return res.status(response.status).send(`
        <!DOCTYPE html>
        <html lang="es">
        <head><meta charset="UTF-8"><style>body{background:#080b11;color:#94a3b8;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;}</style></head>
        <body>
          <div>
            <h3 style="color:#ef4444;font-size:18px;">⚠️ Señal no disponible en este servidor</h3>
            <p>El servidor de transmisión respondió con error ${response.status}. Por favor selecciona otro canal u opción.</p>
          </div>
        </body>
        </html>
      `);
    }

    let html = await response.text();

    // 1. Remove anti-iframe & redirection traps
    html = html.replace(/<script>if\s*\(\s*window\s*==\s*window\.top\s*\)\s*\{\s*document\.location\s*=\s*["']\/["'];?\s*\}\s*<\/script>/gi, '');
    html = html.replace(/location\[t\[5\]\]\s*=\s*["']\/block\.html["']/gi, '/* blocked redirect */');
    html = html.replace(/location\.href\s*=\s*["']\/block\.html["']/gi, '/* blocked redirect */');

    // 2. Remove inline anti-sandbox detection scripts and redirection traps
    html = html.replace(/<script[^>]*>[\s\S]*?t=\["sandbox"[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<script[^>]*>[\s\S]*?hasAttribute\("sandbox"\)[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<script[^>]*>[\s\S]*?location\[t\[5\]\]\s*=\s*["']\/block\.html["'][\s\S]*?<\/script>/gi, '');
    html = html.replace(/<script[^>]*>[\s\S]*?Sandbox not allowed[\s\S]*?<\/script>/gi, '');

    // 3. Remove known ad networks & popunder script tags
    html = html.replace(/<script\s+type=["']text\/javascript["']\s+data-cfasync=["']false["']>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<script[^>]*src=["'][^"']*(?:tag\.min\.js|aclib|waust|intellipopup|cloudfront|pa-H_qzm|histats|llvpn|r2\.dev|dtscout|popads|adcash|exoclick|juicyads|propeller)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<script[^>]*id=["'](?:_wauksz|aclib)["']>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/aclib\.runPop\([\s\S]*?\);?/gi, '');

    // 4. Strip inline scripts containing ad, tracker, popunder, and devtools blocking keywords
    const AD_KEYWORDS = ['popunder', 'popads', 'aclib', 'histats', 'dtscout', 'clickable', 'adcash', 'exoclick', 'juicyads', 'propeller', 'bet365', '1xbet', 'onclick', 'onmousedown', 'window.open', 'devtools-detector', 'disable-devtool'];
    html = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (allScript, content) => {
      const lower = content.toLowerCase();
      if (AD_KEYWORDS.some(kw => lower.includes(kw))) {
        return '<!-- blocked ad script -->';
      }
      return allScript;
    });

    // 5. Recursive iframe rewriting: route any nested iframes through /player/clean-embed with sandbox
    html = html.replace(/<iframe\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>/gi, (match, prefix, srcUrl, suffix) => {
      let resolved = srcUrl.trim();
      if (resolved.startsWith('//')) {
        resolved = 'https:' + resolved;
      } else if (resolved.startsWith('/')) {
        resolved = new URL(resolved, embedUrl).href;
      } else if (!resolved.startsWith('http')) {
        resolved = new URL(resolved, embedUrl).href;
      }
      const proxiedSrc = `/player/clean-embed?url=${encodeURIComponent(resolved)}&referer=${encodeURIComponent(embedUrl)}`;
      return `<iframe ${prefix} src="${proxiedSrc}" sandbox="allow-scripts allow-same-origin allow-forms allow-presentation" ${suffix}>`;
    });

    // 6. Inject base href and bulletproof security shield with postMessage audio controls & MutationObserver
    const baseTag = `<base href="${embedUrl}">`;
    const shieldInjection = `
      ${baseTag}
      <script>
        // -------------------------------------------------------------
        // Anti-Popup & Action Neutralizer
        // -------------------------------------------------------------
        window.open = function() { console.warn('🛡️ Shield: window.open bloqueado'); return null; };
        window.alert = function() { return false; };
        window.confirm = function() { return false; };
        window.prompt = function() { return null; };
        window.onbeforeunload = null;
        try { HTMLAnchorElement.prototype.click = function() { console.warn('🛡️ Shield: click sintético bloqueado'); }; } catch(e){}
        try { Object.defineProperty(window, 'top', { get: () => window.self }); } catch(e){}

        // Intercept addEventListener to drop click/pointer listeners using window.open or location redirects
        try {
          const origAddEventListener = EventTarget.prototype.addEventListener;
          EventTarget.prototype.addEventListener = function(type, listener, options) {
            if (['click', 'mousedown', 'mouseup', 'pointerdown', 'touchstart'].includes(type) && typeof listener === 'function') {
              const fnStr = listener.toString();
              if (fnStr.includes('window.open') || fnStr.includes('location') || fnStr.includes('createElement("a")') || fnStr.includes("createElement('a')")) {
                console.warn('🛡️ Shield: Listener malicioso bloqueado:', type);
                return;
              }
            }
            return origAddEventListener.call(this, type, listener, options);
          };
        } catch(e) {}

        // Neutralize anti-sandbox detection (emulate non-sandboxed frameElement)
        try {
          Object.defineProperty(window, 'frameElement', {
            configurable: true,
            get: function() {
              return {
                hasAttribute: function(attr) { return false; },
                getAttribute: function(attr) { return null; },
                removeAttribute: function(attr) {},
                sandbox: undefined
              };
            }
          });
        } catch(e) {}

        // Neutralize block redirect traps
        try {
          const origAssign = window.location.assign.bind(window.location);
          const origReplace = window.location.replace.bind(window.location);
          window.location.assign = function(url) {
            if (url && (String(url).includes('block.html') || String(url).includes('block'))) return;
            return origAssign(url);
          };
          window.location.replace = function(url) {
            if (url && (String(url).includes('block.html') || String(url).includes('block'))) return;
            return origReplace(url);
          };
        } catch(e) {}

        // -------------------------------------------------------------
        // MutationObserver: Anti-Invisible Overlays & Ad Injector Blocker
        // -------------------------------------------------------------
        const adKeywords = ['popunder', 'popads', 'aclib', 'histats', 'dtscout', 'clickable', 'adcash', 'exoclick', 'juicyads', 'propeller', 'bet365', '1xbet', 'tag.min.js', 'llvpn', 'window.open', 'onclick', 'onmousedown'];
        function sweepOverlays() {
          try {
            document.querySelectorAll('a').forEach(a => a.remove());
            document.querySelectorAll('div').forEach(node => {
              try {
                const style = window.getComputedStyle(node);
                const zIndex = parseInt(style.zIndex, 10);
                if ((style.position === 'fixed' || style.position === 'absolute') && zIndex > 1000) {
                  if (!node.querySelector('video, #player, #clappr, .player-poster, .shaka-video-container, [data-player]') && !node.id.includes('player') && !node.id.includes('clappr')) {
                    node.remove();
                  }
                }
              } catch(e){}
            });
          } catch(e){}
        }
        sweepOverlays();
        document.addEventListener('DOMContentLoaded', sweepOverlays);

        const observer = new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (node.nodeType !== 1) continue;
              // 1. Immediately remove ANY anchor tag (clickjackers)
              if (node.tagName === 'A') {
                node.remove();
                continue;
              }
              // 2. Remove ad script injections
              if (node.tagName === 'SCRIPT') {
                const src = (node.src || '').toLowerCase();
                const text = (node.textContent || '').toLowerCase();
                if (adKeywords.some(kw => src.includes(kw) || text.includes(kw))) {
                  node.remove();
                  continue;
                }
              }
              // 3. Ensure any dynamically inserted iframe goes through clean-embed
              if (node.tagName === 'IFRAME') {
                if (node.src && !node.src.includes('/player/clean-embed') && !node.src.startsWith('about:')) {
                  node.src = '/player/clean-embed?url=' + encodeURIComponent(node.src) + '&referer=' + encodeURIComponent(window.location.href);
                }
              }
              // 4. Remove floating overlay divs with high z-index that don't contain video or player controls
              if (node.tagName === 'DIV') {
                try {
                  const style = window.getComputedStyle(node);
                  const zIndex = parseInt(style.zIndex, 10);
                  if ((style.position === 'fixed' || style.position === 'absolute') && zIndex > 1000) {
                    if (!node.querySelector('video, #player, #clappr, .player-poster, .shaka-video-container, [data-player]') && !node.id.includes('player') && !node.id.includes('clappr')) {
                      node.remove();
                    }
                  }
                } catch(e) {}
              }
            }
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });

        // -------------------------------------------------------------
        // Audio & Video Fit Control via postMessage
        // -------------------------------------------------------------
        window.addEventListener('message', function(event) {
          try {
            const data = event.data;
            if (!data || typeof data !== 'object') return;

            // Audio mute/unmute
            if (data.type === 'SET_MUTE') {
              const shouldMute = !!data.muted;
              document.querySelectorAll('video, audio').forEach(function(media) {
                media.muted = shouldMute;
                if (!shouldMute) {
                  media.volume = 1;
                  media.play().catch(function(){});
                }
              });

              if (window.player) {
                if (shouldMute && window.player.mute) window.player.mute();
                else if (!shouldMute) {
                  if (window.player.unmute) window.player.unmute();
                  if (window.player.setVolume) window.player.setVolume(100);
                }
              }

              if (window.jwplayer && typeof window.jwplayer === 'function') {
                try { window.jwplayer().setMute(shouldMute); } catch(e){}
              }
            }

            // Aspect ratio / object-fit control
            if (data.type === 'SET_FIT') {
              const fitVal = data.fit || 'contain';
              document.querySelectorAll('video, #player, #clappr, .player-poster, .shaka-video-container, [data-player]').forEach(function(el) {
                el.style.setProperty('object-fit', fitVal, 'important');
              });
            }
          } catch(err) {
            console.warn('postMessage handler error:', err);
          }
        });

        // Focus Notification: Notify parent when iframe is clicked/tapped
        function notifyParentSlotFocus() {
          try {
            window.parent.postMessage({ type: 'SLOT_FOCUSED', slotId: window.name }, '*');
          } catch(e) {}
        }
        window.addEventListener('pointerdown', notifyParentSlotFocus, true);
        window.addEventListener('click', notifyParentSlotFocus, true);

        // Auto-unmute helper if present
        document.addEventListener('DOMContentLoaded', () => {
          const unmute = document.getElementById('unmute') || document.getElementById('soundButton');
          if (unmute) {
            unmute.addEventListener('click', () => {
              if (window.player && window.player.setVolume) window.player.setVolume(100);
            });
          }
        });
      </script>
      <style>
        * { box-sizing: border-box; }
        html, body {
          width: 100vw !important;
          height: 100vh !important;
          margin: 0 !important;
          padding: 0 !important;
          overflow: hidden !important;
          background: #000 !important;
        }
        video, #player, #clappr, .player-poster, .shaka-video-container, [data-player] {
          width: 100vw !important;
          height: 100vh !important;
          max-width: 100vw !important;
          max-height: 100vh !important;
          position: fixed !important;
          inset: 0 !important;
          object-fit: contain !important;
        }
        a[target="_blank"], a { pointer-events: none !important; }
        div[style*="z-index: 2147483647"], div[style*="z-index:999999"], div[class*="banner"] { display: none !important; }
        #unmute { cursor: pointer; user-select: none; z-index: 99999 !important; }
      </style>
    `;

    if (html.includes('<head>')) {
      html = html.replace('<head>', '<head>' + shieldInjection);
    } else {
      html = shieldInjection + html;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self' *;");
    res.send(html);
  } catch (err) {
    console.error('Clean embed error:', err.message);
    res.status(502).send('Error proxying embed: ' + err.message);
  }
});

// Alias for backwards compatibility
app.get('/player/shield', (req, res) => {
  const embedUrl = req.query.url;
  const referer = req.query.referer || '';
  if (!embedUrl) return res.status(400).send('Parámetro url faltante');
  res.redirect(`/player/clean-embed?url=${encodeURIComponent(embedUrl)}&referer=${encodeURIComponent(referer)}`);
});

// Start server listening on all network interfaces (0.0.0.0) for Wi-Fi LAN access
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n======================================================`);
  console.log(`⚡ Capo Deportes / Pirlo Shield Server activo en http://0.0.0.0:${PORT}`);
  console.log(`🛡️  Modo Seguro Activado: Sin anuncios, Anti-SSRF, Zero-RAM Stream`);
  console.log(`======================================================\n`);
  await refreshCache();
});
