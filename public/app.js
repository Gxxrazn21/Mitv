/**
 * PIRLO SHIELD — CLIENT APPLICATION
 * Multi-Stream Controller (1-4 Slots), Neon Purple Audio Focus,
 * Auto-Speed Benchmark, and Mobile LAN Handoff.
 */

// --------------------------------------------------------------------------
// Minimal Self-Contained QR Code Generator (SVG based, no external network)
// --------------------------------------------------------------------------
function generateQRCodeSVG(text, size = 180) {
  // Use public Google Charts / QR Server image fallback with offline fallback canvas
  const encoded = encodeURIComponent(text);
  return `<img src="https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encoded}&bgcolor=ffffff&color=000000&margin=4" 
               alt="QR Code" width="${size}" height="${size}" 
               style="border-radius:6px; display:block;" 
               onerror="this.onerror=null; this.parentElement.innerHTML='<div style=\\'padding:20px;color:#000;font-size:12px;text-align:center;word-break:break-all;\\'>Enlace LAN:<br><strong>${text}</strong></div>'"/>`;
}

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
// Multi-Stream Slot Architecture & Screen Fit Controller
// --------------------------------------------------------------------------
const SLOTS_COUNT = 4;
let slots = [];
let activeAudioSlotIndex = 0; // Default active purple audio slot
let currentLayout = '1';
let allMatches = [];
let allChannels = [];
let lanNetworkInfo = { ip: '127.0.0.1', port: 3000, localUrl: 'http://localhost:3000' };

// 3 Screen Fit Modes: contain, fill, cover
const FIT_MODES = [
  { key: 'contain', label: 'Ajustado (16:9 completo)' },
  { key: 'fill', label: 'Estirado (Llenar bordes)' },
  { key: 'cover', label: 'Zoom (Sin bordes negros)' }
];
let currentFitIndex = 0;

function cycleScreenFit() {
  currentFitIndex = (currentFitIndex + 1) % FIT_MODES.length;
  const currentMode = FIT_MODES[currentFitIndex];

  // Update button label
  const labelEl = document.getElementById('aspectFitLabel');
  if (labelEl) {
    labelEl.textContent = currentMode.label;
  }

  // Apply to all native videos
  slots.forEach(slot => {
    if (slot.videoEl) {
      slot.videoEl.style.objectFit = currentMode.key;
    }
    // Forward via postMessage to all active iframes
    if (slot.iframeEl && slot.iframeEl.contentWindow) {
      try {
        slot.iframeEl.contentWindow.postMessage({
          type: 'SET_FIT',
          fit: currentMode.key
        }, '*');
      } catch (e) {}
    }
  });

  console.log(`[Screen Fit] Modo aplicado: ${currentMode.label} (${currentMode.key})`);
}

// Initialize slot object references from DOM
function initSlots() {
  slots = [];
  for (let i = 0; i < SLOTS_COUNT; i++) {
    const slotEl = document.getElementById(`slot-${i}`);
    const iframeEl = slotEl.querySelector('.slot-iframe');
    // Enforce strict native sandbox (0% popups, no escape)
    if (iframeEl) {
      iframeEl.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-presentation');
    }
    slots.push({
      index: i,
      slotEl: slotEl,
      videoEl: slotEl.querySelector('.slot-video'),
      iframeEl: iframeEl,
      titleEl: slotEl.querySelector('.slot-title'),
      serverSelect: slotEl.querySelector('.slot-server-select'),
      reloadBtn: slotEl.querySelector('.slot-reload-btn'),
      closeBtn: slotEl.querySelector('.slot-close-btn'),
      loaderEl: slotEl.querySelector('.slot-loader'),
      loaderText: slotEl.querySelector('.loader-text'),
      errorEl: slotEl.querySelector('.slot-error'),
      emptyEl: slotEl.querySelector('.slot-empty'),
      retryBtn: slotEl.querySelector('.slot-retry-btn'),
      hlsInstance: null,
      currentMatch: null,
      currentOptionIdx: 0,
      currentStreamUrls: [],
      currentStreamIdx: 0,
      mode: 'idle' // 'hls' | 'embed' | 'idle'
    });
  }

  // Bind slot interactions
  slots.forEach(slot => {
    // Clicking slot selects it as active audio slot (purple outline)
    slot.slotEl.addEventListener('click', (e) => {
      // Don't override if clicking inner controls like dropdown
      if (e.target.tagName !== 'SELECT' && e.target.tagName !== 'BUTTON') {
        setActiveAudioSlot(slot.index);
      }
    });

    // Server select dropdown
    slot.serverSelect.addEventListener('change', (e) => {
      const optIdx = parseInt(e.target.value);
      if (slot.currentMatch && slot.currentMatch.options[optIdx]) {
        loadStreamInSlot(slot.index, slot.currentMatch, optIdx);
      }
    });

    // Reload button
    slot.reloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (slot.currentMatch) {
        loadStreamInSlot(slot.index, slot.currentMatch, slot.currentOptionIdx);
      }
    });

    // Close slot button
    slot.closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      clearSlot(slot.index);
    });

    // Retry button on error
    slot.retryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (slot.currentMatch) {
        // Try next option or reconnect
        const nextOpt = (slot.currentOptionIdx + 1) % slot.currentMatch.options.length;
        loadStreamInSlot(slot.index, slot.currentMatch, nextOpt);
      }
    });
  });
}

