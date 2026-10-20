// ==========================================================================
// PIRLO SHIELD - Modern Sports Streaming Application
// ==========================================================================

let allMatches = [];
let allChannels = [];
let currentHls = null;
let currentItem = null;
let currentOptionIdx = 0;
let currentStreamUrls = [];
let currentStreamIdx = 0;
let isTheater = false;

// DOM Elements
const videoPlayer = document.getElementById('videoPlayer');
const shieldFrame = document.getElementById('shieldFrame');
const videoWrapper = document.getElementById('videoWrapper');
const playerLoader = document.getElementById('playerLoader');
const playerError = document.getElementById('playerError');
const loaderMessage = document.getElementById('loaderMessage');
const errorMessage = document.getElementById('errorMessage');

const playerTitle = document.getElementById('playerTitle');
const playerSubtitle = document.getElementById('playerSubtitle');
const playerCategory = document.getElementById('playerCategory');
const playerQuality = document.getElementById('playerQuality');
const serverOptions = document.getElementById('serverOptions');

const activeEngineBadge = document.getElementById('activeEngineBadge');
const activeStreamQuality = document.getElementById('activeStreamQuality');

const searchInput = document.getElementById('searchInput');
const clearSearchBtn = document.getElementById('clearSearch');
const refreshBtn = document.getElementById('refreshBtn');

const tabMatchesBtn = document.getElementById('tabMatchesBtn');
const tabChannelsBtn = document.getElementById('tabChannelsBtn');
const matchesCountBadge = document.getElementById('matchesCountBadge');
const channelsCountBadge = document.getElementById('channelsCountBadge');

const unmuteQuickBtn = document.getElementById('unmuteQuickBtn');
const theaterBtn = document.getElementById('theaterBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const pipBtn = document.getElementById('pipBtn');
const reconnectBtn = document.getElementById('reconnectBtn');
const retryBtn = document.getElementById('retryBtn');
const reconnectDirectBtn = document.getElementById('reconnectDirectBtn');

const tournamentFilters = document.getElementById('tournamentFilters');
const channelCategoryFilters = document.getElementById('channelCategoryFilters');
const matchesGrid = document.getElementById('matchesGrid');
const channelsGrid = document.getElementById('channelsGrid');
const matchesTabContent = document.getElementById('matchesTabContent');
const channelsTabContent = document.getElementById('channelsTabContent');

// --------------------------------------------------------------------------
// Initialization
// --------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupPlayerControls();
  setupSearch();
  fetchInitialData();
});

// --------------------------------------------------------------------------
// Data Fetching
// --------------------------------------------------------------------------
async function fetchInitialData() {
  showLoader('Sincronizando partidos y señales en vivo...');
  try {
    const [matchesRes, channelsRes] = await Promise.all([
      fetch('/api/schedule'),
      fetch('/api/channels')
    ]);

    const matchesData = await matchesRes.json();
    const channelsData = await channelsRes.json();

    allMatches = matchesData.matches || [];
    allChannels = channelsData.channels || [];

    // Update badges count
    matchesCountBadge.textContent = allMatches.length;
    channelsCountBadge.textContent = allChannels.length;

    renderTournamentFilters();
    renderMatches(allMatches);
    renderChannels(allChannels);

    // Auto-tune to first active match or channel
    if (allMatches.length > 0) {
      const first = allMatches[0];
      playItem(first.fullTitle, first.tournament, first.options, 0);
    } else if (allChannels.length > 0) {
      const first = allChannels[0];
      playItem(first.name, 'Canal 24/7', first.options, 0);
    } else {
      hideLoader();
    }
  } catch (err) {
    console.error('Initial fetch failed:', err);
    showError('Error al contactar con el servidor local.');
  }
}

// --------------------------------------------------------------------------
// Dynamic Tournament Filters
// --------------------------------------------------------------------------
function renderTournamentFilters() {
  if (!tournamentFilters) return;

  // Count matches per tournament
  const counts = { all: allMatches.length };
  allMatches.forEach(m => {
    const t = m.tournament || 'Fútbol';
    counts[t] = (counts[t] || 0) + 1;
  });

  tournamentFilters.innerHTML = '';

  // All button
  const allBtn = document.createElement('button');
  allBtn.className = 'filter-pill active';
  allBtn.setAttribute('data-filter', 'all');
  allBtn.innerHTML = `Todos (${counts.all})`;
  allBtn.onclick = () => selectTournamentFilter(allBtn, 'all');
  tournamentFilters.appendChild(allBtn);

  // Individual tournament buttons sorted by count descending
  const tournaments = Object.keys(counts).filter(k => k !== 'all').sort((a, b) => counts[b] - counts[a]);
  tournaments.forEach(tourn => {
    const btn = document.createElement('button');
    btn.className = 'filter-pill';
    btn.setAttribute('data-filter', tourn);
    btn.innerHTML = `${tourn} (${counts[tourn]})`;
    btn.onclick = () => selectTournamentFilter(btn, tourn);
    tournamentFilters.appendChild(btn);
  });
}

