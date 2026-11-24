import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {app,dialog} from "electron";
import {mock} from "node:test";

// Run the production entry against an unreadable synthetic SQLite profile.
const profile=mkdtempSync(join(tmpdir(),"dash-startup-smoke-"));
app.setPath("userData",profile);
app.dock?.hide();
writeFileSync(join(profile,"dash.sqlite"),"synthetic-private-marker");
const dialogs=mock.method(dialog,"showErrorBox",()=>{});
const deadline=setTimeout(()=>{console.error("DASH did not handle its failed startup.");app.exit(1);},15000);
app.once("before-quit",event=>{
  event.preventDefault();
  clearTimeout(deadline);
  try {
    assert.equal(dialogs.mock.callCount(),1);
    const [title,message]=dialogs.mock.calls[0].arguments;
    assert.equal(title,"DASH could not open the workbench");
    assert.ok(typeof message==="string");
    assert.match(message,/workspace database/);
    assert.doesNotMatch(message,/synthetic-private-marker/);
    console.log("Startup smoke passed: a corrupt synthetic profile surfaced a native recovery message.");
    app.exit(0);
  } catch(error) { console.error(error);app.exit(1); }
});
app.once("quit",()=>{try {rmSync(profile,{recursive:true,force:true});} catch { /* The OS can still own the profile on exit. */ }});
void import("../main.cjs").catch(error=>{console.error(error);app.exit(1);});
