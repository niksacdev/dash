import {app, BrowserWindow} from "electron";
import {once} from "node:events";
import {mkdtempSync, writeFileSync} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import {mock} from "node:test";
import {z} from "zod";
import power = require("../lib/power.cjs");
import deviceStats = require("../lib/device-stats.cjs");

type RendererEval = (source:string)=>Promise<unknown>;
const pointShape=z.object({x:z.number(),y:z.number()});
const sizeShape=z.object({width:z.number(),height:z.number()});
const rectShape=sizeShape.extend({left:z.number(),right:z.number(),top:z.number(),bottom:z.number()});
const temporary = mkdtempSync(path.join(os.tmpdir(), "dash-desktop-smoke-"));
app.setPath("userData", temporary);
app.dock?.hide();
app.on("browser-window-created", (_event, win) => { win.show = () => {}; });
globalThis.fetch = async () => { throw Error("Offline replay test"); };
mock.method(power,"readPower",async ():ReturnType<typeof power.readPower>=>({watts:null,source:"QA",at:new Date().toISOString()}));

const actualSampler = deviceStats.createDeviceSampler;
let detailedSamples = 0;
const countedSampler:typeof actualSampler = options => {
  const sample = actualSampler(options);
  return () => { detailedSamples++; return sample(); };
};
mock.method(deviceStats,"createDeviceSampler",countedSampler);
const delay = (ms:number) => new Promise(resolve => setTimeout(resolve, ms));

async function checkIpc(window:BrowserWindow) {
  const contents = window.webContents;
  assert.equal(await contents.executeJavaScript("typeof window.dash.invoke"), "undefined");
  assert.equal(await contents.executeJavaScript("typeof window.require"), "undefined");
  await assert.rejects(contents.executeJavaScript("window.dash.start({mode:'quick',candidateIds:[0,'other']})"), /Invalid run configuration/);
  await assert.rejects(contents.executeJavaScript("window.dash.power('all')"), /measurement scope/);
  const foreign = new BrowserWindow({show:false,webPreferences:{
    preload:path.join(__dirname,"../preload.cjs"),sandbox:true,contextIsolation:true,nodeIntegration:false
  }});
  try {
    await foreign.loadURL("about:blank");
    await assert.rejects(foreign.webContents.executeJavaScript("window.dash.list()"),/Invalid sender/);
  } finally { foreign.destroy(); }
}

async function checkLocalRuntime(js:RendererEval, wait:(source:string)=>Promise<void>) {
  const original=globalThis.fetch;
  const key="liquid/lfm3-smoke";
  let loaded=false,posts=0;
  globalThis.fetch=async (input,options)=>{
    const url=new URL(input instanceof Request ? input.url : input);
    if (url.href==="http://127.0.0.1:1234/api/v1/models") return Response.json({models:[
      {key,type:"llm",loaded_instances:loaded?[{id:"desk-worker",config:{context_length:2048}}]:[]}]});
    if (url.href==="http://127.0.0.1:1234/v1/models") return Response.json({data:[]});
    if (url.href==="http://127.0.0.1:11434/api/tags") return Response.json({models:[]});
    assert.equal(url.href,"http://127.0.0.1:1234/api/v1/models/load");
    assert.equal(options?.method,"POST");
    assert.deepEqual(JSON.parse(String(options.body)),{model:key});
    posts++;loaded=true;
    return Response.json({type:"llm",status:"loaded",instance_id:"desk-worker"});
  };
  try {
    await js("location.hash='providers'");
    await wait("document.querySelector('h1')?.textContent==='Local runtimes'");
    await js("document.querySelector('[data-act=refresh]').click()");
    await wait("document.querySelector('[data-act=load-local-model]')?.dataset.key==='liquid/lfm3-smoke'");
    await js("document.querySelector('[data-act=load-local-model]').click()");
    await wait("document.querySelector('#screen').textContent.includes('desk-worker') && !document.querySelector('[data-act=load-local-model]')");
    assert.equal(posts,1);
  } finally {
    globalThis.fetch=original;
    await js("window.dash.refresh()");
  }
}

async function waitForSamples(minimum:number) {
  for (let i=0;i<100;i++) {
    if (detailedSamples>=minimum) return;
    await delay(100);
  }
  assert.fail("Device details did not request a new measurement.");
}