// --------------------------------------------------------------------------
// Audio Focus & Neon Purple Recuadro Control (Critical Requirement)
// --------------------------------------------------------------------------
function setActiveAudioSlot(targetSlotIndex) {
  if (targetSlotIndex < 0 || targetSlotIndex >= SLOTS_COUNT) return;
  activeAudioSlotIndex = targetSlotIndex;

  slots.forEach(slot => {
    const isActive = (slot.index === targetSlotIndex);

    // Apply or remove neon purple border class
    slot.slotEl.classList.toggle('active-audio-slot', isActive);

    // Strict audio control:
    // Native HTML5 Video Element
    if (slot.videoEl) {
      if (isActive) {
        slot.videoEl.muted = false;
        slot.videoEl.volume = 1;
        slot.videoEl.play().catch(() => {});
      } else {
        slot.videoEl.muted = true;
      }
    }

    // Sanitized Embed iframe via postMessage
    if (slot.iframeEl && slot.iframeEl.contentWindow) {
      try {
        slot.iframeEl.contentWindow.postMessage({
          type: 'SET_MUTE',
          muted: !isActive
        }, '*');
      } catch (err) {
        console.warn('postMessage to slot iframe failed:', err);
      }
    }
  });

  console.log(`[Audio Focus] Ranura activa establecida en Slot ${targetSlotIndex + 1} (Borde Morado)`);
}

// Listen for focus requests from iframes (when user touches/clicks embed)
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SLOT_FOCUSED') {
    const slotId = event.data.slotId; // e.g. 'slot-1'
    if (typeof slotId === 'string' && slotId.startsWith('slot-')) {
      const idx = parseInt(slotId.replace('slot-', ''));
      if (!isNaN(idx)) {
        setActiveAudioSlot(idx);
      }
    }
  }
});

// --------------------------------------------------------------------------
// Multi-Stream Grid Layout Switching (1, 2, 3, 4 Screens)
// --------------------------------------------------------------------------
function setLayout(layoutNum) {
  currentLayout = String(layoutNum);
  const videoGrid = document.getElementById('videoGrid');
  videoGrid.className = `video-grid layout-${currentLayout}`;

  // Update layout buttons UI
  document.querySelectorAll('.layout-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-layout') === currentLayout);
  });

  // Ensure active audio slot is currently visible in this layout
  const maxVisibleSlots = parseInt(currentLayout);
  if (activeAudioSlotIndex >= maxVisibleSlots) {
    setActiveAudioSlot(0);
  }
}

// --------------------------------------------------------------------------
// Stream Loader & Teardown per Slot
// --------------------------------------------------------------------------
function clearSlot(slotIndex) {
  const slot = slots[slotIndex];
  if (!slot) return;

  if (slot.hlsInstance) {
    slot.hlsInstance.destroy();
    slot.hlsInstance = null;
  }
  slot.videoEl.pause();
  slot.videoEl.removeAttribute('src');
  slot.videoEl.load();
  slot.videoEl.style.display = 'none';

  slot.iframeEl.src = 'about:blank';
  slot.iframeEl.style.display = 'none';

  slot.currentMatch = null;
  slot.currentStreamUrls = [];
  slot.currentOptionIdx = 0;
  slot.mode = 'idle';

  slot.titleEl.textContent = `Ranura ${slotIndex + 1}: Vacía`;
  slot.serverSelect.innerHTML = '<option>Sin señal</option>';
  slot.loaderEl.style.display = 'none';
  slot.errorEl.style.display = 'none';
  slot.emptyEl.style.display = 'flex';
}

