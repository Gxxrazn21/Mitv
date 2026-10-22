import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

for (const file of ['app.js', 'app-tv.js']) {
  for (const readyState of ['loading', 'complete']) {
    test(`${file} initializes once when loaded during ${readyState}`, async () => {
      const listeners = {};
      const ctx = vm.createContext({
        lowResourceDevice:false, Event, console,
        document:{readyState, addEventListener:(type,fn) => {listeners[type]=fn;}},
        window:{addEventListener(){}, dispatchEvent(){}}, count:0
      });
      vm.runInContext(readFileSync(new URL('../public/' + file, import.meta.url),'utf8') + `
        initSlots = () => count++;
        setupUIEventListeners = setupKeyboardShortcuts = applyEnhanceMode = setupVolumeControls = registerServiceWorkerSafely = () => {};
        fetchSchedule = fetchChannels = fetchNetworkInfo = async () => {};
      `, ctx);
      if (readyState === 'loading') await listeners.DOMContentLoaded();
      else await Promise.resolve();
      assert.equal(ctx.count, 1);
      assert.equal(ctx.window.mitvClientReady, true);
    });
  }
}

test('entry loads one ordinary script for each platform, without document.write', () => {
  for (const isTV of [false, true]) {
    let loaded;
    const ctx = vm.createContext({
      isTV, setTimeout(){return 1;}, clearTimeout(){},
      window:{addEventListener(){}},
      document:{createElement:() => ({}), head:{appendChild:el => {loaded=el;}}}
    });
    vm.runInContext(readFileSync(new URL('../public/player-entry.js', import.meta.url),'utf8'), ctx);
    assert.equal(loaded.src, (isTV ? 'app-tv.js' : 'app.js') + '?v=8.2');
  }
});

test('audio highlighting never rebuilds mobile channel list or resets scroll', () => {
  let rendered = false;
  const cards = [{dataset:{itemId:'a'},classList:{toggle(){}}}];
  const ctx = vm.createContext({
    document:{readyState:'loading',addEventListener(){},querySelectorAll:() => cards},
    window:{addEventListener(){}},
    render:() => {rendered=true;}
  });
  vm.runInContext(readFileSync(new URL('../public/app.js',import.meta.url),'utf8') + `
    renderSidebarList = render;
    slots = [{currentMatch:{id:'a'}}];
    highlightActiveMatchInSidebar();
  `,ctx);
  assert.equal(rendered, false);
});