function selectTournamentFilter(btn, filterVal) {
  document.querySelectorAll('#tournamentFilters .filter-pill').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  applyFilters();
}

// --------------------------------------------------------------------------
// Stream Playback Logic (HLS Native + Sanitized Clean Embed)
// --------------------------------------------------------------------------
async function playItem(title, category, options, optionIndex = 0) {
  currentItem = { title, category, options };
  currentOptionIdx = optionIndex;

  const currentOption = options[optionIndex] || options[0];
  if (!currentOption) return;

  // Immediate Clean Teardown of prior streams (prevent audio bleed / zombie workers)
  if (currentHls) {
    currentHls.destroy();
    currentHls = null;
  }
  videoPlayer.pause();
  videoPlayer.removeAttribute('src');
  videoPlayer.load();
  shieldFrame.src = 'about:blank';

  // Update Player Header & Info
  playerTitle.textContent = title;
  playerSubtitle.textContent = `Sintonizando: ${currentOption.name} • Señal segura sin publicidad ni redirecciones`;
  playerCategory.textContent = category;
  playerQuality.textContent = currentOption.isHD ? 'HD 1080p' : 'SD Direct';

  // Render option chips
  renderServerOptions(options, optionIndex);

  showLoader(`Conectando con ${currentOption.name}...`);
  hideError();

  try {
    // Resolve stream through our backend resolver
    const resolveRes = await fetch(`/api/resolve?url=${encodeURIComponent(currentOption.url)}`);
    const result = await resolveRes.json();

    if (!result.ok) {
      throw new Error(result.error || 'No se pudo resolver el stream');
    }

    currentStreamUrls = result.streamUrls || [];
    currentStreamIdx = 0;

    if (currentStreamUrls.length > 0) {
      // Direct HLS native stream
      activeEngineBadge.textContent = '⚡ HLS Directo';
      activeStreamQuality.textContent = currentOption.isHD ? '1080p HD' : '720p HD';
      setupHlsStream(currentStreamUrls[0], result.referer);
    } else {
      // Clean sanitized embed (DASH/Shaka/Clappr)
      activeEngineBadge.textContent = '🛡️ Señal Protegida';
      activeStreamQuality.textContent = 'HD Dinámico';
      setupShieldStream(result.embedUrl, result.referer);
    }
  } catch (err) {
    console.error('Play error:', err);
    showError(`Error al sintonizar ${currentOption.name}: ` + err.message);
  }
}

function setupHlsStream(m3u8Url, referer) {
  shieldFrame.style.display = 'none';
  videoPlayer.style.display = 'block';

  const proxiedM3u8 = `/api/stream/m3u8?url=${encodeURIComponent(m3u8Url)}&referer=${encodeURIComponent(referer || 'https://xstream.st/')}`;

  if (currentHls) {
    currentHls.destroy();
    currentHls = null;
  }

  if (Hls.isSupported()) {
    currentHls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 30,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 6
    });

    currentHls.loadSource(proxiedM3u8);
    currentHls.attachMedia(videoPlayer);

    currentHls.on(Hls.Events.MANIFEST_PARSED, () => {
      hideLoader();
      videoPlayer.play().catch(e => {
        console.warn('Autoplay requires user gesture:', e);
      });
    });

    currentHls.on(Hls.Events.ERROR, (event, data) => {
      console.warn('Hls error:', data.type, data.details);
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            tryNextHlsSource(referer);
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            currentHls.recoverMediaError();
            break;
          default:
            currentHls.destroy();
            setupShieldStream(currentItem.options[currentOptionIdx].url, referer);
            break;
        }
      }
    });
  } else if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari native HLS
    videoPlayer.src = proxiedM3u8;
    videoPlayer.addEventListener('loadedmetadata', () => {
      hideLoader();
      videoPlayer.play().catch(() => {});
    });
  } else {
    // Fallback to sanitized embed
    setupShieldStream(currentItem.options[currentOptionIdx].url, referer);
  }
}

function tryNextHlsSource(referer) {
  if (currentStreamIdx < currentStreamUrls.length - 1) {
    currentStreamIdx++;
    console.log(`Cambiando a servidor espejo ${currentStreamIdx + 1}/${currentStreamUrls.length}`);
    showLoader(`Cambiando a servidor espejo ${currentStreamIdx + 1}...`);
    setupHlsStream(currentStreamUrls[currentStreamIdx], referer);
  } else {
    setupShieldStream(currentItem.options[currentOptionIdx].url, referer);
  }
}