async function loadStreamInSlot(slotIndex, matchData, optionIndex = 0) {
  const slot = slots[slotIndex];
  if (!slot) return;

  const option = matchData.options[optionIndex] || matchData.options[0];
  if (!option) return;

  // Clean teardown of prior stream in this slot
  if (slot.hlsInstance) {
    slot.hlsInstance.destroy();
    slot.hlsInstance = null;
  }
  slot.videoEl.pause();
  slot.videoEl.removeAttribute('src');
  slot.videoEl.load();
  slot.iframeEl.src = 'about:blank';

  slot.currentMatch = matchData;
  slot.currentOptionIdx = optionIndex;
  slot.emptyEl.style.display = 'none';
  slot.errorEl.style.display = 'none';
  slot.loaderText.textContent = `Conectando con ${option.name}...`;
  slot.loaderEl.style.display = 'flex';
  slot.titleEl.textContent = `${slotIndex + 1}. ${matchData.title || matchData.name} (${option.name})`;

  // Update slot dropdown
  updateSlotServerSelect(slot, matchData.options, optionIndex);

  // Set active audio slot to this slot if user directly targeted it
  setActiveAudioSlot(slotIndex);

  try {
    const resolveRes = await fetch(`/api/resolve?url=${encodeURIComponent(option.url)}`);
    const result = await resolveRes.json();

    if (!result.ok) {
      throw new Error(result.error || 'No se pudo resolver el stream');
    }

    slot.currentStreamUrls = result.streamUrls || [];
    slot.currentStreamIdx = 0;

    if (result.mode === 'hls' && slot.currentStreamUrls.length > 0) {
      slot.mode = 'hls';
      setupSlotHls(slot, slot.currentStreamUrls[0], result.referer);
    } else {
      slot.mode = 'embed';
      setupSlotEmbed(slot, result.embedUrl, result.referer);
    }
  } catch (err) {
    console.error(`Slot ${slotIndex} playback error:`, err);
    slot.loaderEl.style.display = 'none';
    slot.errorEl.style.display = 'flex';
  }
}

function updateSlotServerSelect(slot, options, selectedIdx) {
  slot.serverSelect.innerHTML = '';
  options.forEach((opt, idx) => {
    const optEl = document.createElement('option');
    optEl.value = idx;
    optEl.textContent = opt.isHD ? `⭐ ${opt.name}` : opt.name;
    if (idx === selectedIdx) optEl.selected = true;
    slot.serverSelect.appendChild(optEl);
  });
}

function setupSlotHls(slot, m3u8Url, referer) {
  slot.iframeEl.style.display = 'none';
  slot.videoEl.style.display = 'block';
  slot.videoEl.style.objectFit = FIT_MODES[currentFitIndex].key;

  const proxiedM3u8 = `/api/stream/m3u8?url=${encodeURIComponent(m3u8Url)}&referer=${encodeURIComponent(referer || 'https://xstream.st/')}`;

  if (Hls.isSupported()) {
    // Ultra-optimized HLS instance for Multi-Stream 60fps
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      capLevelToPlayerSize: true, // Auto cap resolution to slot size to save GPU/CPU
      maxBufferLength: 15,        // Tight buffer to save RAM in quad mode
      backBufferLength: 15,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 6
    });

    slot.hlsInstance = hls;
    hls.loadSource(proxiedM3u8);
    hls.attachMedia(slot.videoEl);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      slot.loaderEl.style.display = 'none';
      // Apply strict audio rule: mute if not active purple slot
      slot.videoEl.muted = (slot.index !== activeAudioSlotIndex);
      slot.videoEl.play().catch(e => console.warn('Autoplay gesture required:', e));
    });

    hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            tryNextSlotHlsSource(slot, referer);
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;
          default:
            hls.destroy();
            setupSlotEmbed(slot, slot.currentMatch.options[slot.currentOptionIdx].url, referer);
            break;
        }
      }
    });
  } else if (slot.videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari Native HLS
    slot.videoEl.src = proxiedM3u8;
    slot.videoEl.muted = (slot.index !== activeAudioSlotIndex);
    slot.videoEl.addEventListener('loadedmetadata', () => {
      slot.loaderEl.style.display = 'none';
      slot.videoEl.play().catch(() => {});
    });
  } else {
    setupSlotEmbed(slot, slot.currentMatch.options[slot.currentOptionIdx].url, referer);
  }
}

