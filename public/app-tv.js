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

// 3 GPU Image Enhancement Modes: sharp (default), vivid, off
const ENHANCE_MODES = [
  { key: 'sharp', label: 'HD Nitidez', cssClass: 'enhance-sharp' },
  { key: 'vivid', label: 'Estadio Vivo', cssClass: 'enhance-vivid' },
  { key: 'off', label: 'OFF', cssClass: '' }
];
let currentEnhanceIdx = lowResourceDevice ? 2 : 0; // Starts with HD Nitidez by default

// Web Audio API Audio Normalizer (DynamicsCompressorNode)
let audioCtx = null;
let compressorNode = null;
const audioSourceMap = new Map(); // video element -> MediaElementAudioSourceNode

function setupAudioNormalizer(videoEl) {
  if (lowResourceDevice) return;
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
async function initializeMiTV() {
  initSlots();
  setupUIEventListeners();
  setupKeyboardShortcuts();
  applyEnhanceMode();
  if (lowResourceDevice) {
    const enhance = document.getElementById('enhanceBtn');
    enhance.disabled = true;
    enhance.title = 'Nitidez desactivada para compatibilidad en Android/TV';
  }
  setupVolumeControls();
  registerServiceWorkerSafely();
  window.mitvClientReady = true;
  window.dispatchEvent(new Event('mitv-ready'));

  await Promise.all([
    fetchSchedule(),
    fetchChannels(),
    fetchNetworkInfo()
  ]);

  // Auto-tune first match in Slot 0
  if (allMatches.length > 0) {
    loadStreamInSlot(0, allMatches[0], 0);
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeMiTV, { once: true });
} else {
  Promise.resolve().then(initializeMiTV);
}

// --------------------------------------------------------------------------
// Slots Setup
// --------------------------------------------------------------------------
function initSlots() {
  slots = [];
  for (let i = 0; i < SLOTS_COUNT; i++) {
    const slotEl = document.getElementById(`slot-${i}`);
    const videoEl = slotEl.querySelector('.slot-video');
    slotEl.tabIndex = 0;
    slotEl.setAttribute('role', 'group');
    slotEl.setAttribute('aria-label', `Pantalla ${i + 1}; pulsa OK para activar audio y controles`);
    const iframeEl = slotEl.querySelector('.slot-iframe');
    iframeEl.tabIndex = -1;
    iframeEl.title = `Reproductor externo ${i + 1}`;

    // Force mandatory WebView / Fire OS video attributes and GPU compositing
    if (videoEl) {
      if (typeof videoEl.setAttribute === 'function') {
        videoEl.setAttribute('playsinline', '');
        videoEl.setAttribute('webkit-playsinline', 'true');
        videoEl.setAttribute('x5-playsinline', 'true');
        videoEl.setAttribute('preload', 'auto');
        videoEl.setAttribute('autoplay', '');
      }
      videoEl.playsInline = true;
      if (videoEl.style) {
        videoEl.style.transform = 'translateZ(0)';
        videoEl.style.webkitTransform = 'translateZ(0)';
        videoEl.style.backfaceVisibility = 'hidden';
        videoEl.style.webkitBackfaceVisibility = 'hidden';
        videoEl.style.filter = 'none';
        videoEl.style.webkitFilter = 'none';
      }
    }

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
      playPauseBtn: slotEl.querySelector('.slot-playpause'),
      reloadBtn: slotEl.querySelector('.slot-reload'),
      closeBtn: slotEl.querySelector('.slot-close'),
      retryBtn: slotEl.querySelector('.slot-retry-btn'),
      hlsInstance: null,
      currentMatch: null,
      currentOptionIdx: 0,
      networkRecovered: false,
      networkRetryCount: 0,
      abortController: null,
      isUserPaused: false,
      mode: 'idle' // 'hls' | 'embed' | 'idle'
    });
  }

  // Bind slot interactions
  slots.forEach(slot => {
    // Dedicated Play/Pause button on floating bar
    if (slot.playPauseBtn) {
      slot.playPauseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSlotPlayPause(slot);
      });
    }

    // Unified slot activation handler: transfers active audio focus without ever pausing video
    const handleSlotActivation = (e) => {
      // Ignore clicks on control buttons (reload, close, play/pause)
      if (e.target.closest('.slot-actions') || e.target.closest('.slot-mini-btn') || e.target.tagName === 'BUTTON') {
        return;
      }

      // Prevent native browser default click handling on <video>
      if (e.target.tagName === 'VIDEO') {
        e.preventDefault();
      }

      // Instant focus switch if clicking an inactive slot
      if (focusedSlotIdx !== slot.index) {
        setFocusedSlot(slot.index);
      }

      // Ensure the clicked slot remains playing and is not paused by the click
      if (slot.mode === 'hls' && slot.videoEl && !slot.isUserPaused) {
        if (slot.videoEl.paused) {
          playSlotVideo(slot);
        }
      }
    };

    // Use pointerdown for instantaneous, zero-latency visual outline and audio switch
    slot.slotEl.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.slot-actions') || e.target.closest('.slot-mini-btn') || e.target.tagName === 'BUTTON') {
        return;
      }
      if (focusedSlotIdx !== slot.index) {
        setFocusedSlot(slot.index);
      }
    });

    slot.slotEl.addEventListener('click', handleSlotActivation);
    slot.videoEl.addEventListener('click', (e) => {
      e.preventDefault();
      handleSlotActivation(e);
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
      clearTimeout(slot.startupTimer);
      clearTimeout(slot.stallTimer);
      slot.stallTimer = null;
      slot.loaderEl.style.display = 'none';
      slot.errorEl.style.display = 'none';
      slot.emptyEl.style.display = 'none';
      slot.networkRecovered = false;
      slot.networkRetryCount = 0;

      // Enable Web Audio normalizer when focused
      if (slot.index === focusedSlotIdx) {
        setupAudioNormalizer(slot.videoEl);
      }
      updatePlayPauseUI(slot);
    });

    // Safeguard: if the browser pauses the video without user clicking dedicated pause button,
    // immediately resume playback!
    slot.videoEl.addEventListener('pause', () => {
      if (!slot.isUserPaused && slot.mode === 'hls' && slot.currentMatch) {
        requestAnimationFrame(() => {
          if (!slot.isUserPaused && slot.mode === 'hls' && slot.videoEl.paused) {
            playSlotVideo(slot);
          }
        });
      }
      updatePlayPauseUI(slot);
    });

    // Auto-resume as soon as enough data is buffered in WebView
    slot.videoEl.addEventListener('canplay', () => {
      if (slot.mode === 'hls' && !slot.isUserPaused && slot.videoEl.paused) {
        playSlotVideo(slot);
      }
    });
    slot.videoEl.addEventListener('loadedmetadata', () => {
      if (slot.mode === 'hls' && !slot.isUserPaused && slot.videoEl.paused) {
        playSlotVideo(slot);
      }
    });

    ['waiting', 'stalled'].forEach(type => slot.videoEl.addEventListener(type, () => {
      if (slot.mode !== 'hls' || slot.isUserPaused || slot.stallTimer) return;
      slot.stallTimer = setTimeout(() => {
        slot.stallTimer = null;
        if (slot.mode === 'hls' && !slot.isUserPaused) failSlot(slot, 'La señal dejó de responder.');
      }, 20000);
    }));
    slot.videoEl.addEventListener('error', () => {
      if (slot.mode === 'hls' && !slot.hlsInstance) failSlot(slot, 'El dispositivo no pudo reproducir este formato.');
    });
    slot.videoEl.addEventListener('play', () => {
      updatePlayPauseUI(slot);
    });

    // Iframe load event
    slot.iframeEl.addEventListener('load', () => {
      if (slot.mode === 'embed' && slot.iframeEl.src !== 'about:blank') {
        clearTimeout(slot.startupTimer);
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

    // Instant visual indication: Purple outline & glow
    slot.slotEl.classList.toggle('active-audio', isFocused);

    // Audio Muting Logic: ONLY focused slot produces sound, respecting master volume slider
    if (slot.mode === 'hls' && slot.videoEl) {
      if (isFocused) {
        // Activate audio on target screen respecting volume controls
        slot.videoEl.muted = isVolumeMuted;
        slot.videoEl.volume = isVolumeMuted ? 0 : currentVolume;
        // Never pause; ensure active playback continues
        if (!slot.isUserPaused && slot.mode === 'hls' && slot.videoEl.paused) {
          playSlotVideo(slot);
        }
        setupAudioNormalizer(slot.videoEl);
      } else {
        // Mute inactive screens without pausing them; keep all streams fluid
        slot.videoEl.muted = true;
        if (!slot.isUserPaused && slot.videoEl.paused && slot.currentMatch) {
          playSlotVideo(slot);
        }
      }
    } else if (slot.mode === 'embed' && slot.iframeEl && slot.iframeEl.contentWindow) {
      try {
        const shouldMute = !isFocused || isVolumeMuted;
        slot.iframeEl.contentWindow.postMessage({
          type: 'SET_MUTE',
          muted: shouldMute
        }, '*');
        if (isFocused) {
          slot.iframeEl.contentWindow.postMessage({
            type: 'SET_VOLUME',
            volume: shouldMute ? 0 : currentVolume
          }, '*');
        }
      } catch (e) {}
    }
  });

  // Sync Volume UI with focused slot
  syncVolumeUI();

  // Update Footer UI
  const pill = document.getElementById('focusedSlotPill');
  if (pill) {
    pill.textContent = `Pantalla ${targetIdx + 1} · Audio Activo`;
  }

  // Update Server Chips for focused slot
  renderStageFooterServerChips();

  // Update Quality Chip for focused slot
  updateQualityIndicator();

  // Update Footer Play/Pause button for the newly focused slot
  updatePlayPauseUI(slots[targetIdx]);

  // Update Header title
  updateHeaderTitle();

  // Highlight active match in sidebar
  highlightActiveMatchInSidebar();
}

