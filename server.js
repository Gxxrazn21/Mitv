import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cache storage
let cache = {
  matches: [],
  channels: [],
  lastUpdated: 0
};
const CACHE_TTL = 3 * 60 * 1000; // 3 minutes

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// Safe fetch helper with timeout
async function safeFetch(url, options = {}, timeoutMs = 15000) {
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

// Scrape matches schedule from pirlotv.la
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

        // Ignore non-streaming legal/contact links
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

// Scrape permanent 24/7 channels
function parseChannels(html) {
  const channels = [];
  const parts = html.split(/<li>\s*<a href=["']#["']>/i);
  const IGNORED_PATHS = ['dmca.php', 'aviso-legal.php', 'politica.php', 'contacto.php'];

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
        const rawName = optMatch[2].trim();

        if (IGNORED_PATHS.some(ign => url.toLowerCase().includes(ign) || rawName.toLowerCase().includes('dmca'))) {
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

// Refresh cache
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
    console.log(`[Cache Updated] ${cache.matches.length} matches, ${cache.channels.length} channels.`);
  } catch (err) {
    console.error('[Cache Update Error]:', err.message);
  }
}

// Multi-tier recursive stream resolver
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
      console.log(`[Resolver Hop ${depth + 1}] -> ${currentUrl}`);
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

// API Routes
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

app.get('/api/refresh', async (req, res) => {
  await refreshCache();
  res.json({
    ok: true,
    matchesCount: cache.matches.length,
    channelsCount: cache.channels.length,
    lastUpdated: cache.lastUpdated
  });
});

app.get('/api/resolve', async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ ok: false, error: 'Param url is required' });
  }

  try {
    const result = await resolveStream(url);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Proxy for M3U8 Playlist (adds proper Referer, rewrites TS segment URLs)
app.get('/api/stream/m3u8', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer || 'https://xstream.st/';

  if (!targetUrl) {
    return res.status(400).send('Missing url parameter');
  }

  try {
    const response = await safeFetch(targetUrl, {
      headers: {
        'Referer': referer,
        'Origin': new URL(referer).origin
      }
    });

    if (!response.ok) {
      return res.status(response.status).send(`Failed to fetch m3u8: ${response.statusText}`);
    }

    const playlist = await response.text();
    const parsedTarget = new URL(targetUrl);
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

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(rewritten);
  } catch (err) {
    console.error('M3U8 proxy error:', err.message);
    res.status(502).send('Error proxying m3u8: ' + err.message);
  }
});

// Proxy for TS Video Segments
app.get('/api/stream/ts', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer || 'https://xstream.st/';

  if (!targetUrl) {
    return res.status(400).send('Missing url parameter');
  }

  try {
    const response = await safeFetch(targetUrl, {
      headers: {
        'Referer': referer,
        'Origin': new URL(referer).origin
      }
    });

    if (!response.ok) {
      return res.status(response.status).send('Segment fetch failed');
    }

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    // Stream the body directly
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(502).send('Error streaming segment: ' + err.message);
  }
});

// Sanitized clean-embed proxy (strips ads, popups, and anti-frame locks so Shaka/Clappr play smoothly)
app.get('/player/clean-embed', async (req, res) => {
  let embedUrl = req.query.url;
  const referer = req.query.referer || 'https://cdplay.live/';

  if (!embedUrl || embedUrl === 'about:blank') {
    return res.status(400).send('Missing url parameter');
  }

  if (embedUrl.startsWith('/')) {
    embedUrl = 'https://pirlotv.la' + embedUrl;
  } else if (embedUrl.startsWith('//')) {
    embedUrl = 'https:' + embedUrl;
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
        <html>
        <head><meta charset="UTF-8"><style>body{background:#0a0d14;color:#9ca3af;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;}</style></head>
        <body>
          <div>
            <h3 style="color:#ef4444;">⚠️ Señal no disponible en este servidor</h3>
            <p>El servidor de transmisión respondió con error ${response.status}. Por favor selecciona otro canal o servidor.</p>
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

    // 3. Remove known ad networks & popunder scripts
    html = html.replace(/<script\s+type=["']text\/javascript["']\s+data-cfasync=["']false["']>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<script[^>]*src=["'][^"']*(?:tag\.min\.js|aclib|waust|intellipopup|cloudfront|pa-H_qzm|histats|llvpn|r2\.dev)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<script[^>]*id=["'](?:_wauksz|aclib)["']>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/aclib\.runPop\([\s\S]*?\);?/gi, '');

    // 4. Remove any sandbox attribute on nested iframes
    html = html.replace(/\s*sandbox(?:="[^"]*")?/gi, '');

    // 5. Inject base href and bulletproof security shield
    const baseTag = `<base href="${embedUrl}">`;
    const shieldInjection = `
      ${baseTag}
      <script>
        // Neutralize popups and alerts
        window.open = function() { console.warn('🛡️ Shield: popup neutralizado'); return null; };
        window.alert = function() { return false; };
        window.confirm = function() { return false; };
        window.onbeforeunload = null;
        try { Object.defineProperty(window, 'top', { get: () => window.self }); } catch(e){}

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
        html, body { width: 100%; height: 100%; margin: 0; padding: 0; background: #000; overflow: hidden; }
        a[target="_blank"] { pointer-events: none !important; }
        div[style*="z-index: 2147483647"], div[style*="z-index:999999"], div[class*="banner"] { display: none !important; }
        #unmute { cursor: pointer; user-select: none; }
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
  if (!embedUrl) return res.status(400).send('Missing url parameter');
  res.redirect(`/player/clean-embed?url=${encodeURIComponent(embedUrl)}&referer=${encodeURIComponent(referer)}`);
});

// Start server and initialize cache
app.listen(PORT, async () => {
  console.log(`\n======================================================`);
  console.log(`⚡ Capo Deportes / Pirlo Shield Server activo en http://localhost:${PORT}`);
  console.log(`🛡️  Modo Seguro Activado: Sin anuncios, sin popups ni malware`);
  console.log(`======================================================\n`);
  await refreshCache();
});