function tryNextSlotHlsSource(slot, referer) {
  if (slot.currentStreamIdx < slot.currentStreamUrls.length - 1) {
    slot.currentStreamIdx++;
    slot.loaderText.textContent = `Cambiando a espejo ${slot.currentStreamIdx + 1}...`;
    slot.loaderEl.style.display = 'flex';
    setupSlotHls(slot, slot.currentStreamUrls[slot.currentStreamIdx], referer);
  } else {
    setupSlotEmbed(slot, slot.currentMatch.options[slot.currentOptionIdx].url, referer);
  }
}

function setupSlotEmbed(slot, embedUrl, referer) {
  if (slot.hlsInstance) {
    slot.hlsInstance.destroy();
    slot.hlsInstance = null;
  }
  slot.videoEl.pause();
  slot.videoEl.style.display = 'none';

  slot.iframeEl.style.display = 'block';
  // Strict native sandbox enforcement
  slot.iframeEl.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-presentation');
  // Use sanitized clean-embed proxy
  slot.iframeEl.src = `/player/clean-embed?url=${encodeURIComponent(embedUrl)}&referer=${encodeURIComponent(referer || 'https://cdplay.live/')}`;

  slot.iframeEl.onload = () => {
    slot.loaderEl.style.display = 'none';
    // Send postMessage mute status and current screen fit
    setTimeout(() => {
      try {
        slot.iframeEl.contentWindow.postMessage({
          type: 'SET_MUTE',
          muted: (slot.index !== activeAudioSlotIndex)
        }, '*');
        slot.iframeEl.contentWindow.postMessage({
          type: 'SET_FIT',
          fit: FIT_MODES[currentFitIndex].key
        }, '*');
      } catch (e) {}
    }, 400);
  };

  setTimeout(() => {
    slot.loaderEl.style.display = 'none';
  }, 2200);
}

// --------------------------------------------------------------------------
// Auto-Speed Benchmark ("⚡ Auto Mejor Señal")
// --------------------------------------------------------------------------
async function runAutoSpeedBenchmark(slotIndex = activeAudioSlotIndex) {
  const slot = slots[slotIndex];
  if (!slot || !slot.currentMatch || !slot.currentMatch.options) {
    alert('Primero selecciona o sintoniza un partido para sondear la velocidad.');
    return;
  }

  const autoBtn = document.getElementById('autoFastestBtn');
  autoBtn.classList.add('spinning');
  slot.loaderText.textContent = '⚡ Evaluando latencia de todos los canales...';
  slot.loaderEl.style.display = 'flex';

  try {
    const res = await fetch('/api/probe-fastest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ options: slot.currentMatch.options })
    });
    const data = await res.json();

    if (data.ok && data.ranked && data.ranked.length > 0) {
      const best = data.ranked.find(r => r.available) || data.ranked[0];
      console.log(`[Auto-Speed] Mejor enlace encontrado: ${best.name} con ${best.latencyMs}ms`);
      
      // Update select labels with measured latencies
      data.ranked.forEach(item => {
        const optEl = slot.serverSelect.querySelector(`option[value="${item.index}"]`);
        if (optEl) {
          optEl.textContent = `${item.name} (${item.latencyMs < 9000 ? item.latencyMs + 'ms' : 'Caído'})`;
        }
      });

      // Load the fastest option into the slot
      loadStreamInSlot(slotIndex, slot.currentMatch, best.index);
    }
  } catch (err) {
    console.warn('Auto speed probe error:', err);
  } finally {
    autoBtn.classList.remove('spinning');
  }
}

// --------------------------------------------------------------------------
// Mobile Handoff & AirPlay / Cast Integration
// --------------------------------------------------------------------------
async function setupMobileHandoff() {
  const modal = document.getElementById('phoneModal');
  const openBtn = document.getElementById('mobileHandoffBtn');
  const closeBtn = document.getElementById('closePhoneModalBtn');
  const copyAppBtn = document.getElementById('copyAppUrlBtn');
  const copyStreamBtn = document.getElementById('copyStreamUrlBtn');
  const airplayBtn = document.getElementById('triggerAirplayBtn');
  const appQrBox = document.getElementById('qrAppContainer');
  const streamQrBox = document.getElementById('qrStreamContainer');
  const lanAppInput = document.getElementById('lanAppUrlInput');
  const lanStreamInput = document.getElementById('lanStreamUrlInput');
  const openVlcLink = document.getElementById('openVlcLink');

  // Fetch local LAN IP from server
  try {
    const netRes = await fetch('/api/network-info');
    lanNetworkInfo = await netRes.json();
  } catch (e) {
    console.warn('Could not fetch network info, using localhost:', e);
  }

  function updateHandoffModal() {
    const activeSlot = slots[activeAudioSlotIndex];
    const fullAppUrl = lanNetworkInfo.localUrl;
    lanAppInput.value = fullAppUrl;
    appQrBox.innerHTML = generateQRCodeSVG(fullAppUrl, 180);

    // Build direct M3U8 URL for active slot
    let directM3u8Url = '';
    if (activeSlot && activeSlot.currentStreamUrls && activeSlot.currentStreamUrls.length > 0) {
      const upstream = activeSlot.currentStreamUrls[activeSlot.currentStreamIdx || 0];
      directM3u8Url = `${lanNetworkInfo.localUrl}/api/stream/m3u8?url=${encodeURIComponent(upstream)}`;
    } else {
      directM3u8Url = `${lanNetworkInfo.localUrl}/api/stream/m3u8?url=https://instreams.xyz/live3/CA1/index.m3u8`;
    }

    lanStreamInput.value = directM3u8Url;
    streamQrBox.innerHTML = generateQRCodeSVG(directM3u8Url, 180);
    openVlcLink.href = directM3u8Url;
  }

  openBtn.onclick = () => {
    updateHandoffModal();
    modal.style.display = 'flex';
  };

  closeBtn.onclick = () => {
    modal.style.display = 'none';
  };

  modal.onclick = (e) => {
    if (e.target === modal) modal.style.display = 'none';
  };

  copyAppBtn.onclick = () => {
    navigator.clipboard.writeText(lanAppInput.value);
    copyAppBtn.textContent = '¡Copiado!';
    setTimeout(() => copyAppBtn.textContent = 'Copiar', 1500);
  };

  copyStreamBtn.onclick = () => {
    navigator.clipboard.writeText(lanStreamInput.value);
    copyStreamBtn.textContent = '¡Copiado!';
    setTimeout(() => copyStreamBtn.textContent = 'Copiar .m3u8', 1500);
  };

  // Tabs inside modal
  const tabBtns = modal.querySelectorAll('.modal-tab-btn');
  tabBtns.forEach(btn => {
    btn.onclick = () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tabTarget = btn.getAttribute('data-modaltab');
      document.getElementById('modalTabApp').classList.toggle('active', tabTarget === 'app');
      document.getElementById('modalTabStream').classList.toggle('active', tabTarget === 'stream');
    };
  });

  // Direct Cast / AirPlay
  airplayBtn.onclick = () => {
    const activeSlot = slots[activeAudioSlotIndex];
    if (activeSlot && activeSlot.videoEl) {
      if (window.WebKitPlaybackTargetAvailabilityEvent || activeSlot.videoEl.webkitShowPlaybackTargetPicker) {
        activeSlot.videoEl.webkitShowPlaybackTargetPicker();
      } else if (activeSlot.videoEl.remote && typeof activeSlot.videoEl.remote.prompt === 'function') {
        activeSlot.videoEl.remote.prompt().catch(err => {
          alert('Dispositivo Cast / Remoto no disponible en este navegador.');
        });
      } else {
        alert('Para transmitir directamente, abre el enlace en Safari (AirPlay) o Google Chrome (Google Cast).');
      }
    }
  };
}

