import net from 'net';

/**
 * MiTV - Advanced CLI Stream Probe & Diagnostics Tool
 * Tests stream deobfuscation, multi-hop iframe traversal, and HLS manifest availability.
 */

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Container-safe flags for Chromium/Playwright (Hugging Face Spaces non-root execution)
export const CONTAINER_BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run'
];

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 0) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
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
  let trimmed = rawUrl.trim();
  if (trimmed.startsWith('//')) {
    trimmed = 'https:' + trimmed;
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (e) {
    try {
      parsed = new URL(trimmed, 'https://pirlotv.la/');
    } catch (e2) {
      return { safe: false, reason: 'Formato de URL no válido' };
    }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `Protocolo no permitido: ${parsed.protocol}` };
  }

  const rawHostname = parsed.hostname.toLowerCase();
  const cleanHost = rawHostname.replace(/^\[|\]$/g, '');

  if (
    rawHostname === 'localhost' ||
    rawHostname.endsWith('.localhost') ||
    rawHostname.endsWith('.local') ||
    rawHostname.endsWith('.internal') ||
    rawHostname.endsWith('.lan') ||
    rawHostname.endsWith('.home') ||
    rawHostname.endsWith('.corp') ||
    rawHostname === 'metadata.google.internal' ||
    cleanHost === '127.0.0.1' ||
    cleanHost === '0.0.0.0' ||
    cleanHost === '169.254.169.254' ||
    cleanHost === '::1' ||
    cleanHost === '::' ||
    cleanHost === '0:0:0:0:0:0:0:1' ||
    cleanHost === '0:0:0:0:0:0:0:0' ||
    isPrivateIp(cleanHost)
  ) {
    return { safe: false, reason: 'Acceso a host local, red privada o metadata prohibido (Anti-SSRF)' };
  }

  return { safe: true, url: parsed.href };
}

function normalizeSourceUrl(rawUrl, base = 'https://pirlotv.la/') {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let trimmed = rawUrl.trim();
  if (!trimmed || trimmed === 'about:blank') return null;
  if (trimmed.startsWith('//')) trimmed = 'https:' + trimmed;

  const b64Match = trimmed.match(/[?&]r=([a-zA-Z0-9+/=]+)/);
  if (b64Match) {
    try {
      const decodedParam = decodeURIComponent(b64Match[1]);
      const targetFromB64 = Buffer.from(decodedParam, 'base64').toString('utf8');
      if (targetFromB64 && targetFromB64.startsWith('http')) {
        let clean = targetFromB64;
        if (clean.includes('playvi.org')) {
          clean = clean.replace('playvi.org', 'cdplay.live');
        }
        return clean;
      }
    } catch (e) {}
  }

  try {
    return new URL(trimmed, base).href;
  } catch (e) {
    return null;
  }
}

async function safeFetchWithTimeout(url, headers = {}, timeoutMs = 12000) {
  const safety = isSafeExternalUrl(url);
  if (!safety.safe) {
    throw new Error(`SSRF bloqueado: ${safety.reason}`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        ...headers
      },
      signal: controller.signal,
      redirect: 'follow'
    });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractStreamsFromHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const found = new Set();

  // 1. Streamx dynamic playbackURL deobfuscator
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
        found.add(decoded);
      }
    } catch (e) {}
  }

  // 2. Shaka Player player.load(...)
  const shakaRegex = /player\.load\s*\(\s*["']([^"']+\.(?:m3u8|mpd)[^"']*)["']/gi;
  let shakaMatch;
  while ((shakaMatch = shakaRegex.exec(html)) !== null) {
    found.add(shakaMatch[1].replace(/\\\//g, '/'));
  }

  // 3. Variables: playbackURL, source, file, hlsUrl, streamUrl, src
  const varRegex = /(?:playbackURL|source|file|hlsUrl|streamUrl|src)\s*[:=]\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/gi;
  let varMatch;
  while ((varMatch = varRegex.exec(html)) !== null) {
    found.add(varMatch[1].replace(/\\\//g, '/'));
  }

  // 4. General var declarations
  const gvRegex = /(?:var|let|const)\s+\w+\s*=\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/gi;
  let gvMatch;
  while ((gvMatch = gvRegex.exec(html)) !== null) {
    found.add(gvMatch[1].replace(/\\\//g, '/'));
  }

  // 5. Raw m3u8
  const rawRegex = /["'](https?:\/\/[^"'\s<>\\]+\.m3u8(?:\?[^"'\s<>\\]*)?)["']/gi;
  let rawMatch;
  while ((rawMatch = rawRegex.exec(html)) !== null) {
    found.add(rawMatch[1]);
  }

  return Array.from(found);
}

function pickBestIframe(html, currentUrl) {
  if (!html) return null;
  const cleanHtml = html.replace(/<!--[\s\S]*?-->/g, '');
  const matches = [...cleanHtml.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
  const valid = matches.filter(src => {
    const lower = src.toLowerCase();
    return !['chat', 'ads', 'doubleclick', 'facebook', 'twitter', 'histats', 'about:blank'].some(b => lower.includes(b));
  });
  if (valid.length === 0) return null;
  const priority = valid.find(s => {
    const l = s.toLowerCase();
    return l.includes('?r=') || l.includes('cdplay') || l.includes('stream') || l.includes('player') || l.includes('embed');
  }) || valid[0];
  return normalizeSourceUrl(priority, currentUrl);
}

async function resolveStream(startUrl) {
  let currentUrl = normalizeSourceUrl(startUrl, 'https://pirlotv.la/');
  if (!currentUrl) {
    return { ok: false, error: 'URL no válida' };
  }
  const initSafety = isSafeExternalUrl(currentUrl);
  if (!initSafety.safe) {
    return { ok: false, error: initSafety.reason };
  }

  let referer = 'https://pirlotv.la/';
  let lastEmbed = currentUrl;

  for (let depth = 0; depth < 5; depth++) {
    lastEmbed = currentUrl;
    const depthSafety = isSafeExternalUrl(currentUrl);
    if (!depthSafety.safe) {
      console.log(`[Depth ${depth}] Bloqueado por Anti-SSRF: ${depthSafety.reason}`);
      break;
    }

    try {
      const res = await safeFetchWithTimeout(currentUrl, { Referer: referer }, 12000);
      if (!res.ok) {
        console.log(`[Depth ${depth}] HTTP ${res.status} para ${currentUrl}`);
        break;
      }
      const html = await res.text();

      const streams = extractStreamsFromHtml(html);
      if (streams.length > 0) {
        return {
          ok: true,
          mode: 'hls',
          streamUrls: streams,
          embedUrl: currentUrl,
          referer,
          depth
        };
      }

      const nextIframe = pickBestIframe(html, currentUrl);
      if (!nextIframe) break;

      console.log(`[Depth ${depth}] -> Iframe detectado: ${nextIframe}`);
      referer = currentUrl;
      currentUrl = nextIframe;
    } catch (e) {
      console.log(`[Depth ${depth}] Error (${currentUrl}):`, e.message);
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

async function run() {
  const options = [
    { name: 'Canal 1 (Capo)', url: '/capo-deportes.php' },
    { name: 'Canal 2 (Eventos)', url: '/eventos.php?r=aHR0cHM6Ly9jZHBsYXkubGl2ZS9sYWxpZ2ExLnBocA==' },
    { name: 'Canal 3 HD', url: '/eventoshd.php?r=aHR0cHM6Ly9jZHBsYXkubGl2ZS9saWdhbXg2LnBocA==' },
    { name: 'Canal 4 HD (Liga MX 7)', url: '/eventoshd.php?r=aHR0cHM6Ly9jZHBsYXkubGl2ZS9saWdhbXg3LnBocA==' },
    { name: 'Canal 5 HD', url: '/eventoshd.php?r=aHR0cHM6Ly9jZHBsYXkubGl2ZS9saWdhbXg4LnBocA==' }
  ];

  console.log(`================ MiTV CLI Stream Probe ================`);
  for (const opt of options) {
    console.log(`\n--- Probando ${opt.name} ---`);
    const res = await resolveStream(opt.url);
    console.log('Resultado:', JSON.stringify(res, null, 2));
  }
}

run();