// --------------------------------------------------------------------------
// Dedicated Play / Pause Controller
// --------------------------------------------------------------------------
function toggleSlotPlayPause(slot) {
  if (!slot) return;
  if (slot.mode === 'hls' && slot.videoEl) {
    if (slot.videoEl.paused) {
      slot.isUserPaused = false;
      slot.startupTimer = setTimeout(() => failSlot(slot, 'El video no respondió al reanudar.'), 25000);
      playSlotVideo(slot);
    } else {
      slot.isUserPaused = true;
      clearTimeout(slot.startupTimer);
      clearTimeout(slot.stallTimer);
      slot.stallTimer = null;
      slot.videoEl.pause();
    }
    updatePlayPauseUI(slot);
  }
}

function updatePlayPauseUI(slot) {
  if (!slot) return;
  const isPaused = slot.videoEl ? slot.videoEl.paused : false;

  // Mini-button on slot floating bar
  if (slot.playPauseBtn) {
    slot.playPauseBtn.textContent = isPaused ? '▶' : '❚❚';
    slot.playPauseBtn.title = isPaused ? 'Reanudar' : 'Pausar';
  }

  // Footer play/pause button (only reflects the focused slot)
  if (slot.index === focusedSlotIdx) {
    const iconEl = document.getElementById('playPauseFocusedIcon');
    const textEl = document.getElementById('playPauseFocusedText');
    if (iconEl && textEl) {
      iconEl.textContent = isPaused ? '▶' : '❚❚';
      textEl.textContent = isPaused ? 'Reanudar' : 'Pausar';
    }
  }
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
  slots.slice(maxVisible).forEach(slot => clearSlot(slot.index));
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
// GPU Image Enhancement Controller (HD Nitidez / Estadio Vivo / OFF)
// --------------------------------------------------------------------------
function applyEnhanceMode() {
  const mode = ENHANCE_MODES[currentEnhanceIdx];
  const label = document.getElementById('enhanceLabel');
  if (label) {
    label.textContent = mode.label;
  }

  const videoGrid = document.getElementById('videoGrid');
  if (videoGrid) {
    videoGrid.classList.remove('enhance-sharp', 'enhance-vivid', 'filter-sharp', 'filter-vivid');
    if (mode.cssClass) {
      videoGrid.classList.add(mode.cssClass);
    }
  }
}

function cycleImageEnhance() {
  if (lowResourceDevice) return;
  currentEnhanceIdx = (currentEnhanceIdx + 1) % ENHANCE_MODES.length;
  applyEnhanceMode();
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
    if (slot && slot.mode === 'embed') {
      qualityLabel.textContent = 'Externo';
      qualityBtn.classList.add('forced');
      return;
    }
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

  if (hls.autoLevelEnabled) {
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

  if (hls.autoLevelEnabled) {
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
  clearTimeout(slot.startupTimer);

  // Abort any in-flight resolve to prevent race condition
  if (slot.abortController) {
    slot.abortController.abort();
    slot.abortController = null;
  }

  if (slot.hlsInstance) {
    try {
      if (typeof slot.hlsInstance.stopLoad === 'function') slot.hlsInstance.stopLoad();
      if (typeof slot.hlsInstance.detachMedia === 'function') slot.hlsInstance.detachMedia();
    } catch (e) {}
    slot.hlsInstance.destroy();
    slot.hlsInstance = null;
  }

  slot.generation = (slot.generation || 0) + 1;
  slot.mode = 'idle';
  clearTimeout(slot.stallTimer);
  slot.stallTimer = null;
  slot.iframeEl.onload = null;
  slot.videoEl.pause();
  slot.videoEl.removeAttribute('src');
  slot.videoEl.load();
  slot.videoEl.style.display = 'none';

  slot.iframeEl.src = 'about:blank';
  slot.iframeEl.style.display = 'none';

  slot.currentMatch = null;
  slot.currentOptionIdx = 0;
  slot.networkRecovered = false;
  slot.networkRetryCount = 0;
  slot.mediaRetryCount = 0;
  slot.isUserPaused = false;
  slot.mode = 'idle';
  updatePlayPauseUI(slot);

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

  // Abort any in-flight resolve on this slot to prevent race conditions
  if (slot.abortController) {
    slot.abortController.abort();
    slot.abortController = null;
  }
  const controller = new AbortController();
  slot.abortController = controller;
  clearTimeout(slot.startupTimer);
  let resolveTimedOut = false;
  const resolveTimer = setTimeout(() => {
    resolveTimedOut = true;
    controller.abort();
  }, 20000);

  // Clean prior player in this slot
  if (slot.hlsInstance) {
    try {
      if (typeof slot.hlsInstance.stopLoad === 'function') slot.hlsInstance.stopLoad();
      if (typeof slot.hlsInstance.detachMedia === 'function') slot.hlsInstance.detachMedia();
    } catch (e) {}
    slot.hlsInstance.destroy();
    slot.hlsInstance = null;
  }
  slot.generation = (slot.generation || 0) + 1;
  slot.mode = 'idle';
  clearTimeout(slot.stallTimer);
  slot.stallTimer = null;
  slot.iframeEl.onload = null;
  slot.videoEl.pause();
  slot.videoEl.removeAttribute('src');
  slot.videoEl.load();
  slot.iframeEl.src = 'about:blank';

  slot.currentMatch = matchData;
  slot.currentOptionIdx = optionIndex;
  slot.networkRecovered = false;
  slot.networkRetryCount = 0;
  slot.mediaRetryCount = 0;
  slot.isUserPaused = false;
  updatePlayPauseUI(slot);
  slot.emptyEl.style.display = 'none';
  slot.errorEl.style.display = 'none';
  slot.loaderText.textContent = `Sintonizando ${option.name}...`;
  slot.loaderEl.style.display = 'flex';
  slot.titleEl.textContent = `${slotIdx + 1}. ${matchData.title || matchData.name} (${option.name})`;

  // Set focused slot
  setFocusedSlot(slotIdx);

  try {
    // Provide alternative options to backend for transparent failover
    const candidateFallbacks = (matchData.options || [])
      .filter((_, idx) => idx > optionIndex)
      .map(o => ({ name: o.name, url: o.url }));

    const resolveQuery = `/api/resolve?url=${encodeURIComponent(option.url)}&fallbacks=${encodeURIComponent(JSON.stringify(candidateFallbacks))}`;
    const resolveRes = await fetch(resolveQuery, {
      signal: controller.signal
    });
    const result = await resolveRes.json();

    if (slot.abortController !== controller) return; // Stale request cancelled

    if (!result.ok) {
      throw new Error(result.error || 'No se pudo resolver el stream');
    }

    // Check if the backend rescued the channel using an alternative option
    if (result.fallbackUsed && result.rescuedOption) {
      console.log(`[Failover Rescatado] El servidor activó automáticamente el respaldo: ${result.rescuedOption}`);
      const rescuedIdx = matchData.options.findIndex(o => o.name === result.rescuedOption);
      if (rescuedIdx !== -1) {
        slot.currentOptionIdx = rescuedIdx;
      }
      slot.titleEl.textContent = `${slotIdx + 1}. ${matchData.title || matchData.name} (${result.rescuedOption} - Respaldo)`;
      if (focusedSlotIdx === slotIdx) {
        renderStageFooterServerChips();
      }
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
    if (slot.abortController !== controller) return;
    if (err.name === 'AbortError' && !resolveTimedOut) return;
    if (resolveTimedOut) err = new Error('La fuente tardó más de 20 segundos en responder');
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
  } finally {
    clearTimeout(resolveTimer);
    if (slot.abortController === controller) {
      slot.abortController = null;
    }
  }
}

// HLS.js Setup with Max-Bitrate & Intelligent Error Recovery
function failSlot(slot, message) {
  const match = slot.currentMatch;
  const next = slot.currentOptionIdx + 1;
  clearSlot(slot.index);
  if (match && next < match.options.length) {
    loadStreamInSlot(slot.index, match, next);
    return;
  }
  slot.currentMatch = match;
  slot.currentOptionIdx = Math.max(0, next - 1);
  slot.mode = 'error';
  slot.emptyEl.style.display = 'none';
  slot.errorText.textContent = message;
  slot.errorEl.style.display = 'flex';
  if (slot.index === focusedSlotIdx) renderStageFooterServerChips();
}

function playSlotVideo(slot) {
  const generation = slot.generation;
  slot.videoEl.play().catch(err => {
    if (slot.generation !== generation || err.name !== 'NotAllowedError' || slot.mode !== 'hls') return;
    clearTimeout(slot.startupTimer);
    clearTimeout(slot.stallTimer);
    slot.stallTimer = null;
    slot.isUserPaused = true;
    slot.loaderEl.style.display = 'none';
    slot.errorText.textContent = 'Pulsa Reanudar para iniciar el video.';
    slot.errorEl.style.display = 'flex';
  });
}

function setupSlotHls(slot, streamUrl, referer) {
  clearTimeout(slot.startupTimer);
  slot.startupTimer = setTimeout(() => failSlot(slot, 'La fuente no inició el video en 25 segundos.'), 25000);
  slot.iframeEl.style.display = 'none';
  slot.videoEl.style.display = 'block';

  // Force GPU hardware acceleration styles and strip any SVG/CSS filters that break TV WebViews
  if (slot.videoEl.style) {
    slot.videoEl.style.transform = 'translateZ(0)';
    slot.videoEl.style.webkitTransform = 'translateZ(0)';
    slot.videoEl.style.backfaceVisibility = 'hidden';
    slot.videoEl.style.webkitBackfaceVisibility = 'hidden';
    slot.videoEl.style.filter = 'none';
    slot.videoEl.style.webkitFilter = 'none';
  }

  // Ensure attributes for inline playback and autoplay in WebView
  if (typeof slot.videoEl.setAttribute === 'function') {
    slot.videoEl.setAttribute('playsinline', '');
    slot.videoEl.setAttribute('webkit-playsinline', 'true');
    slot.videoEl.setAttribute('x5-playsinline', 'true');
    slot.videoEl.setAttribute('preload', 'auto');
  }
  slot.videoEl.playsInline = true;

  // Apply current object-fit
  const currentFit = FIT_MODES[currentFitIdx].key;
  if (slot.videoEl.style) {
    slot.videoEl.style.objectFit = currentFit;
  }

  // Use playlist proxy with full URL resolution
  const proxiedM3u8 = `/api/stream/m3u8?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(referer || 'https://xstream.st/')}`;

  if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    const hls = new Hls({
      enableWorker: !lowResourceDevice, // Disable worker on TV/WebView to prevent thread transfer stalls
      lowLatencyMode: true,
      capLevelToPlayerSize: lowResourceDevice, // Smaller TV slots need less decoding work.
      startLevel: -1, // Select initial quality using measured bandwidth.
      maxBufferLength: lowResourceDevice ? 15 : 30,
      maxMaxBufferLength: lowResourceDevice ? 20 : 45,
      maxBufferSize: lowResourceDevice ? 20 * 1000 * 1000 : 60 * 1000 * 1000,
      backBufferLength: lowResourceDevice ? 5 : 15
    });

    slot.hlsInstance = hls;
    hls.loadSource(proxiedM3u8);
    hls.attachMedia(slot.videoEl);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      const isFocused = (slot.index === focusedSlotIdx);
      slot.videoEl.muted = !isFocused || isVolumeMuted;
      slot.videoEl.volume = (!isFocused || isVolumeMuted) ? 0 : currentVolume;
      playSlotVideo(slot);
      updateQualityIndicator();
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, () => {
      updateQualityIndicator();
    });

    // Intelligent Error Recovery with Exponential Backoff
    hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            slot.networkRetryCount = (slot.networkRetryCount || 0) + 1;
            const httpCode = data.response?.code;
            // If upstream CDN blocked (403/502) or repeated retries failed, failover immediately to next option
            if (httpCode === 403 || httpCode === 502 || slot.networkRetryCount > 2) {
              slot.networkRetryCount = 0;
              console.warn(`[HLS] Bloqueo o caída de upstream (${httpCode || 'Red'}) en ranura ${slot.index + 1}. Alternando a opción de respaldo...`);
              failSlot(slot, 'Canal no disponible actualmente');
              return;
            }

            const backoffMs = Math.min(slot.networkRetryCount * 1000, 3000);
            console.log(`[HLS] Recuperando micro-corte de red en ranura ${slot.index + 1} (intento ${slot.networkRetryCount}/2 en ${backoffMs}ms)...`);
            setTimeout(() => {
              if (slot.hlsInstance === hls && slot.mode === 'hls') {
                if (data.details === 'manifestLoadError' || data.details === 'manifestLoadTimeOut' || slot.networkRetryCount === 1) {
                  hls.loadSource(proxiedM3u8);
                } else {
                  hls.startLoad();
                }
              }
            }, backoffMs);
            break;

          case Hls.ErrorTypes.MEDIA_ERROR:
            console.log(`[HLS] Error de códec/medio en ranura ${slot.index + 1}, ejecutando recoverMediaError()...`);
            slot.mediaRetryCount = (slot.mediaRetryCount || 0) + 1;
            if (slot.mediaRetryCount <= 2) {
              if (slot.mediaRetryCount === 2 && typeof hls.swapAudioCodec === 'function') {
                try { hls.swapAudioCodec(); } catch (e) {}
              }
              hls.recoverMediaError();
            } else {
              failSlot(slot, 'No se pudo recuperar el decodificador de video.');
            }
            break;

          default:
            console.warn(`[HLS] Error crítico en ranura ${slot.index + 1}:`, data.details);
            failSlot(slot, 'Error de transmisión');
            break;
        }
      }
    });
  } else if (slot.videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    slot.videoEl.src = proxiedM3u8;
    const isFocused = (slot.index === focusedSlotIdx);
    slot.videoEl.muted = !isFocused || isVolumeMuted;
    slot.videoEl.volume = (!isFocused || isVolumeMuted) ? 0 : currentVolume;

    const onCanPlay = () => {
      if (slot.mode === 'hls' && !slot.isUserPaused) {
        playSlotVideo(slot);
      }
    };
    if (typeof slot.videoEl.addEventListener === 'function') {
      slot.videoEl.addEventListener('canplay', onCanPlay, { once: true });
      slot.videoEl.addEventListener('loadedmetadata', onCanPlay, { once: true });
    }
    if (typeof slot.videoEl.load === 'function') {
      slot.videoEl.load();
    }
    playSlotVideo(slot);
  } else {
    failSlot(slot, 'Navegador no compatible con HLS');
  }
}

// Sandboxed Clean-Embed Setup for DRM / Shaka Player pages
function setupSlotEmbed(slot, embedUrl) {
  slot.videoEl.pause();
  slot.videoEl.style.display = 'none';
  slot.iframeEl.style.display = 'block';

  slot.startupTimer = setTimeout(() => failSlot(slot, 'El reproductor externo no respondió en 25 segundos.'), 25000);
  slot.iframeEl.src = embedUrl;

  slot.iframeEl.onload = () => {
    if (slot.mode !== 'embed') return;
    clearTimeout(slot.startupTimer);
    slot.loaderEl.style.display = 'none';
    slot.errorEl.style.display = 'none';
    slot.emptyEl.style.display = 'none';
    updateQualityIndicator();
    try {
      const isFocused = (slot.index === focusedSlotIdx);
      const shouldMute = !isFocused || isVolumeMuted;
      slot.iframeEl.contentWindow.postMessage({
        type: 'SET_MUTE',
        muted: shouldMute
      }, '*');
      if (isFocused) {
        slot.iframeEl.contentWindow.postMessage({
          type: 'SET_VOLUME',
          volume: shouldMute ? 0 : currentVolume
        }, '*');
      }

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
  const focusedChip = [...container.children].indexOf(document.activeElement);
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
  if (focusedChip >= 0) container.children[Math.min(focusedChip, container.children.length - 1)]?.focus();
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
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.dataset.itemId = String(item.id);
    card.setAttribute('aria-label', item.title || item.name);

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
    card.classList.toggle('active-in-slot', activeId != null && card.dataset.itemId === String(activeId));
  });
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

  // Dedicated Play / Pause button in footer
  const playPauseFocusedBtn = document.getElementById('playPauseFocusedBtn');
  if (playPauseFocusedBtn) {
    playPauseFocusedBtn.addEventListener('click', () => {
      const slot = slots[focusedSlotIdx];
      if (slot) {
        toggleSlotPlayPause(slot);
      }
    });
  }

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
      document.documentElement.requestFullscreen?.().catch(() => {});
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
    closePhoneModalBtn.focus();
  });
  closePhoneModalBtn.addEventListener('click', () => {
    phoneModal.style.display = 'none';
    mobileBtn.focus();
  });
  phoneModal.addEventListener('click', (e) => {
    if (e.target === phoneModal) {
      phoneModal.style.display = 'none';
      mobileBtn.focus();
    }
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
    if (e.defaultPrevented) return;
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
      if (slot) {
        toggleSlotPlayPause(slot);
      }
    }

    // Key 'f' toggles Fullscreen
    if (e.key === 'f' || e.key === 'F') {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    }

    // Key 'm' or 'M' toggles Mute
    if (e.key === 'm' || e.key === 'M') {
      toggleMasterMute();
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

// --------------------------------------------------------------------------
// Master Volume & Independent Mute Controller
// --------------------------------------------------------------------------
let currentVolume = 1.0;
let isVolumeMuted = false;
let preMuteVolume = 1.0;

function syncVolumeUI() {
  const slider = document.getElementById('volumeSlider');
  const percentLabel = document.getElementById('volumePercent');
  const muteBtn = document.getElementById('volumeMuteBtn');
  const muteIcon = document.getElementById('volumeMuteIcon');

  const effectiveVal = isVolumeMuted ? 0 : currentVolume;

  if (slider) slider.value = effectiveVal;
  if (percentLabel) percentLabel.textContent = `${Math.round(effectiveVal * 100)}%`;

  if (muteBtn && muteIcon) {
    if (isVolumeMuted || currentVolume === 0) {
      muteIcon.textContent = '🔇';
      muteBtn.classList.add('muted');
      muteBtn.setAttribute('title', 'Activar sonido (M)');
    } else {
      muteIcon.textContent = currentVolume < 0.5 ? '🔉' : '🔊';
      muteBtn.classList.remove('muted');
      muteBtn.setAttribute('title', 'Silenciar (M)');
    }
  }
}

function setMasterVolume(val, muted = false) {
  const clamped = Math.max(0, Math.min(1, val));
  currentVolume = clamped;
  isVolumeMuted = muted || clamped === 0;

  syncVolumeUI();

  // Apply directly to focused slot
  const focusedSlot = slots[focusedSlotIdx];
  if (focusedSlot) {
    if (focusedSlot.mode === 'hls' && focusedSlot.videoEl) {
      focusedSlot.videoEl.muted = isVolumeMuted;
      focusedSlot.videoEl.volume = isVolumeMuted ? 0 : clamped;
    } else if (focusedSlot.mode === 'embed' && focusedSlot.iframeEl && focusedSlot.iframeEl.contentWindow) {
      try {
        focusedSlot.iframeEl.contentWindow.postMessage({
          type: 'SET_MUTE',
          muted: isVolumeMuted
        }, '*');
        focusedSlot.iframeEl.contentWindow.postMessage({
          type: 'SET_VOLUME',
          volume: isVolumeMuted ? 0 : clamped
        }, '*');
      } catch (e) {}
    }
  }
}

function toggleMasterMute() {
  if (isVolumeMuted || currentVolume === 0) {
    // Unmute
    const restore = preMuteVolume > 0 ? preMuteVolume : 1.0;
    setMasterVolume(restore, false);
  } else {
    // Mute
    preMuteVolume = currentVolume > 0 ? currentVolume : 1.0;
    setMasterVolume(0, true);
  }
}

function setupVolumeControls() {
  const muteBtn = document.getElementById('volumeMuteBtn');
  const slider = document.getElementById('volumeSlider');

  if (muteBtn) {
    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMasterMute();
    });
  }

  if (slider) {
    slider.addEventListener('input', (e) => {
      e.stopPropagation();
      const val = parseFloat(e.target.value);
      if (val === 0) {
        setMasterVolume(0, true);
      } else {
        preMuteVolume = val;
        setMasterVolume(val, false);
      }
    });
  }

  syncVolumeUI();
}

// --------------------------------------------------------------------------
// Safe Service Worker Registration for IP / HTTP / PWA Environments
// --------------------------------------------------------------------------
function registerServiceWorkerSafely() {
  // Only register Service Worker in secure contexts (HTTPS or localhost / 127.0.0.1)
  const isSecure = window.isSecureContext || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

  if ('serviceWorker' in navigator && isSecure) {
    const register = () => {
      navigator.serviceWorker.register('/sw.js')
        .then((reg) => {
          console.log('[PWA] Service Worker registrado exitosamente con alcance:', reg.scope);
        })
        .catch((err) => {
          console.warn('[PWA] Advertencia al registrar Service Worker:', err.message);
        });
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  } else {
    console.log('[PWA] Contexto HTTP o IP no seguro detectado. Service Worker desactivado para prevenir bloqueos o errores de consola.');
  }
}
