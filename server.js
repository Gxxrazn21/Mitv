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
    if (parts[0] === 0) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (ip === '255.255.255.255') return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
    if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
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

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `Protocolo no permitido: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === '0.0.0.0'
  ) {
    return { safe: false, reason: 'Acceso a host local prohibido (Anti-SSRF)' };
  }

  if (isPrivateIp(hostname)) {
    return { safe: false, reason: 'Acceso a direcciones IP privadas prohibido (Anti-SSRF)' };
  }

  return { safe: true, url: parsed.href };
}

async function safeFetch(url, options = {}, timeoutMs = 10000) {
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
// 2. Scraper & Parser
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
// 3. Deep Stream Deobfuscation & Extractor
// --------------------------------------------------------------------------

// Decodes proprietary _econfig string using 4-chunk permutation [2, 0, 3, 1]
function decodeEConfig(econfigStr) {
  if (!econfigStr) return null;
  const atob = (s) => Buffer.from(s, 'base64').toString('binary');
  try {
    const perm = [2, 0, 3, 1];
    const chunksCount = 4;
    let raw = atob(econfigStr);
    const chunkLen = Math.floor(raw.length / chunksCount);
    const chunks = [];
    let offset = 0;
    for (let i = 0; i < chunksCount; i++) {
      chunks.push(raw.slice(offset, offset + chunkLen));
      offset += chunkLen;
    }
    const permuted = [];
    for (let i = 0; i < perm.length; i++) {
      let piece = String(chunks[i]);
      piece = piece.slice(0, 3) + piece.slice(4);
      permuted[perm[i]] = atob(piece);
    }
    const joined = permuted.join('');
    const jsonStr = atob(joined);
    return JSON.parse(jsonStr);
  } catch (err) {
    return null;
  }
}

// Unpacks Dean Edwards eval(function(p,a,c,k,e,d)...) packed JS
function unpackDeanEdwards(packed) {
  const match = packed.match(/}\s*\(\s*(['"].*?['"]|.*?)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"].*?['"]|\[.*?\])\s*,\s*(\d+)\s*,\s*(.*?)\s*\)\s*\)/s);
  if (!match) return null;
  let p = match[1];
  const a = parseInt(match[2], 10);
  const c = parseInt(match[3], 10);
  let k = match[4];
  if ((p.startsWith("'") && p.endsWith("'")) || (p.startsWith('"') && p.endsWith('"'))) {
    p = p.slice(1, -1);
  }
  let kArray = [];
  if (k.startsWith('[') && k.endsWith(']')) {
    try { kArray = JSON.parse(k); } catch (e) { kArray = k.slice(1, -1).split(','); }
  } else {
    if ((k.startsWith("'") && k.endsWith("'")) || (k.startsWith('"') && k.endsWith('"'))) {
      k = k.slice(1, -1);
    }
    kArray = k.split('|');
  }

  function baseN(val, radix) {
    let res = '';
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    while (val > 0) {
      res = chars[val % radix] + res;
      val = Math.floor(val / radix);
    }
    return res || '0';
  }

  const dict = {};
  for (let i = 0; i < c; i++) {
    const key = a > 36 ? baseN(i, a) : i.toString(a);
    dict[key] = kArray[i] || key;
  }

  return p.replace(/\b\w+\b/g, (token) => dict[token] !== undefined ? dict[token] : token);
}

// Deep text analyzer for HLS (.m3u8) and DASH (.mpd) with ClearKey DRM
function extractStreamsFromText(text, referer) {
  if (!text || typeof text !== 'string') return null;

  // 1. Check window._econfig
  const econfigMatch = text.match(/window\._econfig\s*=\s*['"]([^'"]+)['"]/);
  if (econfigMatch) {
    const dec = decodeEConfig(econfigMatch[1]);
    if (dec) {
      const urls = [];
      if (dec.stream_url) urls.push(dec.stream_url);
      if (dec.stream_url_nop2p && !urls.includes(dec.stream_url_nop2p)) urls.push(dec.stream_url_nop2p);
      if (urls.length > 0) {
        return { mode: 'hls', streamUrls: urls, referer };
      }
    }
  }

  // 2. Check JSON streamUrls array (e.g. xstream.st / capo pro)
  const m3u8Arr = text.match(/const\s+streamUrls\s*=\s*(\[[^\]]+\])/i) || text.match(/streamUrls\s*=\s*(\[[^\]]+\])/i);
  if (m3u8Arr) {
    try {
      const urls = JSON.parse(m3u8Arr[1].replace(/\\u0026/g, '&'));
      if (Array.isArray(urls) && urls.length > 0) {
        return { mode: 'hls', streamUrls: urls, referer };
      }
    } catch (e) {}
  }

  // 3. Check for DASH (.mpd) with DRM ClearKey
  const clearKeysMatch = text.match(/clearKeys?\s*:\s*\{([^}]+)\}/i) || text.match(/drm:\s*\{[\s\S]*?clearKeys:\s*\{([^}]+)\}/i);
  const mpdMatch = text.match(/(?:file|source|src|url)\s*[:=]\s*["']((?:https?:)?\/\/[^"']+\.mpd[^"']*)["']/i) || text.match(/["']((?:https?:)?\/\/[^"'\s<>\\]+\.mpd(?:\?[^"'\s<>\\]*)?)["']/i);
  if (mpdMatch) {
    let clearKeys = null;
    if (clearKeysMatch) {
      const pairRegex = /["']?([0-9a-fA-F]{32})["']?\s*:\s*["']([0-9a-fA-F]{32})["']/g;
      let pm;
      clearKeys = {};
      while ((pm = pairRegex.exec(clearKeysMatch[1])) !== null) {
        clearKeys[pm[1].toLowerCase()] = pm[2].toLowerCase();
      }
    }
    let mpdUrl = mpdMatch[1] || mpdMatch[0];
    if (mpdUrl.startsWith('//')) mpdUrl = 'https:' + mpdUrl;
    return {
      mode: 'dash',
      streamUrls: [mpdUrl],
      clearKeys,
      referer
    };
  }

  // 4. Variables directas: playbackURL, source, file, src, hls, stream, url
  const varMatch = text.match(/(?:playbackURL|source|file|src|hls|stream|url)\s*[:=]\s*["'](https?:\/\/[^"']+\.(?:m3u8|mpd)[^"']*)["']/i);
  if (varMatch) {
    const rawUrl = varMatch[1].replace(/\\\//g, '/');
    const isDash = rawUrl.includes('.mpd');
    return {
      mode: isDash ? 'dash' : 'hls',
      streamUrls: [rawUrl],
      clearKeys: null,
      referer
    };
  }

  // 5. Packed eval scripts: eval(function(p,a,c,k,e,d)...)
  const packedMatch = text.match(/eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d[\s\S]*?\)\s*\)/);
  if (packedMatch) {
    const unpacked = unpackDeanEdwards(packedMatch[0]);
    if (unpacked) {
      const res = extractStreamsFromText(unpacked, referer);
      if (res) return res;
    }
  }

  // 6. Base64 encoded strings inside atob(...) or long b64 tokens
  const b64Regex = /(?:atob\s*\(\s*['"]([A-Za-z0-9+/=]{20,})['"]\s*\)|['"]([A-Za-z0-9+/=]{36,})['"])/g;
  let bMatch;
  while ((bMatch = b64Regex.exec(text)) !== null) {
    try {
      const token = bMatch[1] || bMatch[2];
      const dec = Buffer.from(token, 'base64').toString('utf8');
      if (dec.includes('.m3u8') || dec.includes('.mpd')) {
        const sub = extractStreamsFromText(dec, referer);
        if (sub) return sub;
      }
    } catch (e) {}
  }

  // 7. Raw m3u8 or mpd URL in text/scripts
  const rawM3u8 = text.match(/https?:\/\/[^"'\s<>\\]+\.m3u8(?:\?[^"'\s<>\\]*)?/i);
  if (rawM3u8) {
    return { mode: 'hls', streamUrls: [rawM3u8[0]], referer };
  }

  const rawMpd = text.match(/https?:\/\/[^"'\s<>\\]+\.mpd(?:\?[^"'\s<>\\]*)?/i);
  if (rawMpd) {
    return { mode: 'dash', streamUrls: [rawMpd[0]], clearKeys: null, referer };
  }

  return null;
}

// Multi-hop recursive stream resolver (NEVER returns external web pages or falls back to embed)
async function resolveStream(startUrl) {
  let currentUrl = startUrl.startsWith('/') ? 'https://pirlotv.la' + startUrl : startUrl;
  let referer = 'https://pirlotv.la/';

  for (let hop = 0; hop < 6; hop++) {
    // Decode ?r= base64 redirection parameter if present
    const b64 = currentUrl.match(/[?&]r=([a-zA-Z0-9+/=]+)/);
    if (b64) {
      try {
        currentUrl = Buffer.from(b64[1], 'base64').toString('utf8');
      } catch (e) {}
    }
    if (currentUrl.startsWith('//')) currentUrl = 'https:' + currentUrl;

    const safety = isSafeExternalUrl(currentUrl);
    if (!safety.safe) {
      console.warn(`[Resolver Hop ${hop}] Blocked by SSRF:`, safety.reason);
      break;
    }

    try {
      const res = await safeFetch(currentUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Referer': referer,
          'Origin': new URL(referer).origin
        }
      });
      if (!res.ok) break;
      const html = await res.text();

      // Check for stream manifests in the current HTML/scripts
      const found = extractStreamsFromText(html, currentUrl);
      if (found) {
        return {
          ok: true,
          hop,
          targetUrl: currentUrl,
          ...found
        };
      }

      // If no stream in current layer, scan for legitimate video iframes
      // First strip comments to avoid fake/dead iframes
      const cleanHtml = html.replace(/<!--[\s\S]*?-->/g, '');
      const iframeMatches = [...cleanHtml.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);

      // Filter out tracking, ads, social and blank iframes
      const validIframes = iframeMatches.filter(src => {
        const lower = src.toLowerCase();
        return (
          !lower.includes('chat') &&
          !lower.includes('ads') &&
          !lower.includes('doubleclick') &&
          !lower.includes('facebook') &&
          !lower.includes('twitter') &&
          !lower.includes('about:blank') &&
          !lower.includes('whos.amung') &&
          !lower.includes('histats') &&
          !lower.includes('google')
        );
      });

      if (validIframes.length === 0) break;

      // Select the most promising video player iframe
      const chosenIframe = validIframes.find(src =>
        src.includes('cdplay') ||
        src.includes('xstream') ||
        src.includes('gate') ||
        src.includes('embed') ||
        src.includes('player') ||
        src.includes('stream') ||
        src.includes('.php')
      ) || validIframes[0];

      referer = currentUrl;
      let nextUrl = chosenIframe.trim();
      if (nextUrl.startsWith('//')) {
        nextUrl = 'https:' + nextUrl;
      } else if (nextUrl.startsWith('/')) {
        nextUrl = new URL(nextUrl, currentUrl).href;
      } else if (!nextUrl.startsWith('http')) {
        nextUrl = new URL(nextUrl, currentUrl).href;
      }
      currentUrl = nextUrl;
    } catch (e) {
      console.warn(`[Resolver Hop ${hop} Error]:`, e.message);
      break;
    }
  }

  // Pure stream extraction: if no stream was extracted, report cleanly without falling back to embedding web pages
  return {
    ok: false,
    error: 'No se pudo extraer el flujo de video directo para esta opción'
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

// Stream resolver
app.get('/api/resolve', async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ ok: false, error: 'Parámetro url es obligatorio' });
  }

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
// 5. Verification & Speed Benchmark Endpoint (/api/probe-fastest)
// --------------------------------------------------------------------------
app.post('/api/probe-fastest', async (req, res) => {
  const options = req.body && Array.isArray(req.body.options) ? req.body.options : [];
  if (options.length === 0) {
    return res.status(400).json({ ok: false, error: 'Lista de opciones vacía' });
  }

  // Probe all options in parallel
  const probePromises = options.map(async (opt, index) => {
    try {
      const resolved = await resolveStream(opt.url);
      if (!resolved || !resolved.ok || !resolved.streamUrls || resolved.streamUrls.length === 0) {
        return {
          ...opt,
          index,
          available: false,
          latencyMs: 9999,
          mode: 'unavailable',
          error: resolved?.error || 'Sin flujo extraído'
        };
      }

      const testTarget = resolved.streamUrls[0];
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);
      const probeStart = performance.now();

      try {
        const testRes = await fetch(testTarget, {
          method: 'GET',
          headers: {
            'User-Agent': USER_AGENT,
            'Referer': resolved.referer || 'https://xstream.st/',
            'Origin': new URL(resolved.referer || 'https://xstream.st/').origin
          },
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        // Cancel streaming body immediately to prevent bandwidth waste
        if (testRes.body && testRes.body.cancel) {
          testRes.body.cancel().catch(() => {});
        }

        const latencyMs = Math.round(performance.now() - probeStart);
        const isOk = testRes.ok || testRes.status === 200 || testRes.status === 206;

        return {
          ...opt,
          index,
          available: isOk,
          latencyMs: isOk ? latencyMs : 9999,
          mode: resolved.mode,
          resolvedStream: resolved
        };
      } catch (probeErr) {
        clearTimeout(timeoutId);
        return {
          ...opt,
          index,
          available: false,
          latencyMs: 9999,
          mode: resolved.mode,
          error: probeErr.message
        };
      }
    } catch (err) {
      return {
        ...opt,
        index,
        available: false,
        latencyMs: 9999,
        mode: 'error',
        error: err.message
      };
    }
  });

  const settled = await Promise.allSettled(probePromises);
  const results = settled.map((s, i) =>
    s.status === 'fulfilled' ? s.value : { ...options[i], index: i, available: false, latencyMs: 9999 }
  );

  // Filter and sort: available streams first ordered by latencyMs ascending
  results.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
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
// 6. Network Info (Mobile LAN Handoff)
// --------------------------------------------------------------------------
app.get('/api/network-info', (req, res) => {
  const interfaces = os.networkInterfaces();
  let localIp = '127.0.0.1';

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

    const lines = playlist.split('\n');
    const rewritten = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Rewrite URI attributes like #EXT-X-KEY or #EXT-X-MAP
      if (trimmed.startsWith('#')) {
        return line.replace(/URI=["']([^"']+)["']/g, (m, uri) => {
          let absUri = (uri.startsWith('http://') || uri.startsWith('https://')) ? uri : new URL(uri, basePath).href;
          return `URI="/api/stream/ts?url=${encodeURIComponent(absUri)}&referer=${encodeURIComponent(referer)}"`;
        });
      }

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
// 8. Ultra-Fast Zero-RAM Streaming Proxy (.ts, .m4s, .mp4, .aac)
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

    // Determine correct content type based on segment extension
    let contentType = 'video/mp2t';
    const lowerUrl = targetUrl.toLowerCase();
    if (lowerUrl.includes('.m4s') || lowerUrl.includes('.mp4')) {
      contentType = 'video/mp4';
    } else if (lowerUrl.includes('.aac')) {
      contentType = 'audio/aac';
    }

    res.setHeader('Content-Type', contentType);
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

    // Zero-RAM streaming via Readable.fromWeb
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
    if (err.name === 'AbortError') return;
    console.error('Video segment streaming error:', err.message);
    if (!res.headersSent) {
      res.status(502).send('Error streaming video segment: ' + err.message);
    }
  }
});

// Start server
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n======================================================`);
  console.log(`⚡ MiTV Broadcast Server activo en http://0.0.0.0:${PORT}`);
  console.log(`📡 Extractor Nativo HLS/DASH • Cero Páginas Externas • Zero-RAM`);
  console.log(`======================================================\n`);
  await refreshCache();
});