function setupShieldStream(embedUrl, referer) {
  if (currentHls) {
    currentHls.destroy();
    currentHls = null;
  }
  videoPlayer.pause();
  videoPlayer.style.display = 'none';

  shieldFrame.style.display = 'block';
  // Use our sanitized clean embed route
  shieldFrame.src = `/player/clean-embed?url=${encodeURIComponent(embedUrl)}&referer=${encodeURIComponent(referer || 'https://cdplay.live/')}`;

  // Hide loader after frame starts loading
  shieldFrame.onload = () => {
    hideLoader();
  };

  // Fallback timeout to hide loader
  setTimeout(hideLoader, 2000);
}

function renderServerOptions(options, activeIdx) {
  serverOptions.innerHTML = '';
  options.forEach((opt, idx) => {
    const chip = document.createElement('button');
    chip.className = `server-chip ${idx === activeIdx ? 'active' : ''}`;
    chip.innerHTML = opt.isHD ? `⭐ ${opt.name}` : opt.name;
    chip.title = `Sintonizar ${opt.name}`;
    chip.onclick = () => {
      if (idx === currentOptionIdx) return;
      playItem(currentItem.title, currentItem.category, options, idx);
    };
    serverOptions.appendChild(chip);
  });
}

// --------------------------------------------------------------------------
// UI Rendering (Matches & Channels)
// --------------------------------------------------------------------------
function renderMatches(matches) {
  matchesGrid.innerHTML = '';

  if (matches.length === 0) {
    matchesGrid.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
        </svg>
        <h3>No se encontraron partidos</h3>
        <p>Prueba buscando con otro término o seleccionando "Todos".</p>
      </div>
    `;
    return;
  }

  matches.forEach(m => {
    const card = document.createElement('div');
    card.className = 'match-card';

    // Parse teams if title contains 'vs'
    let team1 = m.title;
    let team2 = '';
    if (m.title.toLowerCase().includes(' vs ')) {
      const parts = m.title.split(/ vs /i);
      team1 = parts[0].trim();
      team2 = parts[1].trim();
    }

    const optionsHtml = m.options.map((opt, i) => `
      <button class="match-channel-btn ${opt.isHD ? 'is-hd' : ''}" data-idx="${i}" title="Ver en ${opt.name}">
        <span class="play-icon">▶</span>
        ${opt.name}
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
          <h3 class="match-title">${m.title}</h3>
        `}
      </div>

      <div class="match-options-container">
        <div class="options-label">Canales disponibles:</div>
        <div class="options-pills">
          ${optionsHtml}
        </div>
      </div>
    `;

    // Click handler for option pills
    const buttons = card.querySelectorAll('.match-channel-btn');
    buttons.forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-idx'));
        playItem(m.fullTitle, m.tournament, m.options, idx);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };
    });

    matchesGrid.appendChild(card);
  });
}

