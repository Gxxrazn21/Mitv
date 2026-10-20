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
      const res = await fetch(currentUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Referer': referer
        }
      });
      if (!res.ok) {
        console.log(`[Depth ${depth}] HTTP ${res.status} for ${currentUrl}`);
        break;
      }
      const html = await res.text();

      const m3u8Match = html.match(/const streamUrls\s*=\s*(\[[^\]]+\])/i);
      if (m3u8Match) {
        const streamUrls = JSON.parse(m3u8Match[1].replace(/\\u0026/g, '&'));
        return { ok: true, streamUrls, embedUrl: currentUrl, referer, depth };
      }

      // Check for Clappr / source
      const clapprMatch = html.match(/source:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
      if (clapprMatch) {
        return { ok: true, streamUrls: [clapprMatch[1]], embedUrl: currentUrl, referer, depth };
      }

      const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (!iframeMatch) {
        console.log(`[Depth ${depth}] No iframe found in ${currentUrl}, snippet:\n`, html.substring(0, 300));
        break;
      }

      console.log(`[Depth ${depth}] ${currentUrl} -> Iframe: ${iframeMatch[1]}`);
      referer = currentUrl;
      currentUrl = iframeMatch[1];
    } catch (e) {
      console.log(`[Depth ${depth}] Error:`, e.message);
      break;
    }
  }

  return { ok: true, streamUrls: [], embedUrl: lastEmbed, referer };
}

async function run() {
  const options = [
    { name: 'Canal 1', url: '/capo-deportes.php' },
    { name: 'Canal 2', url: '/eventos.php?r=aHR0cHM6Ly9jZHBsYXkubGl2ZS9sYWxpZ2ExLnBocA==' },
    { name: 'Canal 3', url: '/eventoshd.php?r=aHR0cHM6Ly9jZHBsYXkubGl2ZS9sYWxpZ2EyLnBocA==' },
    { name: 'Canal 4', url: '/eventoshd.php?r=aHR0cHM6Ly9jZHBsYXkubGl2ZS9sYWxpZ2EzLnBocA==' },
    { name: 'Canal 5', url: '/eventoshd.php?r=aHR0cHM6Ly9jZHBsYXkubGl2ZS9sYWxpZ2E0LnBocA==' },
    { name: 'Canal 6', url: '/eventoshd.php?r=aHR0cHM6Ly9jZHBsYXkubGl2ZS9sYWxpZ2E5LnBocA==' }
  ];

  for (const opt of options) {
    console.log(`\n================ Testing ${opt.name} ================`);
    const res = await resolveStream(opt.url);
    console.log('Result:', JSON.stringify(res, null, 2));
  }
}
run();
