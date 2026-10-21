/**
 * MiTV — APPLE TV / YOUTUBE TV DARK CLIENT APPLICATION
 * Dual-Engine Streaming Controller (HLS.js + Sandboxed Isolated Clean-Embed),
 * Multi-Stream (1, 2, 4 Slots), Purple Audio Focus, Retractable Sidebar,
 * GPU Image Sharpening Engine, Audio Dynamics Compressor,
 * Max-Bitrate HLS (1080p), Parallel Latency Benchmarking & Mobile LAN Handoff.
 */

const SLOTS_COUNT = 4;
let slots = [];
let focusedSlotIdx = 0;   // Default Slot 0 has purple outline and active audio
let currentLayout = '1';  // '1' | '2' | '4'
let currentTab = 'matches';
let currentFilter = 'all';
let searchQuery = '';

let allMatches = [];
let allChannels = [];
let lanNetworkInfo = { ip: '127.0.0.1', port: 3000, localUrl: 'http://localhost:3000' };

// 3 Screen Fit Modes: contain (16:9), fill (Llenar), cover (Zoom)
const FIT_MODES = [
  { key: 'contain', label: '16:9' },
  { key: 'fill', label: 'Llenar' },
  { key: 'cover', label: 'Zoom' }
];
let currentFitIdx = 0;

// 3 GPU Image Enhancement Modes: off, sharp, vivid
const ENHANCE_MODES = [
  { key: 'off', label: 'OFF', cssClass: '' },
  { key: 'sharp', label: 'HD Nitidez', cssClass: 'filter-sharp' },
  { key: 'vivid', label: 'Estadio Vivo', cssClass: 'filter-vivid' }
];
let currentEnhanceIdx = 0;

// Web Audio API Audio Normalizer (DynamicsCompressorNode)
let audioCtx = null;
let compressorNode = null;
const audioSourceMap = new Map(); // video element -> MediaElementAudioSourceNode

function setupAudioNormalizer(videoEl) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    if (!audioCtx) {
      audioCtx = new AudioContextClass();
      compressorNode = audioCtx.createDynamicsCompressor();
      compressorNode.threshold.setValueAtTime(-24, audioCtx.currentTime); // dB
      compressorNode.knee.setValueAtTime(30, audioCtx.currentTime);        // dB
      compressorNode.ratio.setValueAtTime(12, audioCtx.currentTime);       // compression ratio
      compressorNode.attack.setValueAtTime(0.003, audioCtx.currentTime);   // attack in sec
      compressorNode.release.setValueAtTime(0.25, audioCtx.currentTime);   // release in sec
      compressorNode.connect(audioCtx.destination);
    }

    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }

    if (!audioSourceMap.has(videoEl)) {
      const source = audioCtx.createMediaElementSource(videoEl);
      source.connect(compressorNode);
      audioSourceMap.set(videoEl, source);
    }
  } catch (err) {
    // If browser security blocks AudioContext cross-origin, audio plays normally through video tag
    console.debug('[Audio Normalizer] Info:', err.message);
  }
}

// --------------------------------------------------------------------------
// Initialization
// --------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  initSlots();
  setupUIEventListeners();
  setupKeyboardShortcuts();

  await Promise.all([
    fetchSchedule(),
    fetchChannels(),
    fetchNetworkInfo()
  ]);

  // Auto-tune first match in Slot 0
  if (allMatches.length > 0) {
    loadStreamInSlot(0, allMatches[0], 0);
  }
});

// --------------------------------------------------------------------------
// Slots Setup
// --------------------------------------------------------------------------
function initSlots() {
  slots = [];
  for (let i = 0; i < SLOTS_COUNT; i++) {
    const slotEl = document.getElementById(`slot-${i}`);
    const videoEl = slotEl.querySelector('.slot-video');
    const iframeEl = slotEl.querySelector('.slot-iframe');

    slots.push({
      index: i,
      slotEl,
      videoEl,
      iframeEl,
      titleEl: slotEl.querySelector('.slot-title'),
      loaderEl: slotEl.querySelector('.slot-loader'),
      loaderText: slotEl.querySelector('.loader-text'),
      errorEl: slotEl.querySelector('.slot-error'),
      errorText: slotEl.querySelector('.error-text'),
      emptyEl: slotEl.querySelector('.slot-empty'),
      reloadBtn: slotEl.querySelector('.slot-reload'),
      closeBtn: slotEl.querySelector('.slot-close'),
      retryBtn: slotEl.querySelector('.slot-retry-btn'),
      hlsInstance: null,
      currentMatch: null,
      currentOptionIdx: 0,
      networkRecovered: false,
      mode: 'idle' // 'hls' | 'embed' | 'idle'
    });
  }

  // Bind slot interactions
  slots.forEach(slot => {
    // Clicking slot selects it as the active audio slot
    slot.slotEl.addEventListener('click', (e) => {
      if (!e.target.closest('.slot-actions') && e.target.tagName !== 'BUTTON') {
        setFocusedSlot(slot.index);
      }
    });

    // Reload button
    slot.reloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (slot.currentMatch) {
        loadStreamInSlot(slot.index, slot.currentMatch, slot.currentOptionIdx);
      }
    });

    // Close button
    slot.closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      clearSlot(slot.index);
    });

    // Retry button on error
    slot.retryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (slot.currentMatch) {
        const nextOpt = (slot.currentOptionIdx + 1) % slot.currentMatch.options.length;
        loadStreamInSlot(slot.index, slot.currentMatch, nextOpt);
      }
    });

    // Video play events
    slot.videoEl.addEventListener('playing', () => {
      slot.loaderEl.style.display = 'none';
      slot.errorEl.style.display = 'none';
      slot.emptyEl.style.display = 'none';
      slot.networkRecovered = false;

      // Enable Web Audio normalizer when focused
      if (slot.index === focusedSlotIdx) {
        setupAudioNormalizer(slot.videoEl);
      }
    });

    // Iframe load event
    slot.iframeEl.addEventListener('load', () => {
      if (slot.mode === 'embed' && slot.iframeEl.src !== 'about:blank') {
        slot.loaderEl.style.display = 'none';
        slot.errorEl.style.display = 'none';
        slot.emptyEl.style.display = 'none';
      }
    });
  });
}

// --------------------------------------------------------------------------
// Purple Audio Focus & Recuadro Morado
// --------------------------------------------------------------------------
function setFocusedSlot(targetIdx) {
  if (targetIdx < 0 || targetIdx >= SLOTS_COUNT) return;
  focusedSlotIdx = targetIdx;

  slots.forEach(slot => {
    const isFocused = (slot.index === targetIdx);

    // Purple outline & glow
    slot.slotEl.classList.toggle('active-audio', isFocused);

    // Audio Muting Logic: ONLY focused slot produces sound
    if (slot.mode === 'hls' && slot.videoEl) {
      if (isFocused) {
        slot.videoEl.muted = false;
        slot.videoEl.volume = 1;
        slot.videoEl.play().catch(() => {});
        setupAudioNormalizer(slot.videoEl);
      } else {
        slot.videoEl.muted = true;
      }
    } else if (slot.mode === 'embed' && slot.iframeEl && slot.iframeEl.contentWindow) {
      try {
        slot.iframeEl.contentWindow.postMessage({
          type: 'SET_MUTE',
          muted: !isFocused
        }, '*');
      } catch (e) {}
    }
  });

  // Update Footer UI
  const pill = document.getElementById('focusedSlotPill');
  if (pill) {
    pill.textContent = `Pantalla ${targetIdx + 1} · Audio Activo`;
  }

  // Update Server Chips for focused slot
  renderStageFooterServerChips();

  // Update Quality Chip for focused slot
  updateQualityIndicator();

  // Update Header title
  updateHeaderTitle();

  // Highlight active match in sidebar
  highlightActiveMatchInSidebar();
}

