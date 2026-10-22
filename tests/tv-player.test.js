import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app-tv.js', import.meta.url), 'utf8');
const tv = readFileSync(new URL('../public/tv.js', import.meta.url), 'utf8');
function context(extra = {}) {
  const timers = new Map();
  let id = 0;
  const ctx = vm.createContext({
    document: { addEventListener() {}, documentElement: { classList: { toggle() {} } } },
    window: { addEventListener() {} }, location: { search: '?tv=1' }, navigator: { userAgent: 'AFT' },
    URLSearchParams, console, AbortController,
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: n => timers.delete(n),
    ...extra
  });
  vm.runInContext(tv + '\n' + app, ctx);
  return { ctx, timers, run: code => vm.runInContext(code, ctx) };
}
const rect = (x, y, w = 40, h = 40) => ({ contains: () => false, getBoundingClientRect: () => ({ left: x, right: x + w, top: y, bottom: y + h }) });
test('TV channel Up/Down moves one row, scrolls locally and never activates playback', () => {
  const callbacks = [], handlers = {};
  const list = { scrollTop:80, parentElement:null, getBoundingClientRect:() => ({top:0,bottom:80,left:0,right:200}) };
  const doc = {
    body:{}, documentElement:{classList:{toggle(){}}},
    addEventListener:(name, fn) => name === 'DOMContentLoaded' ? callbacks.push(fn) : handlers[name] = fn,
    getElementById:() => ({style:{display:'none'}}), querySelector:() => null
  };
  let clicks = 0;
  const rows = Array.from({length:5}, (_, i) => ({
    parentElement:list, closest: selector => selector === '.event-card' ? rows[i] : null,
    matches:() => false, focus:() => {doc.activeElement = rows[i];},
    click:() => clicks++,
    getBoundingClientRect:() => ({top:i*40-list.scrollTop,bottom:(i+1)*40-list.scrollTop,left:0,right:200})
  }));
  list.querySelectorAll = () => rows;
  const { ctx } = context({document:doc, performance:{now:()=>1000}, getComputedStyle:() => ({overflowY:'auto',overflowX:'hidden'})});
  callbacks[0]();
  doc.activeElement = rows[2];
  const key = name => handlers.keydown({key:name, preventDefault(){}, stopImmediatePropagation(){}});
  key('ArrowUp');
  assert.equal(doc.activeElement, rows[1]);
  assert.equal(list.scrollTop, 40);
  key('ArrowDown'); key('ArrowDown');
  assert.equal(doc.activeElement, rows[3]);
  assert.equal(list.scrollTop, 80);
  assert.equal(clicks, 0);
});
test('mobile and desktop do not register the TV keyboard handler or enable TV optimizations', () => {
  for (const userAgent of ['Mozilla Android Mobile', 'Mozilla Windows NT']) {
    const callbacks = [], events = [];
    const {run} = context({
      location:{search:''}, navigator:{userAgent},
      document:{documentElement:{classList:{toggle(){}}}, addEventListener:(name,fn) => {events.push(name); if(name === 'DOMContentLoaded') callbacks.push(fn);}}
    });
    callbacks[0]();
    assert.equal(run('isTV'), false);
    assert.equal(run('lowResourceDevice'), false);
    assert.equal(events.includes('keydown'), false);
  }
});
test('D-pad prefers aligned targets, supports all four directions and stops at edges', () => {
  const { ctx, run } = context();
  ctx.center = rect(100, 100); ctx.right = rect(160, 100); ctx.left = rect(40, 100);
  ctx.up = rect(100, 40); ctx.down = rect(100, 160); ctx.diagonal = rect(145, 145);
  run('var items = [center, right, left, up, down, diagonal]');
  for (const [key, name] of [['Right', 'right'], ['Left', 'left'], ['Up', 'up'], ['Down', 'down']]) {
    assert.equal(run(`directionalTarget(items, center, 'Arrow${key}')`), ctx[name]);
  }
  assert.equal(run("directionalTarget([center], center, 'ArrowRight')"), null);
});

function player() {
  const state = context();
  state.run(`
    var calls = [];
    var slot = {
      index: 0, currentMatch: {options: [{url:'a'}, {url:'b'}]}, currentOptionIdx: 0,
      videoEl: {style:{}, pause(){}, load(){}, removeAttribute(){}, canPlayType(){return ''}},
      iframeEl: {style:{}}, loaderEl:{style:{}}, errorEl:{style:{}}, emptyEl:{style:{}},
      errorText:{}, titleEl:{}, playPauseBtn:{}, mode:'hls', generation:1
    };
    slots = [slot];
    renderStageFooterServerChips = updateQualityIndicator = updateHeaderTitle = updatePlayPauseUI = () => {};
    loadStreamInSlot = (...args) => calls.push(args);
  `);
  return state;
}
test('startup watchdog advances once and final failure destroys media and keeps manual retry', () => {
  const { run, timers } = player();
  run("slot.videoEl.canPlayType = () => 'maybe'; slot.videoEl.play = () => Promise.resolve(); setupSlotHls(slot, 'a', '')");
  [...timers.values()][0]();
  assert.equal(run('calls.length'), 1);
  assert.equal(run('calls[0][2]'), 1);
  run("slot.currentMatch={options:[{},{}]}; slot.currentOptionIdx=1; slot.hlsInstance={destroy(){calls.push('destroy')}}; failSlot(slot,'offline')");
  assert.equal(run('slot.mode'), 'error');
  assert.equal(run('slot.errorText.textContent'), 'offline');
  assert.equal(run('slot.currentMatch.options.length'), 2);
  assert.equal(run('slot.videoEl.style.display'), 'none');
  assert.equal(run('slot.iframeEl.src'), 'about:blank');
  assert.equal(timers.size, 0);
});
test('missing HLS library uses native HLS without throwing', () => {
  const { run } = player();
  run("slot.videoEl.canPlayType = () => 'maybe'; slot.videoEl.play = () => Promise.resolve(); setupSlotHls(slot,'a','')");
  assert.match(run('slot.videoEl.src'), /^\/api\/stream\/m3u8/);
});
test('decoder recovery is bounded to two attempts', () => {
  const { ctx, run } = player();
  const handlers = {};
  let recoveries = 0;
  ctx.Hls = class {
    static isSupported() { return true; }
    static Events = { MANIFEST_PARSED:'manifest', LEVEL_SWITCHED:'level', ERROR:'error' };
    static ErrorTypes = { NETWORK_ERROR:'network', MEDIA_ERROR:'media' };
    loadSource() {} attachMedia() {} destroy() {}
    on(name, fn) { handlers[name] = fn; }
    recoverMediaError() { recoveries++; }
  };
  run("setupSlotHls(slot,'a','')");
  for (let i = 0; i < 3; i++) handlers.error(null, {fatal:true, type:'media'});
  assert.equal(recoveries, 2);
  assert.equal(run('calls.length'), 1);
});
test('autoplay rejection waits for user; stale rejection cannot affect next source', async () => {
  const { run } = player();
  run("slot.videoEl.play=()=>Promise.reject({name:'NotAllowedError'}); playSlotVideo(slot)");
  await Promise.resolve();
  assert.equal(run('slot.isUserPaused'), true);
  run("slot.isUserPaused=false; playSlotVideo(slot); slot.generation++");
  await Promise.resolve();
  assert.equal(run('slot.isUserPaused'), false);
});
