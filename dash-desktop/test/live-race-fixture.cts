import assert from "node:assert/strict";
import {writeFileSync} from "node:fs";
import path = require("node:path");
import type {WebContents} from "electron";
import {z} from "zod";

export async function verifyLiveRace(wc:WebContents,ollamaModel:string,studioModel:string) {
  const inspect=(expression:string):Promise<unknown>=>wc.executeJavaScript(expression);
  const lanes=z.array(z.object({id:z.string(),state:z.string(),label:z.string(),count:z.string().nullable(),name:z.string(),clock:z.boolean()})).parse(
    await inspect(`Array.from(document.querySelectorAll(".candidate-race-lane"),lane=>({
      id:lane.dataset.racer,state:lane.dataset.state,label:lane.querySelector(".candidate-race-state span").textContent,
      count:lane.querySelector(".race-course").getAttribute("aria-valuenow"),name:lane.querySelector("strong").textContent,
      clock:!!lane.querySelector("dash-planning-elapsed")
    }))`));
  assert.deepEqual(lanes.map(l=>l.id).sort(),["lmstudio/"+studioModel,"ollama/"+ollamaModel]);
  for(const lane of lanes){
    assert.equal(lane.label,"Generating");assert.equal(lane.state,"active");assert.equal(lane.count,null);
    assert.ok(lane.name);assert.equal(lane.clock,true,"Each dispatched request owns an elapsed-time clock");
  }
  const samples=await inspect(`(()=>{
    const parse=html=>new DOMParser().parseFromString(html,"text/html");
    const c={id:"one",model:"lane-a",provider:"lmstudio"};
    const b={id:"two",model:"lane-b",provider:"ollama"};
    const fixture={manifest:{mode:"dataset",candidates:[c,b],caseIds:["a","b"]},results:[{candidateId:"one",caseId:"a",output:"saved"}],partial:{candidateId:"one",caseId:"b"},status:"running"};
    const lanes=(row)=>Array.from(parse(candidateRace(row)).querySelectorAll(".candidate-race-lane"),l=>[
      l.dataset.state,l.querySelector(".race-course").getAttribute("aria-valuenow"),l.querySelector(".candidate-race-state span").textContent
    ]);
    return [lanes(fixture),lanes({...fixture,partial:{candidateId:"one",caseId:"a",grading:{name:"Evidence",version:3}}}),
      lanes({...fixture,partial:null,status:"failed",results:[{candidateId:"one",caseId:"a",error:"synthetic"}]})];
  })()`);
  assert.deepEqual(samples,[
    [["active","1","Waiting for response"],["queued","0","Queued"]],
    [["active","1","Scoring · Evidence v3"],["queued","0","Queued"]],
    [["error","1","1 interrupted or failed case"],["stopped","0","Stopped"]]
  ]);
  const original=await inspect("document.documentElement.dataset.appearance");
  const skin=(theme:unknown)=>inspect("document.documentElement.dataset.appearance="+JSON.stringify(theme));
  const motion=(value:string)=>wc.debugger.sendCommand("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value}]});
  wc.debugger.attach("1.3");
  try {
    const pulse=()=>inspect(`(() => {
      const lane=document.querySelector('.candidate-race-lane[data-state=active]');
      const signal=lane.querySelector('.timing-signal');
      signal.getAnimations().forEach(animation=>animation.cancel());
      showGenerating(lane.dataset.racer);
      return signal.getAnimations().map(animation=>animation.effect.getTiming().iterations);
    })()`);
    await motion("reduce");assert.deepEqual(await pulse(),[]);
    await motion("no-preference");assert.deepEqual(await pulse(),[1]);
    const directory=process.env.DASH_RACE_PREVIEW_DIR;
    for (const [theme,width,height] of [["light",1180,820],["dark",1180,820],["light",390,844]] as const) {
      await skin(theme);
      await wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
      const clip=z.object({x:z.number(),y:z.number(),width:z.number(),height:z.number()}).parse(
        await inspect(`(async()=>{
          const panel=document.querySelector(".run-activity");
          panel.scrollIntoView({block:"center"});
          await new Promise(requestAnimationFrame);
          const r=panel.getBoundingClientRect();
          return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height};
        })()`));
      assert.ok(clip.width<=width && clip.width>275,"Evaluation lanes should fit the viewport");
      if (directory) {
        const shot=z.object({data:z.string()}).parse(await wc.debugger.sendCommand("Page.captureScreenshot",{format:"png",clip:{...clip,scale:1}}));
        writeFileSync(path.join(directory,"evaluation-race-"+theme+"-"+width+".png"),Buffer.from(shot.data,"base64"));
      }
    }
  } finally {
    await wc.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
    await wc.debugger.sendCommand("Emulation.setEmulatedMedia",{});
    wc.debugger.detach();
    await skin(original);
  }
}