// Listen for messages from sandboxed iframes
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SLOT_CLICKED') {
    const slotName = event.data.slotName; // e.g. 'slot-1'
    if (typeof slotName === 'string' && slotName.startsWith('slot-')) {
      const idx = parseInt(slotName.replace('slot-', ''), 10);
      if (!isNaN(idx)) {
        setFocusedSlot(idx);
      }
    }
  }
});

// --------------------------------------------------------------------------
// Multi-Stream Layout Selector ([1], [2], [4])
// --------------------------------------------------------------------------
function setLayout(layoutNum) {
  currentLayout = String(layoutNum);
  const videoGrid = document.getElementById('videoGrid');
  // Preserve enhancement classes
  const enhanceClass = ENHANCE_MODES[currentEnhanceIdx].cssClass;
  videoGrid.className = `video-grid layout-${currentLayout} ${enhanceClass}`.trim();

  // Update segmented control buttons
  document.querySelectorAll('#layoutSelector .seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-layout') === currentLayout);
  });

  // Ensure focused slot is visible in this layout
  const maxVisible = parseInt(currentLayout, 10);
  if (focusedSlotIdx >= maxVisible) {
    setFocusedSlot(0);
  }
}

// --------------------------------------------------------------------------
// Aspect Fit Controller (16:9 / Llenar / Zoom)
// --------------------------------------------------------------------------
function cycleScreenFit() {
  currentFitIdx = (currentFitIdx + 1) % FIT_MODES.length;
  const mode = FIT_MODES[currentFitIdx];

  const label = document.getElementById('aspectFitLabel');
  if (label) {
    label.textContent = mode.label;
  }

  // Apply to all video elements
  slots.forEach(slot => {
    if (slot.videoEl) {
      slot.videoEl.style.objectFit = mode.key;
    }
    if (slot.iframeEl && slot.iframeEl.contentWindow) {
      try {
        slot.iframeEl.contentWindow.postMessage({
          type: 'SET_FIT',
          fit: mode.key
        }, '*');
      } catch (e) {}
    }
  });
}

// --------------------------------------------------------------------------
// GPU Image Enhancement Controller (OFF / HD Nitidez / Estadio Vivo)
// --------------------------------------------------------------------------
function cycleImageEnhance() {
  currentEnhanceIdx = (currentEnhanceIdx + 1) % ENHANCE_MODES.length;
  const mode = ENHANCE_MODES[currentEnhanceIdx];

  const label = document.getElementById('enhanceLabel');
  if (label) {
    label.textContent = mode.label;
  }

  const videoGrid = document.getElementById('videoGrid');
  videoGrid.classList.remove('filter-sharp', 'filter-vivid');
  if (mode.cssClass) {
    videoGrid.classList.add(mode.cssClass);
  }
}

// --------------------------------------------------------------------------
// Quality Indicator & Force Max 1080p Level
// --------------------------------------------------------------------------
function updateQualityIndicator() {
  const qualityBtn = document.getElementById('qualityBtn');
  const qualityLabel = document.getElementById('qualityLabel');
  if (!qualityBtn || !qualityLabel) return;

  const slot = slots[focusedSlotIdx];
  if (!slot || slot.mode !== 'hls' || !slot.hlsInstance) {
    qualityLabel.textContent = 'HD Auto';
    qualityBtn.classList.remove('forced');
    return;
  }

  const hls = slot.hlsInstance;
  if (!hls.levels || hls.levels.length === 0) {
    qualityLabel.textContent = 'HD Auto';
    return;
  }

  const maxLevelIdx = hls.levels.length - 1;
  const maxLevel = hls.levels[maxLevelIdx];
  const maxRes = maxLevel?.height ? `${maxLevel.height}p` : '1080p';

  if (hls.currentLevel === -1) {
    qualityLabel.textContent = `Auto (${maxRes})`;
    qualityBtn.classList.remove('forced');
  } else {
    const curLevel = hls.levels[hls.currentLevel];
    const curRes = curLevel?.height ? `${curLevel.height}p` : maxRes;
    qualityLabel.textContent = `${curRes} MAX`;
    qualityBtn.classList.add('forced');
  }
}

