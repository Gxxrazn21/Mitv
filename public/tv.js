/* Remote navigation also works with a desktop keyboard. ?tv=1 forces TV layout. */
const tvMode = new URLSearchParams(location.search).get('tv');
const isTV = tvMode === '1' || (tvMode !== '0' && /AFT|Fire TV|Android TV|GoogleTV|SmartTV|SMART-TV|HbbTV/i.test(navigator.userAgent));
const lowResourceDevice = isTV;
document.documentElement.classList.toggle('tv-mode', isTV);
document.documentElement.classList.toggle('low-resource', lowResourceDevice);

function directionalTarget(items, current, direction) {
  const from = current.getBoundingClientRect();
  const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight';
  const sign = direction === 'ArrowLeft' || direction === 'ArrowUp' ? -1 : 1;
  let best = null, bestScore = Infinity;
  for (const item of items) {
    if (item === current || item.contains(current)) continue;
    const to = item.getBoundingClientRect();
    const dx = (to.left + to.right - from.left - from.right) / 2;
    const dy = (to.top + to.bottom - from.top - from.bottom) / 2;
    const forward = (horizontal ? dx : dy) * sign;
    if (forward <= 1) continue;
    const aligned = horizontal ? to.bottom > from.top && to.top < from.bottom : to.right > from.left && to.left < from.right;
    const score = forward + Math.abs(horizontal ? dy : dx) * 3 + (aligned ? 0 : 10000);
    if (score < bestScore) { best = item; bestScore = score; }
  }
  return best;
}

document.addEventListener('DOMContentLoaded', () => {
  if (!isTV) return;
  const modal = document.getElementById('phoneModal');
  const selector = 'button, input, [tabindex="0"]';
  const visible = el => !el.disabled && !el.closest('.sidebar.collapsed') && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const candidates = () => [...(modal.style.display !== 'none' ? modal : document).querySelectorAll(selector)].filter(visible);
  const focus = el => {
    if (!el) return;
    el.focus({ preventScroll: true });
    // Scroll only the local list/toolbar, never the page or the video stage.
    let parent = el.parentElement;
    while (parent && parent !== document.body) {
      const style = getComputedStyle(parent);
      const rect = el.getBoundingClientRect(), box = parent.getBoundingClientRect();
      if (/auto|scroll/.test(style.overflowY)) {
        if (rect.top < box.top) parent.scrollTop -= box.top - rect.top;
        else if (rect.bottom > box.bottom) parent.scrollTop += rect.bottom - box.bottom;
      }
      if (/auto|scroll/.test(style.overflowX)) {
        if (rect.left < box.left) parent.scrollLeft -= box.left - rect.left;
        else if (rect.right > box.right) parent.scrollLeft += rect.right - box.right;
      }
      parent = parent.parentElement;
    }
  };
  let lastMove = 0;
  document.addEventListener('keydown', e => {
    const key = e.key;
    const active = document.activeElement;
    if (key === 'Escape' || key === 'BrowserBack' || key === 'GoBack' || key === 'Backspace' || e.keyCode === 4 || e.keyCode === 27) {
      if (modal.style.display !== 'none') {
        e.preventDefault(); e.stopImmediatePropagation();
        document.getElementById('closePhoneModalBtn').click();
        return;
      }
      const isFull = !!(document.fullscreenElement || document.documentElement.classList.contains('is-fullscreen'));
      if (isFull) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (document.fullscreenElement) {
          document.exitFullscreen?.().catch(() => {});
        }
        document.documentElement.classList.remove('is-fullscreen');
        const fullscreenBtn = document.getElementById('fullscreenBtn');
        if (fullscreenBtn) {
          const label = fullscreenBtn.querySelector('span');
          if (label) label.textContent = 'Pantalla Completa';
        }
        const activeSlot = document.querySelector('.stream-slot.active-audio') || document.querySelector('.stream-slot');
        focus(activeSlot || document.getElementById('toggleSidebarBtn'));
        return;
      }
      if (active && active.closest && active.closest('.stream-slot')) {
        e.preventDefault(); focus(document.getElementById('toggleSidebarBtn'));
        return;
      }
      return;
    }
    const input = active.matches('input, textarea, [contenteditable="true"]');
    if (input && (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Enter' || key === ' ')) return;
    if (key.startsWith('Arrow')) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.repeat && performance.now() - lastMove < 80) return;
      lastMove = performance.now();
      // Channel rows are ordered content. Never jump to another region while
      // moving vertically through them, even when neighbouring rows are clipped.
      const card = active.closest('.event-card');
      if (card && (key === 'ArrowUp' || key === 'ArrowDown')) {
        const rows = [...card.parentElement.querySelectorAll('.event-card')];
        const next = rows[rows.indexOf(card) + (key === 'ArrowUp' ? -1 : 1)];
        if (next) focus(next);
        else if (key === 'ArrowUp') focus(document.querySelector('.filter-chip.active') || document.getElementById('searchInput'));
        return;
      }
      const items = candidates();
      focus(items.includes(active) ? directionalTarget(items, active, key) : items[0]);
    } else if ((key === 'Enter' || key === ' ' || key === 'Select') && active.matches(selector)) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat) {
        // Enter on a slot selects audio and moves to its controls.
        active.click();
        if (active.classList.contains('stream-slot')) focus(active.querySelector('button'));
      }
    } else if (key === 'Tab' && modal.style.display !== 'none') {
      const items = candidates(), i = items.indexOf(active);
      e.preventDefault(); focus(items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length]);
    } else if (key === 'MediaPlayPause') {
      e.preventDefault(); document.getElementById('playPauseFocusedBtn').click();
    }
  }, true);
  if (isTV) focus(document.querySelector('#layoutSelector button'));
});
