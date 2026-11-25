import assert from "node:assert/strict";
import {writeFileSync} from "node:fs";
import path = require("node:path");
import type {WebContents} from "electron";
import {z} from "zod";

export async function verifyLiveRace(wc:WebContents,streaming:string,saved:string) {
  const inspect=(expression:string):Promise<unknown>=>wc.executeJavaScript(expression);
  const lanes=z.array(z.object({id:z.string(),state:z.string(),label:z.string(),count:z.string().nullable(),name:z.string(),marker:z.string().nullable()})).parse(
    await inspect(`Array.from(document.querySelectorAll(".candidate-race-lane"),lane=>({
      id:lane.dataset.racer,state:lane.dataset.state,label:lane.querySelector(".candidate-race-state").textContent,
      count:lane.querySelector(".race-course").getAttribute("aria-valuenow"),name:lane.querySelector("strong").textContent,
      marker:lane.querySelector("use").getAttribute("href")
    }))`));
  assert.equal(lanes.length,2);
  const executing=lanes.find(l=>l.id==="ollama/"+streaming);
  const parked=lanes.find(l=>l.id==="lmstudio/"+saved);
  assert.ok(executing && parked);
  assert.equal(executing.label,"Generating");assert.equal(executing.state,"active");assert.equal(executing.count,null);
  assert.equal(parked.label,"Response saved");assert.equal(parked.state,"finished");assert.equal(parked.count,"1");
  assert.ok(lanes.every(l=>l.name.length>0 && l.marker==="#car"));
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
  const roadMotion=()=>inspect("getComputedStyle(document.querySelector('.candidate-race-lane[data-state=active] .race-asphalt'),'::before').animationName");
  wc.debugger.attach("1.3");
  try {
    await motion("reduce");assert.equal(await roadMotion(),"none");
    await motion("no-preference");assert.equal(await roadMotion(),"race-asphalt");
    assert.equal(await inspect("getComputedStyle(document.querySelector('.candidate-race-lane[data-state=finished] .race-asphalt'),'::before').animationName"),"none");
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