function toggleForceMaxQuality() {
  const slot = slots[focusedSlotIdx];
  if (!slot || slot.mode !== 'hls' || !slot.hlsInstance) return;

  const hls = slot.hlsInstance;
  if (!hls.levels || hls.levels.length === 0) return;

  const maxLevelIdx = hls.levels.length - 1;

  if (hls.currentLevel === -1) {
    // Force highest bitrate / 1080p level
    hls.currentLevel = maxLevelIdx;
  } else {
    // Return to Auto ABR
    hls.currentLevel = -1;
  }

  updateQualityIndicator();
}

// --------------------------------------------------------------------------
// Dual-Engine Stream Loader & Teardown
// --------------------------------------------------------------------------
function clearSlot(slotIdx) {
  const slot = slots[slotIdx];
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
  slot.currentOptionIdx = 0;
  slot.networkRecovered = false;
  slot.mode = 'idle';

  slot.titleEl.textContent = `Ranura ${slotIdx + 1}`;
  slot.loaderEl.style.display = 'none';
  slot.errorEl.style.display = 'none';
  slot.emptyEl.style.display = 'flex';

  if (focusedSlotIdx === slotIdx) {
    renderStageFooterServerChips();
    updateQualityIndicator();
    updateHeaderTitle();
  }
}

async function loadStreamInSlot(slotIdx, matchData, optionIndex = 0) {
  const slot = slots[slotIdx];
  if (!slot || !matchData || !matchData.options) return;

  const option = matchData.options[optionIndex] || matchData.options[0];
  if (!option) return;

  // Clean prior player in this slot
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
  slot.networkRecovered = false;
  slot.emptyEl.style.display = 'none';
  slot.errorEl.style.display = 'none';
  slot.loaderText.textContent = `Sintonizando ${option.name}...`;
  slot.loaderEl.style.display = 'flex';
  slot.titleEl.textContent = `${slotIdx + 1}. ${matchData.title || matchData.name} (${option.name})`;

  // Set focused slot
  setFocusedSlot(slotIdx);

  try {
    const resolveRes = await fetch(`/api/resolve?url=${encodeURIComponent(option.url)}`);
    const result = await resolveRes.json();

    if (!result.ok) {
      throw new Error(result.error || 'No se pudo resolver el stream');
    }

    if (result.mode === 'hls' && result.streamUrls && result.streamUrls.length > 0) {
      slot.mode = 'hls';
      setupSlotHls(slot, result.streamUrls[0], result.referer);
    } else if (result.mode === 'embed' && result.embedUrl) {
      slot.mode = 'embed';
      setupSlotEmbed(slot, result.embedUrl);
    } else {
      throw new Error('Señal no reproducible en esta opción');
    }
  } catch (err) {
    console.warn(`Slot ${slotIdx} error:`, err);
    // Automatic fallback to next option if available
    if (matchData.options.length > 1 && optionIndex + 1 < matchData.options.length) {
      console.log(`[Auto-Fallback] Probando siguiente opción para slot ${slotIdx}...`);
      loadStreamInSlot(slotIdx, matchData, optionIndex + 1);
      return;
    }

    slot.loaderEl.style.display = 'none';
    slot.errorText.textContent = err.message || 'Error al conectar';
    slot.errorEl.style.display = 'flex';
  }
}