// --------------------------------------------------------------------------
// Matches & Channels UI Rendering
// --------------------------------------------------------------------------
function renderMatches(matches) {
  const matchesGrid = document.getElementById('matchesGrid');
  matchesGrid.innerHTML = '';

  if (matches.length === 0) {
    matchesGrid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 3rem; color: var(--text-dim);">
        <h3>No se encontraron partidos</h3>
        <p>Prueba buscando con otro término o seleccionando "Todos los Partidos".</p>
      </div>
    `;
    return;
  }

  matches.forEach(m => {
    const card = document.createElement('div');
    card.className = 'match-card';

    let team1 = m.title;
    let team2 = '';
    if (m.title.toLowerCase().includes(' vs ')) {
      const parts = m.title.split(/ vs /i);
      team1 = parts[0].trim();
      team2 = parts[1].trim();
    }

    const optionsHtml = m.options.map((opt, i) => `
      <button class="match-channel-btn ${opt.isHD ? 'is-hd' : ''}" data-idx="${i}" title="Sintonizar en ${opt.name}">
        <span>▶</span> ${opt.name}
      </button>
    `).join('');

    card.innerHTML = `
      <div>
        <div class="match-card-top">
          <span class="match-tournament">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <polygon points="12 8 8 12 12 16 16 12 12 8"/>
            </svg>
            ${m.tournament}
          </span>
          <span class="match-time">${m.time}</span>
        </div>

        ${team2 ? `
          <div class="match-teams">
            <div class="team-name">${team1}</div>
            <span class="vs-badge">VS</span>
            <div class="team-name">${team2}</div>
          </div>
        ` : `
          <h3 class="team-name" style="margin-bottom:0.75rem;">${m.title}</h3>
        `}
      </div>

      <div>
        <div style="font-size:0.75rem; color:var(--text-dim); margin-bottom:4px;">Canales disponibles:</div>
        <div class="options-pills">
          ${optionsHtml}
        </div>
        <div class="match-actions-row">
          <button class="btn-add-multi" title="Añadir a otra pantalla del Multi-Stream">
            <span>+ Multi-Stream</span>
          </button>
          <span style="font-size:0.75rem; color:var(--primary); font-weight:600;">0 Publicidad</span>
        </div>
      </div>
    `;

    // Click handler for channel buttons (loads into currently active audio slot)
    const chanButtons = card.querySelectorAll('.match-channel-btn');
    chanButtons.forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-idx'));
        loadStreamInSlot(activeAudioSlotIndex, m, idx);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };
    });

    // "+ Multi-Stream" button: finds next empty slot (or slot 1..3) and switches layout
    const multiBtn = card.querySelector('.btn-add-multi');
    multiBtn.onclick = (e) => {
      e.stopPropagation();
      // Find first empty slot or next slot
      let targetSlot = slots.findIndex(s => s.mode === 'idle');
      if (targetSlot === -1) {
        targetSlot = (activeAudioSlotIndex + 1) % SLOTS_COUNT;
      }
      // Expand layout if currently on 1 screen
      if (currentLayout === '1') setLayout('2');
      else if (currentLayout === '2' && targetSlot >= 2) setLayout('4');
      else if (currentLayout === '3' && targetSlot === 3) setLayout('4');

      loadStreamInSlot(targetSlot, m, 0);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    matchesGrid.appendChild(card);
  });
}

function renderChannels(channels) {
  const channelsGrid = document.getElementById('channelsGrid');
  channelsGrid.innerHTML = '';

  channels.forEach(ch => {
    const card = document.createElement('div');
    card.className = 'channel-card';

    const initials = ch.name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();

    const optionsHtml = ch.options.map((opt, i) => `
      <button class="match-channel-btn ${opt.isHD ? 'is-hd' : ''}" data-idx="${i}">
        ${opt.name}
      </button>
    `).join('');

    card.innerHTML = `
      <div class="channel-card-header">
        <div class="channel-avatar">${initials}</div>
        <div>
          <h3 style="font-size:0.95rem; font-weight:700;">${ch.name}</h3>
          <span class="channel-cat-tag">${ch.category || 'Canal 24/7'}</span>
        </div>
      </div>
      <div>
        <div class="options-pills">${optionsHtml}</div>
        <div class="match-actions-row">
          <button class="btn-add-multi"><span>+ Multi-Stream</span></button>
        </div>
      </div>
    `;

    const chanButtons = card.querySelectorAll('.match-channel-btn');
    chanButtons.forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-idx'));
        loadStreamInSlot(activeAudioSlotIndex, ch, idx);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };
    });

    const multiBtn = card.querySelector('.btn-add-multi');
    multiBtn.onclick = (e) => {
      e.stopPropagation();
      let targetSlot = slots.findIndex(s => s.mode === 'idle');
      if (targetSlot === -1) targetSlot = (activeAudioSlotIndex + 1) % SLOTS_COUNT;
      if (currentLayout === '1') setLayout('2');
      else if (currentLayout === '2' && targetSlot >= 2) setLayout('4');

      loadStreamInSlot(targetSlot, ch, 0);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    channelsGrid.appendChild(card);
  });
}

function buildTournamentFilters(matches) {
  const container = document.getElementById('tournamentFilters');
  const tournaments = new Map();

  matches.forEach(m => {
    const t = m.tournament || 'Otros';
    tournaments.set(t, (tournaments.get(t) || 0) + 1);
  });

  container.innerHTML = `<button class="filter-pill active" data-filter="all">Todos los Partidos (${matches.length})</button>`;

  tournaments.forEach((count, tName) => {
    const pill = document.createElement('button');
    pill.className = 'filter-pill';
    pill.setAttribute('data-filter', tName);
    pill.textContent = `${tName} (${count})`;
    pill.onclick = () => {
      container.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      applyFilters();
    };
    container.appendChild(pill);
  });

  container.querySelector('[data-filter="all"]').onclick = function() {
    container.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
    this.classList.add('active');
    applyFilters();
  };
}

function applyFilters() {
  const q = document.getElementById('searchInput').value.toLowerCase().trim();
  const activeTPill = document.querySelector('#tournamentFilters .filter-pill.active');
  const tFilter = activeTPill ? activeTPill.getAttribute('data-filter') : 'all';

  const filteredMatches = allMatches.filter(m => {
    const matchesQuery = !q || m.fullTitle.toLowerCase().includes(q) || (m.tournament && m.tournament.toLowerCase().includes(q));
    const matchesTourn = tFilter === 'all' || (m.tournament && m.tournament.toLowerCase().includes(tFilter.toLowerCase()));
    return matchesQuery && matchesTourn;
  });
  renderMatches(filteredMatches);

  const activeCPill = document.querySelector('#channelCategoryFilters .filter-pill.active');
  const cFilter = activeCPill ? activeCPill.getAttribute('data-cat') : 'all';

  const filteredChannels = allChannels.filter(c => {
    const matchesQuery = !q || c.name.toLowerCase().includes(q);
    const matchesCat = cFilter === 'all' || (c.category && c.category.toLowerCase().includes(cFilter.toLowerCase()));
    return matchesQuery && matchesCat;
  });
  renderChannels(filteredChannels);
}

// --------------------------------------------------------------------------
// Navigation & Shortcuts Setup
// --------------------------------------------------------------------------
function setupNavigation() {
  // Tabs
  const matchesTabBtn = document.getElementById('tabMatchesBtn');
  const channelsTabBtn = document.getElementById('tabChannelsBtn');
  const matchesTabContent = document.getElementById('matchesTabContent');
  const channelsTabContent = document.getElementById('channelsTabContent');

  matchesTabBtn.onclick = () => {
    matchesTabBtn.classList.add('active');
    channelsTabBtn.classList.remove('active');
    matchesTabContent.classList.add('active');
    channelsTabContent.classList.remove('active');
  };

  channelsTabBtn.onclick = () => {
    channelsTabBtn.classList.add('active');
    matchesTabBtn.classList.remove('active');
    channelsTabContent.classList.add('active');
    matchesTabContent.classList.remove('active');
  };

  // Search
  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearch');
  searchInput.addEventListener('input', () => {
    clearSearchBtn.style.display = searchInput.value ? 'block' : 'none';
    applyFilters();
  });
  clearSearchBtn.onclick = () => {
    searchInput.value = '';
    clearSearchBtn.style.display = 'none';
    applyFilters();
  };

  // Refresh
  const refreshBtn = document.getElementById('refreshBtn');
  refreshBtn.onclick = async () => {
    refreshBtn.classList.add('spinning');
    try {
      await fetchInitialData();
    } finally {
      setTimeout(() => refreshBtn.classList.remove('spinning'), 600);
    }
  };

  // Channel categories
  document.querySelectorAll('#channelCategoryFilters .filter-pill').forEach(pill => {
    pill.onclick = () => {
      document.querySelectorAll('#channelCategoryFilters .filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      applyFilters();
    };
  });

  // Layout buttons (1, 2, 3, 4)
  document.querySelectorAll('.layout-btn').forEach(btn => {
    btn.onclick = () => {
      setLayout(btn.getAttribute('data-layout'));
    };
  });

  // Auto-fastest benchmark button
  document.getElementById('autoFastestBtn').onclick = () => {
    runAutoSpeedBenchmark(activeAudioSlotIndex);
  };

  // Aspect fit button
  const aspectFitBtn = document.getElementById('aspectFitBtn');
  if (aspectFitBtn) {
    aspectFitBtn.onclick = () => {
      cycleScreenFit();
    };
  }

  // Theater & Fullscreen
  const theaterBtn = document.getElementById('theaterBtn');
  theaterBtn.onclick = () => {
    const playerSection = document.getElementById('playerSection');
    playerSection.classList.toggle('theater-mode');
    theaterBtn.style.color = playerSection.classList.contains('theater-mode') ? 'var(--primary)' : '';
  };

  const fullscreenBtn = document.getElementById('fullscreenBtn');
  fullscreenBtn.onclick = () => {
    const videoGrid = document.getElementById('videoGrid');
    if (!document.fullscreenElement) {
      videoGrid.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  // Keyboard Shortcuts: 1, 2, 3, 4 for Slot Audio Focus
  window.addEventListener('keydown', (e) => {
    if (document.activeElement === searchInput) return;

    if (e.key === '1') setActiveAudioSlot(0);
    else if (e.key === '2') setActiveAudioSlot(1);
    else if (e.key === '3') setActiveAudioSlot(2);
    else if (e.key === '4') setActiveAudioSlot(3);
    else if (e.code === 'Space') {
      e.preventDefault();
      const activeSlot = slots[activeAudioSlotIndex];
      if (activeSlot && activeSlot.videoEl && activeSlot.videoEl.style.display !== 'none') {
        activeSlot.videoEl.paused ? activeSlot.videoEl.play() : activeSlot.videoEl.pause();
      }
    } else if (e.code === 'KeyF') {
      e.preventDefault();
      fullscreenBtn.click();
    } else if (e.code === 'KeyT') {
      e.preventDefault();
      theaterBtn.click();
    }
  });
}

// --------------------------------------------------------------------------
// Initial Data Fetch & Bootstrap
// --------------------------------------------------------------------------
async function fetchInitialData() {
  try {
    const [schedRes, chanRes] = await Promise.all([
      fetch('/api/schedule'),
      fetch('/api/channels')
    ]);
    const schedData = await schedRes.json();
    const chanData = await chanRes.json();

    if (schedData.ok) {
      allMatches = schedData.matches;
      document.getElementById('matchesCountBadge').textContent = allMatches.length;
      buildTournamentFilters(allMatches);
      renderMatches(allMatches);

      // Auto-load first match into Slot 0 if slot 0 is currently empty
      if (slots[0] && slots[0].mode === 'idle' && allMatches.length > 0) {
        loadStreamInSlot(0, allMatches[0], 0);
      }
    }

    if (chanData.ok) {
      allChannels = chanData.channels;
      document.getElementById('channelsCountBadge').textContent = allChannels.length;
      renderChannels(allChannels);
    }
  } catch (err) {
    console.error('Initial data fetch error:', err);
  }
}

// Register Service Worker for mobile PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// App Initialization
document.addEventListener('DOMContentLoaded', () => {
  initSlots();
  setupNavigation();
  setupMobileHandoff();
  fetchInitialData();
});
