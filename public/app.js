/**
 * MiTV — BROADCAST CLIENT APPLICATION
 * Native Dual-Engine Video Player (HLS.js + Shaka Player DASH / ClearKey DRM)
 * Multi-Stream (1, 2, 4 Screens), Exclusive Purple Audio Focus,
 * 40px Server Options Bar with Auto-Fastest Benchmark & LAN Mobile Handoff.
 */

// Install Shaka Player polyfills once
if (window.shaka) {
  shaka.polyfill.installAll();
}

// --------------------------------------------------------------------------
// State & Configuration
// --------------------------------------------------------------------------
const SLOTS_COUNT = 4;
let slots = [];
let activeAudioSlotIndex = 0; // Default slot 0 with purple audio focus
let currentLayout = '1';      // '1', '2', '4'
let currentTab = 'matches';   // 'matches' | 'channels'
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
let currentFitIndex = 0;

// --------------------------------------------------------------------------
// Initialization
// --------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  initSlots();
  setupUIEventListeners();
  setupKeyboardShortcuts();

  // Load initial data
  await Promise.all([
    fetchSchedule(),
    fetchChannels(),
    fetchNetworkInfo()
  ]);

  // If matches exist, auto-tune the first one into slot 0
  if (allMatches.length > 0) {
    loadStreamInSlot(0, allMatches[0], 0);
  }
});

// --------------------------------------------------------------------------
// Multi-Stream Slots Setup
// --------------------------------------------------------------------------
function initSlots() {
  slots = [];
  for (let i = 0; i < SLOTS_COUNT; i++) {
    const slotEl = document.getElementById(`slot-${i}`);
    const videoEl = slotEl.querySelector('.slot-video');

    slots.push({
      index: i,
      slotEl,
      videoEl,
      titleEl: slotEl.querySelector('.slot-title'),
      loaderEl: slotEl.querySelector('.slot-loader'),
      loaderMsg: slotEl.querySelector('.loader-msg'),
      errorEl: slotEl.querySelector('.slot-error'),
      errorMsg: slotEl.querySelector('.error-msg'),
      emptyEl: slotEl.querySelector('.slot-empty'),
      reloadBtn: slotEl.querySelector('.slot-reload-btn'),
      closeBtn: slotEl.querySelector('.slot-close-btn'),
      retryBtn: slotEl.querySelector('.slot-retry-btn'),
      hlsInstance: null,
      shakaInstance: null,
      currentMatch: null,
      currentOptionIdx: 0,
      mode: 'idle' // 'hls' | 'dash' | 'idle'
    });
  }

  // Bind slot interactions
  slots.forEach(slot => {
    // Clicking anywhere on a slot selects it as the active audio slot
    slot.slotEl.addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON' && !e.target.closest('.slot-controls')) {
        setActiveAudioSlot(slot.index);
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

    // Retry button
    slot.retryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (slot.currentMatch) {
        const nextOpt = (slot.currentOptionIdx + 1) % slot.currentMatch.options.length;
        loadStreamInSlot(slot.index, slot.currentMatch, nextOpt);
      }
    });

    // Video events
    slot.videoEl.addEventListener('playing', () => {
      slot.loaderEl.style.display = 'none';
      slot.errorEl.style.display = 'none';
      slot.emptyEl.style.display = 'none';
    });

    slot.videoEl.addEventListener('waiting', () => {
      // Slot buffering
    });
  });
}

// --------------------------------------------------------------------------
// Purple Audio Focus Controller
// --------------------------------------------------------------------------
function setActiveAudioSlot(targetSlotIndex) {
  if (targetSlotIndex < 0 || targetSlotIndex >= SLOTS_COUNT) return;
  activeAudioSlotIndex = targetSlotIndex;

  slots.forEach(slot => {
    const isActive = (slot.index === targetSlotIndex);

    // Apply or remove purple outline class
    slot.slotEl.classList.toggle('active-audio-slot', isActive);

    // Strict Audio Muting: ONLY active slot has muted = false
    if (slot.videoEl) {
      if (isActive) {
        slot.videoEl.muted = false;
        slot.videoEl.volume = 1;
        slot.videoEl.play().catch(() => {});
      } else {
        slot.videoEl.muted = true;
      }
    }
  });

  // Update bottom server options bar for the newly selected slot
  renderActiveServersBar();

  // Update sidebar active highlights
  highlightActiveMatchInSidebar();
}

