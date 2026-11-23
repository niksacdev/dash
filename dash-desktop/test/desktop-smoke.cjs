const { app } = require("electron");
const { once } = require("node:events");
const { mkdtempSync, writeFileSync } = require("node:fs");
const os = require("node:os"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const temporary = mkdtempSync(path.join(os.tmpdir(), "dash-desktop-smoke-"));
app.setPath("userData", temporary);
app.dock?.hide();
app.on("browser-window-created", (_event, win) => { win.show = () => {}; });
globalThis.fetch = async () => { throw Error("Offline replay test"); };
require("../lib/power.cjs").readPower = async () => ({ watts: null });

async function checkOverview(window, js, wait) {
  const client = window.webContents.debugger;
  client.attach();
  const send = (method, args) => client.sendCommand(method, args);
  const point = selector => js(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return {x: r.x + r.width / 2, y: r.y + r.height / 2};
  })()`);
  const key = async (name, code) => {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {type, key:name, code:name, windowsVirtualKeyCode:code});
  };
  const screenshot = async name => {
    const { data } = await send("Page.captureScreenshot", {format: "png"});
    writeFileSync(path.join(temporary, name), Buffer.from(data, "base64"));
  };
  const selectTheme = value =>
    js(`document.querySelector('#appearance input[value="${value}"]').closest('label').click()`);
  const themeIs = value =>
    `document.documentElement.dataset.appearance === "${value}" &&
     document.querySelector('#appearance input[value="${value}"]').checked &&
     getComputedStyle(document.documentElement).colorScheme === "${value}"`;
  const open = "document.querySelector('#device-details').matches(':popover-open')";

  try {
    await send("Emulation.setDeviceMetricsOverride", {width:1310, height:850, deviceScaleFactor:1, mobile:false});
    await js("location.hash='home'");
    await wait("document.querySelector('#overview-total-runs')?.textContent === '2'");
    await wait(themeIs("light"));

    const artLoaded = await js(`(async () => {
      const background = getComputedStyle(document.querySelector('.capability-reel'), '::before').backgroundImage;
      const asset = background.match(/url\\("([^"]+)"\\)/)?.[1];
      if (!asset || new URL(asset).pathname.split('/').pop() !== 'scarlet-circuit.jpg') return false;
      const image = new Image();
      image.src = asset;
      await image.decode();
      return image.naturalWidth > 0 && image.naturalHeight > 0;
    })()`);
    assert.equal(artLoaded, true, "The actual banner artwork must load");
    await send("Emulation.setEmulatedMedia", {features:[{name:"prefers-reduced-motion",value:"reduce"}]});
    await screenshot("overview-light.png");
    const lightCanvas = await js("getComputedStyle(document.documentElement).backgroundColor");

    await selectTheme("dark");
    await wait(themeIs("dark"));
    const loaded = once(window.webContents, "did-finish-load");
    window.webContents.reload();
    await loaded;
    await wait("document.querySelector('#overview-total-runs')?.textContent === '2'");
    await wait(themeIs("dark"));
    assert.notEqual(await js("getComputedStyle(document.documentElement).backgroundColor"), lightCanvas);
    const choices = await js("Array.from(document.querySelectorAll('#appearance input'), r => ({label:r.parentElement.textContent.trim(),value:r.value,checked:r.checked}))");
    assert.deepEqual(choices, [
      {label:"Light",value:"light",checked:false},
      {label:"Dark",value:"dark",checked:true},
    ],"Appearance choices and checked label must survive a restart");
    await screenshot("overview-dark.png");

    const device = await point(".device-stat");
    await send("Input.dispatchMouseEvent", {type:"mouseMoved", ...device});
    await wait(open);
    assert.ok(await js("document.querySelector('#device-details').innerText.includes('Platform')"));
    await send("Input.dispatchMouseEvent", {type:"mouseMoved",x:5,y:5});
    await wait("!" + open);
    await send("Emulation.setFocusEmulationEnabled", {enabled:true});
    await js("document.querySelector('[data-carousel=next]').focus()");
    await key("Tab",9);
    await wait("document.activeElement.matches('.device-stat') && " + open);
    await key("Escape",27);
    await wait("!" + open);

    await send("Emulation.setDeviceMetricsOverride", {width:390, height:844, deviceScaleFactor:1, mobile:false});
    await send("Emulation.setTouchEmulationEnabled", {enabled:true,maxTouchPoints:1});
    await wait("innerWidth === 390");
    const bounds = await js(`(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const hero = rect('.hero'), controls = rect('#appearance'), count = rect('#overview-total-runs');
      return {overflow:document.documentElement.scrollWidth - innerWidth,
        left: hero.left - rect('aside').right, top: hero.top - rect('header').bottom,
        controlsFit:controls.left >= hero.left && controls.right <= innerWidth, countFits:count.right <= innerWidth};
    })()`);
    assert.deepEqual(bounds,{overflow:0,left:0,top:0,controlsFit:true,countFits:true});
    await js("document.activeElement.blur()");
    const tap = async position => {
      await send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[position]});
      await send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    };
    await tap(await point(".device-stat"));
    await wait(open);
    assert.ok(await js(`(() => {const r=document.querySelector('#device-details').getBoundingClientRect();
      return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;})()`));
    await tap(await point(".hero h1"));
    await wait("!" + open);
    await selectTheme("light");
    await wait(themeIs("light"));
  } finally {
    client.detach();
  }
}
app
  .whenReady()
  .then(async () => {
    const window = await require("../desktop.cjs").openWindow();
    const js = async source => {
      try { return await window.webContents.executeJavaScript(source); }
      catch (error) { throw new Error("Renderer assertion failed: " + source, {cause:error}); }
    };
    const wait = async (check) => {
      for (let i = 0; i < 110; i++) {
        if (await js(check)) return;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      throw Error(
        "UI check timed out: " +
          check +
          " | " +
          (await js("document.body.innerText.slice(-1200)")),
      );
    };
    await wait("document.querySelector('.hero h1')?.textContent==='DASH'");
    await wait("document.querySelector('#overview-total-runs')?.textContent === '0'");
    await js("document.fonts.ready.then(()=>true)");
    const capture = await window.webContents.capturePage();
    writeFileSync(path.join(temporary, "home.png"), capture.toPNG());
    await js("location.hash='new'");
    await wait("document.querySelector('#wf-fixture')");
    await js("document.querySelector('#wf-fixture').click()");
    await wait(
      "document.querySelector('#screen').innerText.includes('Mismatch in value')",
    );
    assert.equal(
      await js("document.querySelectorAll('a[href*=\"/0\"]').length>0"),
      true,
    );
    await js(
      "Array.from(document.querySelectorAll('a')).find(a=>a.textContent==='eps-gaap').click()",
    );
    await wait(
      "document.querySelector('h1')?.textContent==='eps-gaap' && document.body.innerText.includes('Held-out grading evidence')",
    );
    await js("Array.from(document.querySelectorAll('summary')).find(s=>s.textContent==='Held-out grading evidence').click()");
    await wait("document.body.innerText.includes('Expected response') && document.body.innerText.includes('0.74')");
    await js("document.querySelector('[data-act=rerun]').click()");
    await wait(
      "document.querySelector('#screen').innerText.includes('1 case per candidate')",
    );
    await js("location.hash='history'");
    await wait("document.querySelectorAll('.listrow').length===2");
    await js("location.hash='developer'");
    await wait("document.querySelector('h1')?.textContent==='Developer' && document.querySelector('.stack details summary')");
    await js("document.querySelector('.stack details summary').click()");
    await wait("document.body.innerText.includes('Mismatch in value')");
    assert.equal(
      await js("document.querySelectorAll('#developer-run option').length"),
      2,
    );
    await checkOverview(window, js, wait);
    console.log("Light/dark Overview previews: "+temporary);
    console.log(
      "Desktop smoke passed: home, new dataset run, failed EPS case, rerun and history. Screenshot: " +
        path.join(temporary, "home.png"),
    );
    app.exit(0);
  })
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });
