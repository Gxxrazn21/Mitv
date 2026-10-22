/* Remote navigation also works with a desktop keyboard. ?tv=1 forces TV layout. */
const tvMode = new URLSearchParams(location.search).get('tv');
const isTV = tvMode === '1' || (tvMode !== '0' && /AFT|Fire TV|Android TV|GoogleTV|SmartTV|SMART-TV|HbbTV/i.test(navigator.userAgent));
const lowResourceDevice = isTV || /Android/i.test(navigator.userAgent);
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
  const modal = document.getElementById('phoneModal');
  const selector = 'button, input, [tabindex="0"]';
  const visible = el => !el.disabled && !el.closest('.sidebar.collapsed') && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const candidates = () => [...(modal.style.display !== 'none' ? modal : document).querySelectorAll(selector)].filter(visible);
  const focus = el => { if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } };
  let lastMove = 0;
  document.addEventListener('keydown', e => {
    const key = e.key;
    const active = document.activeElement;
    if (key === 'Escape' || key === 'BrowserBack' || key === 'GoBack') {
      if (modal.style.display !== 'none') {
        e.preventDefault(); e.stopImmediatePropagation();
        document.getElementById('closePhoneModalBtn').click();
      } else if (active.closest('.stream-slot')) {
        e.preventDefault(); focus(document.getElementById('toggleSidebarBtn'));
      }
      return;
    }
    const input = active.matches('input, textarea, [contenteditable="true"]');
    if (input && (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Enter' || key === ' ')) return;
    if (key.startsWith('Arrow')) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.repeat && performance.now() - lastMove < 80) return;
      lastMove = performance.now();
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