// HLS.js Setup with Max-Bitrate & Intelligent Error Recovery
function setupSlotHls(slot, streamUrl, referer) {
  slot.iframeEl.style.display = 'none';
  slot.videoEl.style.display = 'block';

  // Apply current object-fit
  const currentFit = FIT_MODES[currentFitIdx].key;
  slot.videoEl.style.objectFit = currentFit;

  // Use playlist proxy with full URL resolution
  const proxiedM3u8 = `/api/stream/m3u8?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(referer || 'https://xstream.st/')}`;

  if (Hls.isSupported()) {
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      capLevelToPlayerSize: false,        // Never downscale 1080p in multi-split mode
      abrEwmaDefaultEstimate: 8000000,    // Assume 8 Mbps initial bandwidth for instant crisp 1080p/720p
      maxBufferLength: 25,
      maxMaxBufferLength: 40,
      backBufferLength: 15
    });

    slot.hlsInstance = hls;
    hls.loadSource(proxiedM3u8);
    hls.attachMedia(slot.videoEl);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      slot.videoEl.muted = (slot.index !== focusedSlotIdx);
      slot.videoEl.play().catch(() => {});
      updateQualityIndicator();
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, () => {
      updateQualityIndicator();
    });

    // Intelligent Error Recovery
    hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            // Try recovering once before hopping servers
            if (!slot.networkRecovered) {
              console.log(`[HLS] Recuperando micro-corte de red en ranura ${slot.index + 1}...`);
              slot.networkRecovered = true;
              hls.startLoad();
            } else {
              // Network error persisted: hop to next server option
              console.warn(`[HLS] Caída persistente de red en ranura ${slot.index + 1}, cambiando de servidor...`);
              hls.destroy();
              if (slot.currentMatch && slot.currentOptionIdx + 1 < slot.currentMatch.options.length) {
                loadStreamInSlot(slot.index, slot.currentMatch, slot.currentOptionIdx + 1);
              } else {
                slot.loaderEl.style.display = 'none';
                slot.errorText.textContent = 'Canal no disponible actualmente';
                slot.errorEl.style.display = 'flex';
              }
            }
            break;

          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;

          default:
            hls.destroy();
            if (slot.currentMatch && slot.currentOptionIdx + 1 < slot.currentMatch.options.length) {
              loadStreamInSlot(slot.index, slot.currentMatch, slot.currentOptionIdx + 1);
            } else {
              slot.loaderEl.style.display = 'none';
              slot.errorText.textContent = 'Error de transmisión';
              slot.errorEl.style.display = 'flex';
            }
            break;
        }
      }
    });
  } else if (slot.videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    slot.videoEl.src = proxiedM3u8;
    slot.videoEl.muted = (slot.index !== focusedSlotIdx);
    slot.videoEl.play().catch(() => {});
  } else {
    slot.loaderEl.style.display = 'none';
    slot.errorText.textContent = 'Navegador no compatible con HLS';
    slot.errorEl.style.display = 'flex';
  }
}

// Sandboxed Clean-Embed Setup for DRM / Shaka Player pages
function setupSlotEmbed(slot, embedUrl) {
  slot.videoEl.pause();
  slot.videoEl.style.display = 'none';
  slot.iframeEl.style.display = 'block';

  slot.iframeEl.src = embedUrl;

  slot.iframeEl.onload = () => {
    slot.loaderEl.style.display = 'none';
    try {
      slot.iframeEl.contentWindow.postMessage({
        type: 'SET_MUTE',
        muted: (slot.index !== focusedSlotIdx)
      }, '*');

      const currentFit = FIT_MODES[currentFitIdx].key;
      slot.iframeEl.contentWindow.postMessage({
        type: 'SET_FIT',
        fit: currentFit
      }, '*');
    } catch (e) {}
  };
}

// --------------------------------------------------------------------------
// Stage Footer Server Chips & Auto-Fastest
// --------------------------------------------------------------------------
function renderStageFooterServerChips() {
  const container = document.getElementById('serverChipsList');
  const focusedSlot = slots[focusedSlotIdx];

  if (!focusedSlot || !focusedSlot.currentMatch) {
    container.innerHTML = '<span class="no-options-hint">Selecciona un evento para ver servidores</span>';
    return;
  }

  const match = focusedSlot.currentMatch;
  container.innerHTML = '';

  match.options.forEach((opt, idx) => {
    const chip = document.createElement('button');
    chip.className = `server-chip ${idx === focusedSlot.currentOptionIdx ? 'active' : ''}`;
    chip.innerHTML = `<span>${opt.name}</span>`;

    chip.addEventListener('click', () => {
      loadStreamInSlot(focusedSlotIdx, match, idx);
    });

    container.appendChild(chip);
  });
}