// --------------------------------------------------------------------------
// Multi-Stream Layout Selector ([1], [2], [4])
// --------------------------------------------------------------------------
function setLayout(layoutNum) {
  currentLayout = String(layoutNum);
  const videoGrid = document.getElementById('videoGrid');
  videoGrid.className = `video-grid layout-${currentLayout}`;

  // Update layout buttons UI
  document.querySelectorAll('.grid-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-layout') === currentLayout);
  });

  // Ensure active audio slot is visible in this layout
  const maxVisibleSlots = parseInt(currentLayout, 10);
  if (activeAudioSlotIndex >= maxVisibleSlots) {
    setActiveAudioSlot(0);
  }
}

// --------------------------------------------------------------------------
// Video Aspect Ratio Fit Controller (16:9 / Llenar / Zoom)
// --------------------------------------------------------------------------
function cycleScreenFit() {
  currentFitIndex = (currentFitIndex + 1) % FIT_MODES.length;
  const currentMode = FIT_MODES[currentFitIndex];

  const labelEl = document.getElementById('aspectFitLabel');
  if (labelEl) {
    labelEl.textContent = currentMode.label;
  }

  // Apply object-fit to all native video elements
  slots.forEach(slot => {
    if (slot.videoEl) {
      slot.videoEl.style.objectFit = currentMode.key;
    }
  });
}

// --------------------------------------------------------------------------
// Native Streaming Engine per Slot (HLS.js & Shaka Player DASH)
// --------------------------------------------------------------------------
async function clearSlot(slotIndex) {
  const slot = slots[slotIndex];
  if (!slot) return;

  if (slot.hlsInstance) {
    slot.hlsInstance.destroy();
    slot.hlsInstance = null;
  }
  if (slot.shakaInstance) {
    await slot.shakaInstance.destroy().catch(() => {});
    slot.shakaInstance = null;
  }

  slot.videoEl.pause();
  slot.videoEl.removeAttribute('src');
  slot.videoEl.load();

  slot.currentMatch = null;
  slot.currentOptionIdx = 0;
  slot.mode = 'idle';

  slot.titleEl.textContent = `Ranura ${slotIndex + 1}: Vacía`;
  slot.loaderEl.style.display = 'none';
  slot.errorEl.style.display = 'none';
  slot.emptyEl.style.display = 'flex';

  if (activeAudioSlotIndex === slotIndex) {
    renderActiveServersBar();
  }
}

async function loadStreamInSlot(slotIndex, matchData, optionIndex = 0) {
  const slot = slots[slotIndex];
  if (!slot || !matchData || !matchData.options) return;

  const option = matchData.options[optionIndex] || matchData.options[0];
  if (!option) return;

  // Clean teardown of prior stream in this slot
  if (slot.hlsInstance) {
    slot.hlsInstance.destroy();
    slot.hlsInstance = null;
  }
  if (slot.shakaInstance) {
    await slot.shakaInstance.destroy().catch(() => {});
    slot.shakaInstance = null;
  }

  slot.videoEl.pause();
  slot.videoEl.removeAttribute('src');
  slot.videoEl.load();

  slot.currentMatch = matchData;
  slot.currentOptionIdx = optionIndex;
  slot.emptyEl.style.display = 'none';
  slot.errorEl.style.display = 'none';
  slot.loaderMsg.textContent = `Sintonizando ${option.name}...`;
  slot.loaderEl.style.display = 'flex';
  slot.titleEl.textContent = `${slotIndex + 1}. ${matchData.title || matchData.name} (${option.name})`;

  // Ensure this slot is selected with purple audio focus
  setActiveAudioSlot(slotIndex);

  try {
    const resolveRes = await fetch(`/api/resolve?url=${encodeURIComponent(option.url)}`);
    const result = await resolveRes.json();

    if (!result.ok || !result.streamUrls || result.streamUrls.length === 0) {
      throw new Error(result.error || 'No se pudo extraer el stream de video');
    }

    const rawStreamUrl = result.streamUrls[0];
    const referer = result.referer || 'https://xstream.st/';

    if (result.mode === 'dash') {
      slot.mode = 'dash';
      await setupSlotDash(slot, rawStreamUrl, result.clearKeys);
    } else {
      slot.mode = 'hls';
      setupSlotHls(slot, rawStreamUrl, referer);
    }
  } catch (err) {
    console.error(`Slot ${slotIndex} playback error:`, err);
    slot.loaderEl.style.display = 'none';
    slot.errorMsg.textContent = err.message || 'Error al conectar con la señal';
    slot.errorEl.style.display = 'flex';
  }
}

// --------------------------------------------------------------------------
// HLS Setup (Hls.js + Safari Native Fallback)
// --------------------------------------------------------------------------
function setupSlotHls(slot, streamUrl, referer) {
  // Always proxy HLS manifest through /api/stream/m3u8 to guarantee correct Referer & Zero-RAM chunk piping
  const proxiedManifestUrl = `/api/stream/m3u8?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(referer)}`;

  if (Hls.isSupported()) {
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 30,
      maxBufferLength: 20,
      maxMaxBufferLength: 40,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 6
    });

    slot.hlsInstance = hls;
    hls.loadSource(proxiedManifestUrl);
    hls.attachMedia(slot.videoEl);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      slot.videoEl.play().catch(() => {});
    });

    hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;
          default:
            hls.destroy();
            slot.loaderEl.style.display = 'none';
            slot.errorMsg.textContent = 'Error fatal de transmisión HLS';
            slot.errorEl.style.display = 'flex';
            break;
        }
      }
    });
  } else if (slot.videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari Native HLS
    slot.videoEl.src = proxiedManifestUrl;
    slot.videoEl.play().catch(() => {});
  } else {
    slot.loaderEl.style.display = 'none';
    slot.errorMsg.textContent = 'HLS no soportado en este navegador';
    slot.errorEl.style.display = 'flex';
  }
}

// --------------------------------------------------------------------------
// DASH Setup (Shaka Player + ClearKey DRM)
// --------------------------------------------------------------------------
async function setupSlotDash(slot, streamUrl, clearKeys) {
  if (!window.shaka || !shaka.Player.isBrowserSupported()) {
    throw new Error('Shaka Player DASH no compatible');
  }

  const player = new shaka.Player(slot.videoEl);
  slot.shakaInstance = player;

  // Configure ClearKey DRM if keys extracted
  if (clearKeys && Object.keys(clearKeys).length > 0) {
    player.configure({
      drm: {
        clearKeys: clearKeys
      }
    });
  }

  player.configure({
    streaming: {
      bufferingGoal: 10,
      rebufferingGoal: 2,
      lowLatencyMode: true
    }
  });

  player.addEventListener('error', (event) => {
    console.error('Shaka error:', event.detail);
    slot.loaderEl.style.display = 'none';
    slot.errorMsg.textContent = 'Error en flujo DASH';
    slot.errorEl.style.display = 'flex';
  });

  await player.load(streamUrl);
  slot.videoEl.play().catch(() => {});
}

// --------------------------------------------------------------------------
// Discrete 40px Active Servers Bar & Speed Benchmark
// --------------------------------------------------------------------------
function renderActiveServersBar() {
  const activeSlot = slots[activeAudioSlotIndex];
  const nameEl = document.getElementById('activeMatchName');
  const listEl = document.getElementById('serverOptionsList');

  if (!activeSlot || !activeSlot.currentMatch) {
    nameEl.textContent = 'Ningún evento seleccionado';
    listEl.innerHTML = '<span style="color:#64748b; font-size:11px;">Elige un partido en el panel derecho</span>';
    return;
  }

  const match = activeSlot.currentMatch;
  nameEl.textContent = match.title || match.name;
  listEl.innerHTML = '';

  match.options.forEach((opt, idx) => {
    const btn = document.createElement('button');
    btn.className = `server-btn ${idx === activeSlot.currentOptionIdx ? 'active' : ''}`;
    btn.innerHTML = `<span>${opt.name}</span>`;

    btn.addEventListener('click', () => {
      loadStreamInSlot(activeAudioSlotIndex, match, idx);
    });

    listEl.appendChild(btn);
  });
}

