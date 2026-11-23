const { app } = require("electron");
const { mkdtempSync, writeFileSync } = require("node:fs");
const os = require("node:os"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const temporary = mkdtempSync(path.join(os.tmpdir(), "dash-desktop-smoke-"));
app.setPath("userData", temporary);
app.dock?.hide();
app.on("browser-window-created", (_event, win) => { win.show = () => {}; });
globalThis.fetch = async () => { throw Error("Offline replay test"); };
app
  .whenReady()
  .then(async () => {
    const window = await require("../desktop.cjs").openWindow();
    const js = (source) => window.webContents.executeJavaScript(source);
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
