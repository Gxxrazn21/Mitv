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
// 1. URL Normalization & Anti-SSRF Validation
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

// Universal URL normalizer
function normalizeSourceUrl(rawUrl, base = 'https://pirlotv.la/') {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let trimmed = rawUrl.trim();
  if (!trimmed || trimmed === 'about:blank') return null;

  // Handle protocol-relative URL
  if (trimmed.startsWith('//')) {
    trimmed = 'https:' + trimmed;
  }

  // Handle Base64 parameter ?r=
  const b64Match = trimmed.match(/[?&]r=([a-zA-Z0-9+/=]+)/);
  if (b64Match) {
    try {
      const decodedParam = decodeURIComponent(b64Match[1]);
      const targetFromB64 = Buffer.from(decodedParam, 'base64').toString('utf8');
      if (targetFromB64 && targetFromB64.startsWith('http')) {
        return targetFromB64;
      }
    } catch (e) {}
  }

  try {
    return new URL(trimmed, base).href;
  } catch (e) {
    return null;
  }
}

async function safeFetch(url, options = {}, timeoutMs = 9000) {
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
        const rawUrl = optMatch[1].trim();
        const rawName = optMatch[2].trim();

        if (IGNORED_PATHS.some(ign => rawUrl.toLowerCase().includes(ign) || rawName.toLowerCase().includes('dmca') || rawName.toLowerCase().includes('aviso'))) {
          continue;
        }

        const normalizedUrl = normalizeSourceUrl(rawUrl, 'https://pirlotv.la/');
        if (!normalizedUrl) continue;

        options.push({
          url: normalizedUrl,
          rawUrl,
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
  if (!html || typeof html !== 'string') return channels;
  // Support both <li><a href="#"> and <div class="menu"><a href="#">
  const parts = html.split(/(?:<li[^>]*>|<div class=["']menu["']>)\s*<a href=["']#["']>/i);

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
        const rawUrl = optMatch[1].trim();
        const name = optMatch[2].trim();
        const normalizedUrl = normalizeSourceUrl(rawUrl, 'https://pirlotv.la/');
        if (!normalizedUrl) continue;

        options.push({
          url: normalizedUrl,
          rawUrl,
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
      else if (upper.includes('TYC') || upper.includes('GOL') || upper.includes('LIGA 1')) category = 'Fútbol TV';
      else if (upper.includes('FORMULA 1') || upper.includes('F1')) category = 'Motorsport';
      else if (upper.includes('TELEMUNDO') || upper.includes('UNIVERSO') || upper.includes('TUDN')) category = 'Internacionales';

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

function extractFallbackChannels(homeHtml) {
  const BASELINE_CHANNELS = [
    { name: 'DSPORTS (DirecTV Sports)', category: 'DSPORTS', options: [
      { name: 'Opción 1 SD', url: 'https://pirlotv.la/en-vivo/dsports.php', isHD: false },
      { name: 'Opción 2 HD', url: 'https://pirlotv.la/eventoshd.php?r=aHR0cHM6Ly9wbGF5dmkub3JnL2RzcG9ydHNoZC5waHA=', isHD: true }
    ]},
    { name: 'DSPORTS 2', category: 'DSPORTS', options: [
      { name: 'Opción 1 SD', url: 'https://pirlotv.la/en-vivo/dsports-2.php', isHD: false },
      { name: 'Opción 2 HD', url: 'https://pirlotv.la/eventoshd.php?r=aHR0cHM6Ly9wbGF5dmkub3JnL2RzcG9ydHMyaGQucGhw', isHD: true }
    ]},
    { name: 'DSPORTS +', category: 'DSPORTS', options: [
      { name: 'Opción 1 SD', url: 'https://pirlotv.la/en-vivo/dsports-plus.php', isHD: false },
      { name: 'Opción 2 HD', url: 'https://pirlotv.la/eventoshd.php?r=aHR0cHM6Ly9wbGF5dmkub3JnL2RzcG9ydHNwbHVzaGQucGhw', isHD: true }
    ]},
    { name: 'ESPN', category: 'ESPN', options: [
      { name: 'Opción 1 SD', url: 'https://pirlotv.la/en-vivo/espn.php', isHD: false },
      { name: 'Opción 2 HD', url: 'https://pirlotv.la/eventoshd.php?r=aHR0cHM6Ly9wbGF5dmkub3JnL2VzcG5oZC5waHA=', isHD: true }
    ]},
    { name: 'ESPN 2', category: 'ESPN', options: [
      { name: 'Opción 1 SD', url: 'https://pirlotv.la/en-vivo/espn-2.php', isHD: false },
      { name: 'Opción 2 HD', url: 'https://pirlotv.la/eventoshd.php?r=aHR0cHM6Ly9wbGF5dmkub3JnL2VzcG4yaGQucGhw', isHD: true }
    ]},
    { name: 'ESPN 3', category: 'ESPN', options: [
      { name: 'Opción 1 SD', url: 'https://pirlotv.la/en-vivo/espn-3.php', isHD: false },
      { name: 'Opción 2 HD', url: 'https://pirlotv.la/eventoshd.php?r=aHR0cHM6Ly9wbGF5dmkub3JnL2VzcG4zaGQucGhw', isHD: true }
    ]},
    { name: 'ESPN 4', category: 'ESPN', options: [
      { name: 'Opción 1 SD', url: 'https://pirlotv.la/en-vivo/espn-4.php', isHD: false },
      { name: 'Opción 2 HD', url: 'https://pirlotv.la/eventoshd.php?r=aHR0cHM6Ly9wbGF5dmkub3JnL2VzcG40aGQucGhw', isHD: true }
    ]},
    { name: 'ESPN 5', category: 'ESPN', options: [
      { name: 'Opción 1 SD', url: 'https://pirlotv.la/en-vivo/espn-5.php', isHD: false },
      { name: 'Opción 2 HD', url: 'https://pirlotv.la/eventoshd.php?r=aHR0cHM6Ly9wbGF5dmkub3JnL2VzcG41aGQucGhw', isHD: true }
    ]},
    { name: 'ESPN Premium Argentina', category: 'ESPN', options: [
      { name: 'Opción 1 SD', url: 'https://pirlotv.la/en-vivo/espn-premium.php', isHD: false },
      { name: 'Opción 2 HD', url: 'https://pirlotv.la/eventoshd.php?r=aHR0cHM6Ly9wbGF5dmkub3JnL2VzcG5wcmVtaXVtaGQucGhw', isHD: true }
    ]},
    { name: 'TNT Sports Premium Argentina', category: 'TNT Sports', options: [
      { name: 'Opción 1 SD', url: 'https://pirlotv.la/en-vivo/tnt-sports-argentina.php', isHD: false },
      { name: 'Opción 2 HD', url: 'https://pirlotv.la/eventoshd.php?r=aHR0cHM6Ly9wbGF5dmkub3JnL3RudGFyZ2VudGluYWhkLnBocA==', isHD: true }
    ]},
    { name: 'TNT Sports Premium Chile', category: 'TNT Sports', options: [
      { name: 'Opción 1 SD', url: 'https://pirlotv.la/en-vivo/tnt-sports-chile.php', isHD: false },
      { name: 'Opción 2 HD', url: 'https://pirlotv.la/eventoshd.php?r=aHR0cHM6Ly9wbGF5dmkub3JnL3RudGNoaWxlaGQucGhw', isHD: true }
    ]},
    { name: 'Win Sports', category: 'Win Sports', options: [
      { name: 'Opción 1 SD', url: 'https://pirlotv.la/en-vivo/win-sports.php', isHD: false },
      { name: 'Opción 2 HD', url: 'https://pirlotv.la/eventoshd.php?r=aHR0cHM6Ly9wbGF5dmkub3JnL3dpbnNwb3J0c2hkLnBocA==', isHD: true }
    ]},
    { name: 'Win Sports +', category: 'Win Sports', options: [
      { name: 'Opción 1 SD', url: 'https://pirlotv.la/en-vivo/win-sports-plus.php', isHD: false },
      { name: 'Opción 2 HD', url: 'https://pirlotv.la/eventoshd.php?r=aHR0cHM6Ly9wbGF5dmkub3JnL3dpbnNwb3J0c3BsdXNoZC5waHA=', isHD: true }
    ]},
    { name: 'TUDN', category: 'Internacionales', options: [
      { name: 'Opción 1 SD', url: 'https://pirlotv.la/en-vivo/tudn.php', isHD: false },
      { name: 'Opción 2 HD', url: 'https://pirlotv.la/eventoshd.php?r=aHR0cHM6Ly9wbGF5dmkub3JnL3R1ZG5oZC5waHA=', isHD: true }
    ]},
    { name: 'Formula 1', category: 'Motorsport', options: [
      { name: 'Opción 1 SD', url: 'https://pirlotv.la/en-vivo/formula-1.php', isHD: false },
      { name: 'Opción 2 HD', url: 'https://pirlotv.la/eventoshd.php?r=aHR0cHM6Ly9wbGF5dmkub3JnL2Zvcm11bGExaGQucGhw', isHD: true }
    ]},
    { name: 'Capo Deportes 1', category: 'Capo Deportes', options: [
      { name: 'Opción 1 SD', url: 'https://pirlotv.la/capo-deportes.php', isHD: false }
    ]},
    { name: 'Capo Deportes 2', category: 'Capo Deportes', options: [
      { name: 'Opción 1 SD', url: 'https://pirlotv.la/capo-deportes-2.php', isHD: false }
    ]}
  ];

  return BASELINE_CHANNELS.map((b, idx) => ({
    id: 'chan-fallback-' + (idx + 1),
    name: b.name,
    category: b.category,
    options: b.options
  }));
}

async function refreshCache() {
  try {
    let homeHtml = null;
    let chanHtml = null;

    try {
      const homeRes = await safeFetch('https://pirlotv.la/');
      if (homeRes.ok) homeHtml = await homeRes.text();
    } catch (e) {
      console.warn('[Cache] Error fetching home:', e.message);
    }

    try {
      const chanRes = await safeFetch('https://pirlotv.la/canales-en-vivo.php');
      if (chanRes.ok) chanHtml = await chanRes.text();
    } catch (e) {
      console.warn('[Cache] Error fetching canales:', e.message);
    }

    if (homeHtml) {
      cache.matches = parseMatches(homeHtml);
    }

    let parsedChannels = [];
    if (chanHtml) {
      parsedChannels = parseChannels(chanHtml);
    }

    if (parsedChannels.length < 5) {
      console.log(`[Cache] Canales insuficientes (${parsedChannels.length}), activando catálogo de respaldo...`);
      parsedChannels = extractFallbackChannels(homeHtml);
    }

    cache.channels = parsedChannels;
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

// Extract .m3u8 or .mpd stream URLs from HTML text & scripts
function extractStreamsFromHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const foundUrls = new Set();

  // 1. Check window._econfig
  const econfigMatch = html.match(/window\._econfig\s*=\s*['"]([^'"]+)['"]/);
  if (econfigMatch) {
    const dec = decodeEConfig(econfigMatch[1]);
    if (dec) {
      if (dec.stream_url && dec.stream_url.includes('.m3u8')) foundUrls.add(dec.stream_url);
      if (dec.stream_url_nop2p && dec.stream_url_nop2p.includes('.m3u8')) foundUrls.add(dec.stream_url_nop2p);
    }
  }

  // 2. Streamx / Clappr dynamic playbackURL deobfuscator (eventoshd / cdplay.live)
  const streamxMatch = html.match(/(\w+)\s*=\s*(\[\[\d+,\s*["'][A-Za-z0-9+/=]+["']\][\s\S]*?\]);\s*\1\.sort\b[\s\S]*?var\s+k\s*=\s*(\w+)\(\)\s*\+\s*(\w+)\(\);[\s\S]*?function\s+\3\(\)\s*\{\s*return\s*(\d+);[\s\S]*?function\s+\4\(\)\s*\{\s*return\s*(\d+);/);
  if (streamxMatch) {
    try {
      const rawArr = JSON.parse(streamxMatch[2]);
      const k = parseInt(streamxMatch[5], 10) + parseInt(streamxMatch[6], 10);
      rawArr.sort((a, b) => a[0] - b[0]);
      let decoded = '';
      rawArr.forEach(e => {
        const v = e[1];
        const atobVal = Buffer.from(v, 'base64').toString('binary');
        const num = parseInt(atobVal.replace(/\D/g, ''), 10);
        decoded += String.fromCharCode(num - k);
      });
      if (decoded.startsWith('http') && (decoded.includes('.m3u8') || decoded.includes('.mpd'))) {
        foundUrls.add(decoded);
      }
    } catch (e) {}
  }

  // 3. Shaka Player player.load(...) detection (canales HD)
  const shakaRegex = /player\.load\s*\(\s*["']([^"']+\.(?:m3u8|mpd)[^"']*)["']/gi;
  let shakaMatch;
  while ((shakaMatch = shakaRegex.exec(html)) !== null) {
    foundUrls.add(shakaMatch[1].replace(/\\\//g, '/'));
  }

  // 4. Variables: playbackURL, source, file, hlsUrl, streamUrl, src
  const varRegex = /(?:playbackURL|source|file|hlsUrl|streamUrl|src)\s*[:=]\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/gi;
  let varMatch;
  while ((varMatch = varRegex.exec(html)) !== null) {
    foundUrls.add(varMatch[1].replace(/\\\//g, '/'));
  }

  // 5. General variable capture: var/let/const name = "https://...m3u8"
  const gvRegex = /(?:var|let|const)\s+\w+\s*=\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/gi;
  let gvMatch;
  while ((gvMatch = gvRegex.exec(html)) !== null) {
    foundUrls.add(gvMatch[1].replace(/\\\//g, '/'));
  }

  // 6. Arrays: streamUrls, urls, sources
  const arrRegex = /(?:streamUrls|urls|sources)\s*=\s*(\[[^\]]+\])/gi;
  let arrMatch;
  while ((arrMatch = arrRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(arrMatch[1].replace(/\\u0026/g, '&'));
      if (Array.isArray(parsed)) {
        parsed.forEach(u => {
          if (typeof u === 'string' && u.includes('.m3u8')) foundUrls.add(u);
        });
      }
    } catch (e) {}
  }

  // 7. Server-side atob calls with flexible quotes and spaces
  const atobRegex = /atob\s*\(\s*['"]\s*([A-Za-z0-9+/=]{20,})\s*['"]\s*\)/g;
  let atobMatch;
  while ((atobMatch = atobRegex.exec(html)) !== null) {
    try {
      const dec = Buffer.from(atobMatch[1].trim(), 'base64').toString('utf8');
      if (dec.startsWith('http') && (dec.includes('.m3u8') || dec.includes('.mpd'))) {
        foundUrls.add(dec);
      }
    } catch (e) {}
  }

  // 8. Packed scripts
  const packedMatch = html.match(/eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d[\s\S]*?\)\s*\)/);
  if (packedMatch) {
    const unpacked = unpackDeanEdwards(packedMatch[0]);
    if (unpacked) {
      const sub = extractStreamsFromHtml(unpacked);
      sub.forEach(u => foundUrls.add(u));
    }
  }

  // 9. Raw .m3u8 URL in quotes
  const rawRegex = /["'](https?:\/\/[^"'\s<>\\]+\.m3u8(?:\?[^"'\s<>\\]*)?)["']/gi;
  let rawMatch;
  while ((rawMatch = rawRegex.exec(html)) !== null) {
    foundUrls.add(rawMatch[1]);
  }

  return Array.from(foundUrls);
}

// Intelligent Iframe Selector
function pickBestIframe(html, currentUrl) {
  if (!html) return null;
  // 1. Remove HTML comments first
  const cleanHtml = html.replace(/<!--[\s\S]*?-->/g, '');
  const matches = [...cleanHtml.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);

  const valid = matches.filter(src => {
    const lower = src.toLowerCase();
    return (
      !lower.includes('chat') &&
      !lower.includes('ads') &&
      !lower.includes('doubleclick') &&
      !lower.includes('facebook') &&
      !lower.includes('twitter') &&
      !lower.includes('histats') &&
      !lower.includes('whos.amung') &&
      !lower.includes('about:blank') &&
      !lower.includes('google')
    );
  });

  if (valid.length === 0) return null;

  // Prioritize iframes containing player/stream keywords or ?r=
  const priority = valid.find(src => {
    const l = src.toLowerCase();
    return l.includes('?r=') || l.includes('cdplay') || l.includes('xstream') || l.includes('streamtp') || l.includes('embed') || l.includes('player');
  }) || valid[0];

  return normalizeSourceUrl(priority, currentUrl);
}

// Multi-hop recursive stream resolver
async function resolveStream(startUrl) {
  let currentUrl = normalizeSourceUrl(startUrl, 'https://pirlotv.la/');
  if (!currentUrl) {
    return { ok: false, error: 'URL no válida' };
  }

  let referer = 'https://pirlotv.la/';
  let lastNonPirloEmbed = null;

  for (let hop = 0; hop < 6; hop++) {
    const safety = isSafeExternalUrl(currentUrl);
    if (!safety.safe) {
      console.warn(`[Resolver Hop ${hop}] Blocked by SSRF:`, safety.reason);
      break;
    }

    // Keep track of the last player embed that is NOT pirlotv.la
    if (!currentUrl.includes('pirlotv.la')) {
      lastNonPirloEmbed = currentUrl;
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

      // Check for direct .m3u8 stream manifests
      const streams = extractStreamsFromHtml(html);
      if (streams.length > 0) {
        return {
          ok: true,
          mode: 'hls',
          streamUrls: streams,
          targetUrl: currentUrl,
          referer: currentUrl,
          hop
        };
      }

      // Check for intelligent iframe
      const nextIframe = pickBestIframe(html, currentUrl);
      if (!nextIframe) break;

      referer = currentUrl;
      currentUrl = nextIframe;
    } catch (e) {
      console.warn(`[Resolver Hop ${hop} Error]:`, e.message);
      break;
    }
  }

  // If no direct .m3u8 was found, but we reached a real non-pirlotv player (Shaka / Clappr / DRM embed)
  if (lastNonPirloEmbed && !lastNonPirloEmbed.includes('pirlotv.la')) {
    return {
      ok: true,
      mode: 'embed',
      embedUrl: `/player/clean-embed?url=${encodeURIComponent(lastNonPirloEmbed)}&referer=${encodeURIComponent(referer)}`,
      rawEmbedUrl: lastNonPirloEmbed,
      streamUrls: [],
      referer
    };
  }

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

  const normalized = normalizeSourceUrl(url, 'https://pirlotv.la/');
  if (!normalized) {
    return res.status(400).json({ ok: false, error: 'Formato de URL inválido' });
  }

  const safety = isSafeExternalUrl(normalized);
  if (!safety.safe) {
    return res.status(403).json({ ok: false, error: safety.reason });
  }

  try {
    const result = await resolveStream(normalized);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------------------------------------------------------------
// 5. Parallel Speed & Latency Benchmark (/api/probe-fastest)
// --------------------------------------------------------------------------
app.post('/api/probe-fastest', async (req, res) => {
  const options = req.body && Array.isArray(req.body.options) ? req.body.options : [];
  if (options.length === 0) {
    return res.status(400).json({ ok: false, error: 'Lista de opciones vacía' });
  }

  const probePromises = options.map(async (opt, index) => {
    try {
      const resolved = await resolveStream(opt.url);
      if (!resolved || !resolved.ok) {
        return {
          ...opt,
          index,
          available: false,
          latencyMs: 9999,
          mode: 'unavailable',
          error: resolved?.error || 'Sin señal'
        };
      }

      if (resolved.mode === 'hls' && resolved.streamUrls && resolved.streamUrls.length > 0) {
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
              'Origin': new URL(resolved.referer || 'https://xstream.st/').origin,
              'Connection': 'keep-alive'
            },
            signal: controller.signal
          });
          clearTimeout(timeoutId);

          // Cancel body immediately after reading headers so probe takes < 500ms
          testRes.body?.cancel().catch(() => {});

          const latencyMs = Math.round(performance.now() - probeStart);
          const isOk = testRes.ok || testRes.status === 200 || testRes.status === 206;

          return {
            ...opt,
            index,
            available: isOk,
            latencyMs: isOk ? latencyMs : 9999,
            mode: 'hls',
            resolvedStream: resolved
          };
        } catch (probeErr) {
          clearTimeout(timeoutId);
          return {
            ...opt,
            index,
            available: false,
            latencyMs: 9999,
            mode: 'hls',
            error: probeErr.message
          };
        }
      } else if (resolved.mode === 'embed' && resolved.rawEmbedUrl) {
        // Probe embed player availability
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        const probeStart = performance.now();
        try {
          const testRes = await fetch(resolved.rawEmbedUrl, {
            method: 'GET',
            headers: {
              'User-Agent': USER_AGENT,
              'Referer': resolved.referer || 'https://cdplay.live/'
            },
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          if (testRes.body && testRes.body.cancel) testRes.body.cancel().catch(() => {});
          const latencyMs = Math.round(performance.now() - probeStart);

          return {
            ...opt,
            index,
            available: testRes.ok || testRes.status === 405,
            latencyMs: latencyMs + 80, // slight offset for player shell
            mode: 'embed',
            resolvedStream: resolved
          };
        } catch (embedErr) {
          clearTimeout(timeoutId);
          return {
            ...opt,
            index,
            available: true,
            latencyMs: 800,
            mode: 'embed',
            resolvedStream: resolved
          };
        }
      }

      return { ...opt, index, available: false, latencyMs: 9999, mode: 'unknown' };
    } catch (err) {
      return { ...opt, index, available: false, latencyMs: 9999, mode: 'error', error: err.message };
    }
  });

  const settled = await Promise.allSettled(probePromises);
  const results = settled.map((s, i) =>
    s.status === 'fulfilled' ? s.value : { ...options[i], index: i, available: false, latencyMs: 9999 }
  );

  // Sorting: Available HLS first sorted by latencyMs asc, then available embed by latencyMs asc, then unavailable
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
// 7. M3U8 Playlist Proxy (Correct URL Resolution with new URL(trimmed, targetUrl))
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
    let originHeader = 'https://xstream.st';
    try {
      originHeader = new URL(referer).origin;
    } catch (e) {}

    const response = await safeFetch(targetUrl, {
      headers: {
        'Referer': referer,
        'Origin': originHeader
      }
    });

    if (!response.ok) {
      return res.status(response.status).send(`Fallo al obtener m3u8: ${response.statusText}`);
    }

    const playlist = await response.text();

    // Rewrite playlist lines safely with new URL(line, targetUrl).href
    const lines = playlist.split('\n');
    const rewritten = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Rewrite URI attributes like #EXT-X-KEY or #EXT-X-MAP
      if (trimmed.startsWith('#')) {
        return line.replace(/URI=["']([^"']+)["']/g, (m, uri) => {
          let absUri = uri;
          try {
            absUri = new URL(uri, targetUrl).href;
          } catch (e) {}
          return `URI="/api/stream/ts?url=${encodeURIComponent(absUri)}&referer=${encodeURIComponent(referer)}"`;
        });
      }

      // Media chunk or sub-playlist URL
      let absoluteTarget = trimmed;
      try {
        absoluteTarget = new URL(trimmed, targetUrl).href;
      } catch (e) {}

      const isSubPlaylist = absoluteTarget.includes('.m3u8');
      const endpoint = isSubPlaylist ? '/api/stream/m3u8' : '/api/stream/ts';
      return `${endpoint}?url=${encodeURIComponent(absoluteTarget)}&referer=${encodeURIComponent(referer)}`;
    }).join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Keep-Alive', 'timeout=30, max=1000');
    res.send(rewritten);
  } catch (err) {
    console.error('M3U8 proxy error:', err.message);
    res.status(502).send('Error proxying m3u8: ' + err.message);
  }
});

// --------------------------------------------------------------------------
// 8. Ultra-Fast Zero-RAM Segment Streaming Proxy (.ts, .m4s, .mp4, .aac)
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
    let originHeader = 'https://xstream.st';
    try {
      originHeader = new URL(referer).origin;
    } catch (e) {}

    const upstreamHeaders = {
      'User-Agent': USER_AGENT,
      'Referer': referer,
      'Origin': originHeader,
      'Connection': 'keep-alive'
    };

    if (req.headers.range) {
      upstreamHeaders['Range'] = req.headers.range;
    }

    const response = await fetch(targetUrl, {
      headers: upstreamHeaders,
      signal: controller.signal
    });

    if (!response.ok && response.status !== 206) {
      return res.status(response.status).send('Fallo al obtener segmento');
    }

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
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Keep-Alive', 'timeout=30, max=1000');

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
      nodeStream.on('error', () => {
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

// --------------------------------------------------------------------------
// 9. Isolated Clean-Embed Proxy for DRM / Shaka Channels
// --------------------------------------------------------------------------
app.get('/player/clean-embed', async (req, res) => {
  let embedUrl = req.query.url;
  const referer = req.query.referer || 'https://cdplay.live/';

  if (!embedUrl || embedUrl === 'about:blank') {
    return res.status(400).send('Parámetro url faltante');
  }

  embedUrl = normalizeSourceUrl(embedUrl, referer);
  if (!embedUrl) {
    return res.status(400).send('URL inválida');
  }

  const safety = isSafeExternalUrl(embedUrl);
  if (!safety.safe) {
    return res.status(403).send(`Acceso denegado: ${safety.reason}`);
  }

  let originHeader = 'https://cdplay.live';
  try {
    originHeader = new URL(embedUrl).origin;
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
        <html><head><meta charset="UTF-8"><style>body{background:#070709;color:#9ca3af;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}</style></head>
        <body><p>⚠️ Señal temporalmente no disponible (${response.status})</p></body></html>
      `);
    }

    let html = await response.text();

    // 1. Remove anti-iframe and trap instructions inside scripts without destroying player code
    html = html
      .replace(/if\s*\(\s*window\s*==\s*window\.top\s*\)\s*\{[^}]*\}/gi, '')
      .replace(/location\[t\[5\]\]\s*=\s*["'][^"']*(?:block|sandbox)\.html["']/gi, 'void 0')
      .replace(/location\.href\s*=\s*["'][^"']*(?:block|sandbox)\.html["']/gi, 'void 0')
      .replace(/window\.location\s*=\s*["'][^"']*(?:block|sandbox)\.html["']/gi, 'void 0')
      .replace(/hasAttribute\(\s*["']sandbox["']\s*\)/gi, 'false')
      .replace(/aclib\.runPop\([\s\S]*?\);?/gi, '');

    // 2. Remove external ad scripts only (keep player & clappr/shaka engines intact)
    html = html.replace(/<script\s+type=["']text\/javascript["']\s+data-cfasync=["']false["']>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<script[^>]*src=["'][^"']*(?:aclib|histats|waust|popads|adcash|exoclick|dtscout|llvpn|tag\.min\.js|intellipopup|pa-H_qzm|r2\.dev|propeller)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<script[^>]*id=["'](?:_wauksz|aclib)["']>[\s\S]*?<\/script>/gi, '');

    // 3. Rewrite internal iframes to route through clean-embed with sandbox
    html = html.replace(/<iframe\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>/gi, (match, prefix, srcUrl, suffix) => {
      const resolved = normalizeSourceUrl(srcUrl, embedUrl);
      if (!resolved) return '';
      const proxiedSrc = `/player/clean-embed?url=${encodeURIComponent(resolved)}&referer=${encodeURIComponent(embedUrl)}`;
      return `<iframe ${prefix} src="${proxiedSrc}" sandbox="allow-scripts allow-same-origin allow-forms allow-presentation" ${suffix}>`;
    });

    // 4. Inject base tag and strict security shield & postMessage controller
    const baseTag = `<base href="${embedUrl}">`;
    const cleanShieldInjection = `
      ${baseTag}
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
        video, #player, #clappr, .player-poster, .shaka-video-container, [data-player], iframe {
          position: fixed !important;
          inset: 0 !important;
          width: 100vw !important;
          height: 100vh !important;
          max-width: 100vw !important;
          max-height: 100vh !important;
          border: none !important;
          z-index: 10 !important;
        }
        #player, #clappr {
          display: block !important;
          width: 100% !important;
          height: 100% !important;
        }
        .banner, #chat, .chat-box, div[style*="z-index: 2147483647"], div[style*="z-index:999999"], div[class*="banner"] {
          display: none !important;
          pointer-events: none !important;
        }
      </style>
      <script>
        // Neutralize popups and redirects
        window.open = function() { return null; };
        window.alert = function() { return false; };
        window.confirm = function() { return false; };
        window.prompt = function() { return null; };
        try { Object.defineProperty(window, 'top', { get: () => window.self }); } catch(e){}

        // Handle Audio Mute/Unmute & Fit messages from parent
        window.addEventListener('message', function(event) {
          try {
            const data = event.data;
            if (!data || typeof data !== 'object') return;

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
            }

            if (data.type === 'SET_FIT') {
              const fit = data.fit || 'contain';
              document.querySelectorAll('video, #player, #clappr, .shaka-video-container, [data-player]').forEach(function(el) {
                el.style.setProperty('object-fit', fit, 'important');
              });
            }
          } catch(err) {}
        });

        // Notify parent on click/pointerdown to activate slot
        function notifySlotClick() {
          try {
            window.parent.postMessage({ type: 'SLOT_CLICKED', slotName: window.name }, '*');
          } catch(e) {}
        }
        window.addEventListener('pointerdown', notifySlotClick, true);
        window.addEventListener('click', notifySlotClick, true);
      </script>
    `;

    if (html.includes('<head>')) {
      html = html.replace('<head>', '<head>' + cleanShieldInjection);
    } else {
      html = cleanShieldInjection + html;
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

// Start server
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n======================================================`);
  console.log(`⚡ MiTV Studio Server activo en http://0.0.0.0:${PORT}`);
  console.log(`📺 Diseño Apple TV / YouTube TV Dark • Zero-RAM Stream`);
  console.log(`======================================================\n`);
  await refreshCache();
});