async function checkOverview(window:BrowserWindow, js:RendererEval, wait:(source:string)=>Promise<void>) {
  const client = window.webContents.debugger;
  client.attach();
  const send = (method:string, args:Record<string,unknown>):Promise<unknown> => client.sendCommand(method, args);
  const point = async (selector:string) => pointShape.parse(await js(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return {x: r.x + r.width / 2, y: r.y + r.height / 2};
  })()`));
  const key = async (name:string, code:number) => {
    for (const type of ["keyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {type, key:name, code:name, windowsVirtualKeyCode:code});
  };
  const screenshot = async (name:string) => {
    const {data}=z.object({data:z.string().min(1)}).parse(await send("Page.captureScreenshot",{format:"png"}));
    writeFileSync(path.join(temporary, name), Buffer.from(data, "base64"));
  };
  const selectTheme = (value:"light"|"dark") =>
    js(`document.querySelector('#appearance input[value="${value}"]').closest('label').click()`);
  const themeIs = (value:"light"|"dark") =>
    `document.documentElement.dataset.appearance === "${value}" &&
     document.querySelector('#appearance input[value="${value}"]').checked &&
     getComputedStyle(document.documentElement).colorScheme === "${value}"`;
  async function checkControlColors() {
    const colors = await js(`(() => {
      const fill = element => getComputedStyle(element).backgroundColor;
      return {
        action: fill(document.querySelector('.header-actions .button')),
        readout: fill(document.querySelector('.device-stat')),
        selected: fill(document.querySelector('#appearance input:checked + span')),
        idle: fill(document.querySelector('#appearance input:not(:checked) + span')),
        carousel: Array.from(document.querySelectorAll('[data-carousel]'), fill),
      };
    })()`);
    const palette = z.object({action:z.string(), readout:z.string(), selected:z.string(), idle:z.string(), carousel:z.array(z.string()).length(3)}).parse(colors);
    assert.equal(palette.action, "rgb(255, 207, 0)");
    assert.notEqual(palette.selected, palette.idle, "The selected theme has a distinct surface");
    for (const fill of [palette.readout, palette.selected, palette.idle, ...palette.carousel])
      assert.notEqual(fill, palette.action, "Presentation controls have a separate style from New run");
  }
  const open = "document.querySelector('#device-details').matches(':popover-open')";

  try {
    await send("Emulation.setDeviceMetricsOverride", {width:1310, height:850, deviceScaleFactor:1, mobile:false});
    await js("location.hash='home'");
    await wait("document.querySelector('#overview-total-runs')?.textContent === '2'");
    await wait(themeIs("light"));
    assert.equal(window.getTitle(), "DASH — Domain Assessment & Scoring Harness");
    assert.equal(await js("Promise.all(Array.from(document.querySelectorAll('.dash-emblem, .brand img'), img => img.decode())).then(() => document.querySelectorAll('.dash-emblem, .brand img').length)"), 2);


    assert.equal(await js("document.querySelector('.capability-reel').dataset.visual"), "industries");
    assert.equal(await js("document.querySelector('.industry-view h2').textContent"), "Run domain-specific use cases");
    await send("Emulation.setEmulatedMedia", {features:[{name:"prefers-reduced-motion",value:"reduce"}]});
    await checkControlColors();
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
    await checkControlColors();
    await screenshot("overview-dark.png");

    assert.equal(detailedSamples,0,"Idle Overview must only request the lightweight power reading");
    const device = await point(".device-stat");
    await send("Input.dispatchMouseEvent", {type:"mouseMoved", ...device});
    await wait(open);
    await waitForSamples(1);
    await wait("Array.from(document.querySelectorAll('#device-details dt')).some(n=>n.textContent==='Data volume' && n.nextElementSibling.textContent.includes('GiB'))");
    await send("Input.dispatchMouseEvent", {type:"mouseMoved",x:5,y:5});
    await wait("!" + open);
    await send("Emulation.setFocusEmulationEnabled", {enabled:true});
    await js("document.querySelector('[data-carousel=next]').focus()");
    const beforeFocus=detailedSamples;
    await key("Tab",9);
    await wait("document.activeElement.matches('.device-stat') && " + open);
    await waitForSamples(beforeFocus+1);
    await key("Escape",27);
    await wait("!" + open);

    await send("Emulation.setDeviceMetricsOverride", {width:390, height:844, deviceScaleFactor:1, mobile:false});
    await send("Emulation.setTouchEmulationEnabled", {enabled:true,maxTouchPoints:1});
    await wait("innerWidth === 390");
    const bounds = await js(`(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const hero = rect('.hero'), controls = rect('#appearance'), count = rect('#overview-total-runs');
      return {overflow:document.documentElement.scrollWidth - document.documentElement.clientWidth,
        left: hero.left - rect('aside').right, top: hero.top - rect('header').bottom,
        controlsFit:controls.left >= hero.left && controls.right <= innerWidth, countFits:count.right <= innerWidth};
    })()`);
    assert.deepEqual(bounds,{overflow:0,left:0,top:0,controlsFit:true,countFits:true});
    await js("document.activeElement.blur()");
    const tap = async (position:z.infer<typeof pointShape>) => {
      await send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[position]});
      await send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    };
    const beforeTap=detailedSamples;
    await tap(await point(".device-stat"));
    await wait(open);
    const popup = rectShape.parse(await js("document.querySelector('#device-details').getBoundingClientRect().toJSON()"));
    const viewport = sizeShape.parse(await js("({width:innerWidth,height:innerHeight})"));
    assert.ok(popup.width > 0 && popup.left >= 0 && popup.right <= viewport.width &&
      popup.top >= 0 && popup.bottom <= viewport.height, "Device popover outside viewport: "+JSON.stringify({popup,viewport}));
    await waitForSamples(beforeTap+2);
    await tap(await point(".hero h1"));
    await wait("!" + open);
    const closedSamples=detailedSamples;
    await delay(3700);
    assert.equal(detailedSamples,closedSamples,"Detailed sampling must stop when the popover closes");
    await selectTheme("light");
    await wait(themeIs("light"));
  } finally {
    client.detach();
  }
}
app
  .whenReady()
  .then(async () => {
    const window = await (await import("../desktop.cjs")).openWindow();
    const js:RendererEval = async source => {
      try { return await window.webContents.executeJavaScript(source); }
      catch (error) { throw new Error("Renderer assertion failed: " + source, {cause:error}); }
    };
    const wait = async (check:string) => {
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
    await checkIpc(window);
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
    await checkLocalRuntime(js,wait);
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