// Probing fastest server with real latency measurement
async function probeFastestForActiveSlot() {
  const activeSlot = slots[activeAudioSlotIndex];
  if (!activeSlot || !activeSlot.currentMatch) return;

  const probeBtn = document.getElementById('probeFastestBtn');
  const originalText = probeBtn.innerHTML;
  probeBtn.disabled = true;
  probeBtn.innerHTML = `<span>Sondeando...</span>`;

  try {
    const res = await fetch('/api/probe-fastest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ options: activeSlot.currentMatch.options })
    });
    const data = await res.json();

    if (data.ok && Array.isArray(data.ranked) && data.ranked.length > 0) {
      const best = data.ranked.find(r => r.available) || data.ranked[0];

      // Auto-tune the fastest option
      loadStreamInSlot(activeAudioSlotIndex, activeSlot.currentMatch, best.index);

      // Re-render server pills with measured latencies
      const listEl = document.getElementById('serverOptionsList');
      listEl.innerHTML = '';
      data.ranked.forEach((r) => {
        const btn = document.createElement('button');
        btn.className = `server-btn ${r.index === best.index ? 'active' : ''}`;
        const latencyText = r.available ? `${r.latencyMs}ms` : 'Offline';
        const latencyColor = r.available ? (r.latencyMs < 200 ? '#10b981' : '#f59e0b') : '#ef4444';

        btn.innerHTML = `
          <span>${r.name}</span>
          <span class="latency-tag" style="color:${latencyColor}">(${latencyText})</span>
        `;
        btn.addEventListener('click', () => {
          loadStreamInSlot(activeAudioSlotIndex, activeSlot.currentMatch, r.index);
        });
        listEl.appendChild(btn);
      });
    }
  } catch (err) {
    console.error('Error probing fastest:', err);
  } finally {
    probeBtn.disabled = false;
    probeBtn.innerHTML = originalText;
  }
}

// --------------------------------------------------------------------------
// Sidebar Programming (Matches & Channels)
// --------------------------------------------------------------------------
async function fetchSchedule() {
  try {
    const res = await fetch('/api/schedule');
    const data = await res.json();
    if (data.ok) {
      allMatches = data.matches || [];
      document.getElementById('matchesCountBadge').textContent = allMatches.length;
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
      document.getElementById('channelsCountBadge').textContent = allChannels.length;
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
  const container = document.getElementById('filterScroll');
  container.innerHTML = '';

  let categories = ['all'];
  if (currentTab === 'matches') {
    const tourneys = new Set(allMatches.map(m => m.tournament).filter(Boolean));
    categories = ['all', ...Array.from(tourneys).slice(0, 12)];
  } else {
    const cats = new Set(allChannels.map(c => c.category).filter(Boolean));
    categories = ['all', ...Array.from(cats)];
  }

  categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = `filter-chip ${currentFilter === cat ? 'active' : ''}`;
    btn.textContent = cat === 'all' ? 'Todos' : cat;
    btn.addEventListener('click', () => {
      currentFilter = cat;
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      renderSidebarList();
    });
    container.appendChild(btn);
  });
}