function renderChannels(channels) {
  channelsGrid.innerHTML = '';

  if (channels.length === 0) {
    channelsGrid.innerHTML = `
      <div class="empty-state">
        <p>No se encontraron canales 24/7 para esta categoría.</p>
      </div>
    `;
    return;
  }

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
        <div class="channel-info">
          <h3>${ch.name}</h3>
          <span class="channel-cat-tag">${ch.category || 'Canal 24/7'}</span>
        </div>
      </div>
      <div class="channel-options">
        ${optionsHtml}
      </div>
    `;

    const buttons = card.querySelectorAll('.match-channel-btn');
    buttons.forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-idx'));
        playItem(ch.name, ch.category || 'Canal 24/7', ch.options, idx);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };
    });

    channelsGrid.appendChild(card);
  });
}

// --------------------------------------------------------------------------
// Controls & Event Listeners
// --------------------------------------------------------------------------
function setupTabs() {
  const tabs = document.querySelectorAll('.nav-tab');
  tabs.forEach(tab => {
    tab.onclick = () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const target = tab.getAttribute('data-tab');
      if (target === 'matches') {
        matchesTabContent.classList.add('active');
        channelsTabContent.classList.remove('active');
      } else {
        matchesTabContent.classList.remove('active');
        channelsTabContent.classList.add('active');
      }
    };
  });
}

function setupSearch() {
  searchInput.addEventListener('input', () => {
    clearSearchBtn.style.display = searchInput.value ? 'block' : 'none';
    applyFilters();
  });

  clearSearchBtn.onclick = () => {
    searchInput.value = '';
    clearSearchBtn.style.display = 'none';
    applyFilters();
  };

  refreshBtn.onclick = async () => {
    refreshBtn.classList.add('spinning');
    try {
      const res = await fetch('/api/refresh');
      const data = await res.json();
      if (data.ok) {
        await fetchInitialData();
      }
    } finally {
      setTimeout(() => refreshBtn.classList.remove('spinning'), 600);
    }
  };

  // Category pills for channels
  const cPills = document.querySelectorAll('#channelCategoryFilters .filter-pill');
  cPills.forEach(pill => {
    pill.onclick = () => {
      cPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      applyFilters();
    };
  });
}

function applyFilters() {
  const q = searchInput.value.toLowerCase().trim();

  // Active tournament filter
  const activeTPill = document.querySelector('#tournamentFilters .filter-pill.active');
  const tFilter = activeTPill ? activeTPill.getAttribute('data-filter') : 'all';

  const filteredMatches = allMatches.filter(m => {
    const matchesQuery = !q || m.fullTitle.toLowerCase().includes(q) || (m.tournament && m.tournament.toLowerCase().includes(q));
    const matchesTourn = tFilter === 'all' || (m.tournament && m.tournament.toLowerCase().includes(tFilter.toLowerCase()));
    return matchesQuery && matchesTourn;
  });
  renderMatches(filteredMatches);

  // Active channel category filter
  const activeCPill = document.querySelector('#channelCategoryFilters .filter-pill.active');
  const cFilter = activeCPill ? activeCPill.getAttribute('data-cat') : 'all';

  const filteredChannels = allChannels.filter(c => {
    const matchesQuery = !q || c.name.toLowerCase().includes(q);
    const matchesCat = cFilter === 'all' || (c.category && c.category.toLowerCase().includes(cFilter.toLowerCase())) || c.name.toLowerCase().includes(cFilter.toLowerCase());
    return matchesQuery && matchesCat;
  });
  renderChannels(filteredChannels);
}

function setupPlayerControls() {
  // Unmute Quick Action
  unmuteQuickBtn.onclick = () => {
    if (videoPlayer.style.display !== 'none') {
      videoPlayer.muted = false;
      videoPlayer.volume = 1;
    } else if (shieldFrame) {
      try {
        const frameDoc = shieldFrame.contentDocument || shieldFrame.contentWindow.document;
        const unmuteEl = frameDoc.getElementById('unmute') || frameDoc.getElementById('soundButton');
        if (unmuteEl) unmuteEl.click();
      } catch (e) {
        // Cross origin fallback message
      }
    }
    unmuteQuickBtn.classList.add('active');
    setTimeout(() => unmuteQuickBtn.classList.remove('active'), 1500);
  };

  // Theater mode
  theaterBtn.onclick = () => {
    isTheater = !isTheater;
    const playerContainer = document.getElementById('playerSection');
    playerContainer.classList.toggle('theater-mode', isTheater);
    theaterBtn.style.color = isTheater ? 'var(--primary)' : '';
  };

  // Fullscreen
  fullscreenBtn.onclick = () => {
    if (!document.fullscreenElement) {
      videoWrapper.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  // Picture in Picture
  pipBtn.onclick = async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled && videoPlayer.style.display !== 'none') {
        await videoPlayer.requestPictureInPicture();
      }
    } catch (e) {
      console.warn('PiP error:', e);
    }
  };

  // Reconnect
  reconnectBtn.onclick = () => {
    if (currentItem) {
      playItem(currentItem.title, currentItem.category, currentItem.options, currentOptionIdx);
    }
  };

  reconnectDirectBtn.onclick = () => {
    reconnectBtn.click();
  };

  retryBtn.onclick = () => {
    if (currentItem && currentItem.options.length > 1) {
      const nextIdx = (currentOptionIdx + 1) % currentItem.options.length;
      playItem(currentItem.title, currentItem.category, currentItem.options, nextIdx);
    } else {
      reconnectBtn.click();
    }
  };

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if (document.activeElement === searchInput) return;

    if (e.code === 'Space') {
      e.preventDefault();
      if (videoPlayer.style.display !== 'none') {
        videoPlayer.paused ? videoPlayer.play() : videoPlayer.pause();
      }
    } else if (e.code === 'KeyF') {
      e.preventDefault();
      fullscreenBtn.click();
    } else if (e.code === 'KeyT') {
      e.preventDefault();
      theaterBtn.click();
    } else if (e.code === 'KeyM') {
      e.preventDefault();
      videoPlayer.muted = !videoPlayer.muted;
    }
  });
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function showLoader(msg) {
  loaderMessage.textContent = msg || 'Cargando señal...';
  playerLoader.style.display = 'flex';
  playerError.style.display = 'none';
}

function hideLoader() {
  playerLoader.style.display = 'none';
}

function showError(msg) {
  hideLoader();
  errorMessage.textContent = msg || 'Ocurrió un error con el stream.';
  playerError.style.display = 'flex';
}

function hideError() {
  playerError.style.display = 'none';
}