async function probeFastestForFocusedSlot() {
  const focusedSlot = slots[focusedSlotIdx];
  if (!focusedSlot || !focusedSlot.currentMatch) return;

  const btn = document.getElementById('autoFastestBtn');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>⚡ Sondeando...</span>';

  try {
    const res = await fetch('/api/probe-fastest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ options: focusedSlot.currentMatch.options })
    });
    const data = await res.json();

    if (data.ok && Array.isArray(data.ranked) && data.ranked.length > 0) {
      const best = data.ranked.find(r => r.available) || data.ranked[0];

      // Auto-tune into fastest option
      loadStreamInSlot(focusedSlotIdx, focusedSlot.currentMatch, best.index);

      // Re-render chips with latencies
      const container = document.getElementById('serverChipsList');
      container.innerHTML = '';
      data.ranked.forEach(r => {
        const chip = document.createElement('button');
        chip.className = `server-chip ${r.index === best.index ? 'active' : ''}`;
        const latencyText = r.available ? `${r.latencyMs}ms` : 'Offline';
        const latencyColor = r.available ? (r.latencyMs < 200 ? '#10b981' : '#f59e0b') : '#ef4444';

        chip.innerHTML = `
          <span>${r.name}</span>
          <span class="latency-pill" style="color:${latencyColor}">(${latencyText})</span>
        `;
        chip.addEventListener('click', () => {
          loadStreamInSlot(focusedSlotIdx, focusedSlot.currentMatch, r.index);
        });
        container.appendChild(chip);
      });
    }
  } catch (err) {
    console.error('Error probing fastest:', err);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

function updateHeaderTitle() {
  const titleEl = document.getElementById('activeHeaderTitle');
  const focusedSlot = slots[focusedSlotIdx];
  if (focusedSlot && focusedSlot.currentMatch) {
    titleEl.textContent = focusedSlot.currentMatch.title || focusedSlot.currentMatch.name;
  } else {
    titleEl.textContent = 'MiTV Live Broadcast';
  }
}

// --------------------------------------------------------------------------
// Sidebar Programming (Matches & Channels) with exact ID matchesList
// --------------------------------------------------------------------------
async function fetchSchedule() {
  try {
    const res = await fetch('/api/schedule');
    const data = await res.json();
    if (data.ok) {
      allMatches = data.matches || [];
      document.getElementById('matchesCount').textContent = allMatches.length;
      if (currentTab === 'matches') {
        renderFilterChips();
        renderSidebarList();
      }
    }
  } catch (err) {
    console.error('Error fetching schedule:', err);
  }
}

async function fetchChannels() {
  try {
    const res = await fetch('/api/channels');
    const data = await res.json();
    if (data.ok) {
      allChannels = data.channels || [];
      document.getElementById('channelsCount').textContent = allChannels.length;
      if (currentTab === 'channels') {
        renderFilterChips();
        renderSidebarList();
      }
    }
  } catch (err) {
    console.error('Error fetching channels:', err);
  }
}

function renderFilterChips() {
  const container = document.getElementById('filterChipsScroll');
  container.innerHTML = '';

  let categories = ['all'];
  if (currentTab === 'matches') {
    const tourneys = new Set(allMatches.map(m => m.tournament).filter(Boolean));
    categories = ['all', ...Array.from(tourneys).slice(0, 14)];
  } else {
    const cats = new Set(allChannels.map(c => c.category).filter(Boolean));
    categories = ['all', ...Array.from(cats)];
  }

  categories.forEach(cat => {
    const chip = document.createElement('button');
    chip.className = `filter-chip ${currentFilter === cat ? 'active' : ''}`;
    chip.textContent = cat === 'all' ? 'Todos' : cat;
    chip.addEventListener('click', () => {
      currentFilter = cat;
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      renderSidebarList();
    });
    container.appendChild(chip);
  });
}

function renderSidebarList() {
  const container = document.getElementById('matchesList');
  if (!container) return;
  container.innerHTML = '';

  const items = currentTab === 'matches' ? allMatches : allChannels;
  const filtered = items.filter(item => {
    const name = (item.title || item.name || '').toLowerCase();
    const tourney = (item.tournament || item.category || '').toLowerCase();
    const q = searchQuery.toLowerCase();

    const matchesQ = !q || name.includes(q) || tourney.includes(q);
    const matchesFilter = currentFilter === 'all' ||
      (currentTab === 'matches' && item.tournament === currentFilter) ||
      (currentTab === 'channels' && item.category === currentFilter);

    return matchesQ && matchesFilter;
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div class="list-loading">No se encontraron eventos</div>`;
    return;
  }

  filtered.forEach(item => {
    const card = document.createElement('div');
    card.className = 'event-card';

    const isPlaying = slots[focusedSlotIdx]?.currentMatch?.id === item.id;
    if (isPlaying) card.classList.add('active-in-slot');

    if (currentTab === 'matches') {
      const isLive = (item.time || '').toUpperCase().includes('VIVO');
      card.innerHTML = `
        <div class="time-tag ${isLive ? 'is-live' : ''}">
          ${isLive ? '<span class="red-dot"></span>' : ''}${item.time || 'VIVO'}
        </div>
        <div class="event-info">
          <div class="event-league">${item.tournament || 'Fútbol'}</div>
          <div class="event-name" title="${item.fullTitle || item.title}">${item.title}</div>
        </div>
        <button class="add-multistream-btn" title="Cargar en otra pantalla del Multi-Stream">+</button>
      `;
    } else {
      card.innerHTML = `
        <div class="time-tag is-live">24/7</div>
        <div class="event-info">
          <div class="event-league">${item.category || 'Deportes'}</div>
          <div class="event-name" title="${item.name}">${item.name}</div>
        </div>
        <button class="add-multistream-btn" title="Cargar en otra pantalla del Multi-Stream">+</button>
      `;
    }

    // Clicking card tunes into focused slot
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('add-multistream-btn')) return;
      loadStreamInSlot(focusedSlotIdx, item, 0);
    });

    // Clicking '+' sends to next available slot
    const addBtn = card.querySelector('.add-multistream-btn');
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      let target = slots.findIndex(s => !s.currentMatch);
      if (target === -1) {
        target = (focusedSlotIdx + 1) % SLOTS_COUNT;
      }

      if (currentLayout === '1') {
        setLayout('2');
      } else if (currentLayout === '2' && target >= 2) {
        setLayout('4');
      }

      loadStreamInSlot(target, item, 0);
    });

    container.appendChild(card);
  });
}

function highlightActiveMatchInSidebar() {
  const activeId = slots[focusedSlotIdx]?.currentMatch?.id;
  document.querySelectorAll('.event-card').forEach(card => {
    card.classList.remove('active-in-slot');
  });
  if (activeId) {
    renderSidebarList();
  }
}

// --------------------------------------------------------------------------
// UI Event Listeners & Shortcuts
// --------------------------------------------------------------------------
function setupUIEventListeners() {
  // Layout selector buttons
  document.querySelectorAll('#layoutSelector .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setLayout(btn.getAttribute('data-layout'));
    });
  });

  // Aspect fit toggle
  document.getElementById('aspectFitBtn').addEventListener('click', cycleScreenFit);

  // GPU Image Enhancement toggle
  document.getElementById('enhanceBtn').addEventListener('click', cycleImageEnhance);

  // Quality selector / 1080p force toggle
  document.getElementById('qualityBtn').addEventListener('click', toggleForceMaxQuality);

  // Auto-fastest probe button
  document.getElementById('autoFastestBtn').addEventListener('click', probeFastestForFocusedSlot);

  // Reload current button in footer
  document.getElementById('reloadCurrentBtn').addEventListener('click', () => {
    const slot = slots[focusedSlotIdx];
    if (slot && slot.currentMatch) {
      loadStreamInSlot(focusedSlotIdx, slot.currentMatch, slot.currentOptionIdx);
    }
  });

  // Toggle Sidebar visibility
  const sidebar = document.getElementById('sidebar');
  const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
  toggleSidebarBtn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
  });

  // Fullscreen button
  document.getElementById('fullscreenBtn').addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  // Tabs: Matches / Channels
  const tabMatches = document.getElementById('tabMatches');
  const tabChannels = document.getElementById('tabChannels');

  tabMatches.addEventListener('click', () => {
    currentTab = 'matches';
    currentFilter = 'all';
    tabMatches.classList.add('active');
    tabChannels.classList.remove('active');
    renderFilterChips();
    renderSidebarList();
  });

  tabChannels.addEventListener('click', () => {
    currentTab = 'channels';
    currentFilter = 'all';
    tabChannels.classList.add('active');
    tabMatches.classList.remove('active');
    renderFilterChips();
    renderSidebarList();
  });

  // Search input
  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');

  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    searchClear.style.display = searchQuery ? 'block' : 'none';
    renderSidebarList();
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchQuery = '';
    searchClear.style.display = 'none';
    renderSidebarList();
  });

  // Refresh list button
  document.getElementById('refreshListBtn').addEventListener('click', async () => {
    const btn = document.getElementById('refreshListBtn');
    btn.style.transform = 'rotate(180deg)';
    await fetch('/api/refresh');
    await Promise.all([fetchSchedule(), fetchChannels()]);
    setTimeout(() => { btn.style.transform = ''; }, 300);
  });

  // Mobile LAN Modal
  const mobileBtn = document.getElementById('mobileBtn');
  const phoneModal = document.getElementById('phoneModal');
  const closePhoneModalBtn = document.getElementById('closePhoneModalBtn');
  const copyLanUrlBtn = document.getElementById('copyLanUrlBtn');

  mobileBtn.addEventListener('click', () => {
    phoneModal.style.display = 'flex';
  });
  closePhoneModalBtn.addEventListener('click', () => {
    phoneModal.style.display = 'none';
  });
  phoneModal.addEventListener('click', (e) => {
    if (e.target === phoneModal) phoneModal.style.display = 'none';
  });

  copyLanUrlBtn.addEventListener('click', () => {
    const input = document.getElementById('lanUrlInput');
    input.select();
    navigator.clipboard.writeText(input.value).then(() => {
      copyLanUrlBtn.textContent = '¡Copiado!';
      setTimeout(() => { copyLanUrlBtn.textContent = 'Copiar'; }, 2000);
    });
  });
}

function setupKeyboardShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // Keys 1, 2, 3, 4 switch audio focus and purple outline
    if (['1', '2', '3', '4'].includes(e.key)) {
      const idx = parseInt(e.key, 10) - 1;
      setFocusedSlot(idx);
    }

    // Spacebar toggles Play/Pause on focused slot
    if (e.code === 'Space') {
      e.preventDefault();
      const slot = slots[focusedSlotIdx];
      if (slot && slot.videoEl) {
        if (slot.videoEl.paused) slot.videoEl.play().catch(() => {});
        else slot.videoEl.pause();
      }
    }

    // Key 'f' toggles Fullscreen
    if (e.key === 'f' || e.key === 'F') {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    }
  });
}

// --------------------------------------------------------------------------
// Network Info & Mobile QR Code
// --------------------------------------------------------------------------
async function fetchNetworkInfo() {
  try {
    const res = await fetch('/api/network-info');
    const data = await res.json();
    if (data.ok) {
      lanNetworkInfo = data;
      document.getElementById('lanUrlInput').value = data.localUrl;
      const qrContainer = document.getElementById('qrContainer');
      const encoded = encodeURIComponent(data.localUrl);
      qrContainer.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encoded}&bgcolor=111115&color=f4f4f6&margin=2" alt="QR Mobile" width="150" height="150" style="border-radius:4px; display:block;"/>`;
    }
  } catch (err) {
    console.error('Error fetching network info:', err);
  }
}