function renderSidebarList() {
  const container = document.getElementById('sidebarList');
  container.innerHTML = '';

  const items = currentTab === 'matches' ? allMatches : allChannels;
  const filtered = items.filter(item => {
    const name = (item.title || item.name || '').toLowerCase();
    const tournament = (item.tournament || item.category || '').toLowerCase();
    const query = searchQuery.toLowerCase();

    const matchesSearch = !query || name.includes(query) || tournament.includes(query);
    const matchesFilter = currentFilter === 'all' || 
      (currentTab === 'matches' && item.tournament === currentFilter) ||
      (currentTab === 'channels' && item.category === currentFilter);

    return matchesSearch && matchesFilter;
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div class="list-placeholder">No se encontraron eventos disponibles</div>`;
    return;
  }

  filtered.forEach(item => {
    const card = document.createElement('div');
    card.className = 'event-card';

    // Check if playing in any slot
    const isPlayingInActive = slots[activeAudioSlotIndex]?.currentMatch?.id === item.id;
    if (isPlayingInActive) {
      card.classList.add('active-in-slot');
    }

    if (currentTab === 'matches') {
      const isLive = (item.time || '').toUpperCase().includes('VIVO');
      card.innerHTML = `
        <div class="time-pill ${isLive ? 'is-live' : ''}">
          ${isLive ? '<span class="live-dot"></span>' : ''}${item.time || 'VIVO'}
        </div>
        <div class="event-details">
          <div class="event-tournament">${item.tournament || 'Fútbol'}</div>
          <div class="event-title" title="${item.fullTitle || item.title}">${item.title}</div>
        </div>
        <div class="event-actions">
          <button class="add-slot-btn" title="Cargar en otra pantalla del Multi-Stream">+</button>
        </div>
      `;
    } else {
      card.innerHTML = `
        <div class="time-pill is-live">24/7</div>
        <div class="event-details">
          <div class="event-tournament">${item.category || 'Deportes'}</div>
          <div class="event-title" title="${item.name}">${item.name}</div>
        </div>
        <div class="event-actions">
          <button class="add-slot-btn" title="Cargar en otra pantalla del Multi-Stream">+</button>
        </div>
      `;
    }

    // Clicking card tunes into the active audio slot
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('add-slot-btn')) return;
      loadStreamInSlot(activeAudioSlotIndex, item, 0);
    });

    // Clicking '+' finds next empty or next available slot
    const addBtn = card.querySelector('.add-slot-btn');
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      let targetSlot = slots.findIndex(s => !s.currentMatch);
      if (targetSlot === -1) {
        // All filled, cycle next
        targetSlot = (activeAudioSlotIndex + 1) % SLOTS_COUNT;
      }

      // If layout is 1 and user adds stream, automatically promote to layout 2 or 4
      if (currentLayout === '1') {
        setLayout('2');
      } else if (currentLayout === '2' && targetSlot >= 2) {
        setLayout('4');
      }

      loadStreamInSlot(targetSlot, item, 0);
    });

    container.appendChild(card);
  });
}

function highlightActiveMatchInSidebar() {
  const activeSlot = slots[activeAudioSlotIndex];
  const activeId = activeSlot?.currentMatch?.id;

  document.querySelectorAll('.event-card').forEach(card => {
    card.classList.remove('active-in-slot');
  });

  if (!activeId) return;
  renderSidebarList();
}

// --------------------------------------------------------------------------
// UI Event Listeners & Hotkeys
// --------------------------------------------------------------------------
function setupUIEventListeners() {
  // Grid layout buttons
  document.querySelectorAll('.grid-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setLayout(btn.getAttribute('data-layout'));
    });
  });

  // Aspect fit button
  document.getElementById('aspectFitBtn').addEventListener('click', cycleScreenFit);

  // Auto fastest probe button
  document.getElementById('probeFastestBtn').addEventListener('click', probeFastestForActiveSlot);

  // Tabs
  const tabMatches = document.getElementById('tabMatchesBtn');
  const tabChannels = document.getElementById('tabChannelsBtn');

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
  const clearSearch = document.getElementById('clearSearch');

  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    clearSearch.style.display = searchQuery ? 'block' : 'none';
    renderSidebarList();
  });

  clearSearch.addEventListener('click', () => {
    searchInput.value = '';
    searchQuery = '';
    clearSearch.style.display = 'none';
    renderSidebarList();
  });

  // Refresh button
  document.getElementById('refreshBtn').addEventListener('click', async () => {
    const btn = document.getElementById('refreshBtn');
    btn.style.transform = 'rotate(180deg)';
    await fetch('/api/refresh');
    await Promise.all([fetchSchedule(), fetchChannels()]);
    setTimeout(() => { btn.style.transform = ''; }, 300);
  });

  // Fullscreen button
  document.getElementById('fullscreenBtn').addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  // Mobile modal
  const mobileBtn = document.getElementById('mobileHandoffBtn');
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
    // Avoid triggering while typing in search box
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // Keys 1, 2, 3, 4 switch audio focus immediately
    if (['1', '2', '3', '4'].includes(e.key)) {
      const idx = parseInt(e.key, 10) - 1;
      setActiveAudioSlot(idx);
    }

    // Spacebar toggles Play/Pause on active slot
    if (e.code === 'Space') {
      e.preventDefault();
      const video = slots[activeAudioSlotIndex]?.videoEl;
      if (video) {
        if (video.paused) video.play().catch(() => {});
        else video.pause();
      }
    }

    // Key 'f' toggles fullscreen
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
      const lanUrl = data.localUrl;
      document.getElementById('lanUrlInput').value = lanUrl;
      const qrContainer = document.getElementById('qrContainer');
      const encoded = encodeURIComponent(lanUrl);
      qrContainer.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encoded}&bgcolor=14171f&color=f1f5f9&margin=2" alt="QR Mobile" width="160" height="160" style="border-radius:4px; display:block;"/>`;
    }
  } catch (err) {
    console.error('Error fetching network info:', err);
  }
}
