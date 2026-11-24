import { test } from "node:test";
import assert = require("node:assert/strict");
import { createDeviceSampler } from "../lib/device-stats.cjs";

function fake(overrides: Partial<Parameters<typeof createDeviceSampler>[0]> = {}) {
  let t = 0, queries = 0;
  const process = (pid: number, cpu: number) => ({pid, creationTime:pid, cpu:{cumulativeCPUUsage:cpu}, memory:{workingSetSize:100}});
  const sample = createDeviceSampler({
    userData:"/synthetic/profile", clock:()=>t, wait:async ms=>{t+=ms;},
    hostCpus:()=>[1,2].map(()=>({times:{idle:t*0.75,user:t*0.25,sys:0,irq:0,nice:0}})),
    getAppMetrics:()=>[process(1,t/4000),process(2,t/4000)], totalMemory:()=>8192, freeMemory:()=>4096,
    readPower:async()=>{queries++;return {watts:12.5,source:"test sensor",at:"2026-01-01T00:00:00.000Z"};},
    filesystem:async path=>{assert.equal(path,"/synthetic/profile");return {blocks:100n,bsize:1024n,bfree:40n,bavail:35n};},
    ...overrides,
  });
  return {sample,queries:()=>queries,advance:(ms: number)=>{t+=ms;}};
}

test("reports host CPU and total-machine app CPU, aggregate working sets and profile volume availability", async () => {
  const f=fake();
  const [s, concurrent]=await Promise.all([f.sample(),f.sample()]);
  assert.equal(s,concurrent);
  assert.deepEqual(s.cpu,{systemPercent:25,appPercent:25,logicalCores:2});
  assert.deepEqual(s.memory,{totalBytes:8192,freeBytes:4096,appWorkingSetBytes:204800});
  assert.deepEqual(s.disk,{totalBytes:102400,availableBytes:35840,usedBytes:61440});
  assert.equal(s.watts,12.5);
  assert.equal(s.scope,"Whole device");
  assert.equal(s.source,"test sensor");
  assert.equal(s.at,"2026-01-01T00:00:00.000Z");
  assert.equal((await f.sample()),s);
  assert.equal(f.queries(),1);
  f.advance(2010);
  await f.sample();
  assert.equal(f.queries(),2);
});

test("failed sensors and volume information stay missing independently", async () => {
  const fails=()=>{throw Error("unsupported")};
  const {sample}=fake({readPower:fails,filesystem:fails,getAppMetrics:fails,freeMemory:fails});
  const s=await sample();
  assert.equal(s.watts,null);
  assert.equal(s.source,null);
  assert.equal(s.cpu.appPercent,null);
  assert.equal(s.cpu.systemPercent,25);
  assert.deepEqual(s.memory,{totalBytes:8192,freeBytes:null,appWorkingSetBytes:null});
  assert.deepEqual(s.disk,{totalBytes:null,usedBytes:null,availableBytes:null});
});

test("a process restart or missing cumulative counters leaves only app CPU unknown", async () => {
  let creation=0;
  const read=()=>[{pid:42,creationTime:++creation,cpu:{cumulativeCPUUsage:2},memory:{workingSetSize:20}}];
  for(const getAppMetrics of [read,()=>[{pid:42,creationTime:1,cpu:{},memory:{workingSetSize:20}}]]){
    const s=await fake({getAppMetrics}).sample();
    assert.equal(s.cpu.appPercent,null);
    assert.equal(s.cpu.systemPercent,25);
    assert.equal(s.memory.appWorkingSetBytes,20480);
  }
});

test("a stalled native measurement shares its timeout and recovers when the operation settles", async () => {
  let starts=0;
  let unblock:()=>void=()=>{throw Error("Native read has not started");};
  const volume={blocks:10n,bsize:1n,bfree:2n,bavail:2n};
  const f=fake({filesystem:async()=>{
    if (++starts===1) await new Promise<void>(resolve=>{unblock=resolve;});
    return volume;
  }});
  const first=await f.sample();
  assert.equal(first.disk.totalBytes,null);
  assert.equal(first.watts,12.5);
  assert.equal(first.cpu.systemPercent,25);
  for (let i=0;i<8;i++) {
    f.advance(3000);
    const sample=await Promise.race([f.sample(),new Promise<null>(resolve=>setImmediate(()=>resolve(null)))]);
    assert.ok(sample,"Subsequent polls reuse the expired deadline without adding another timer or waiting for the native read");
    assert.equal(sample.disk.totalBytes,null);
  }
  assert.equal(starts,1);
  unblock();
  await new Promise<void>(resolve=>setImmediate(resolve));
  f.advance(3000);
  assert.equal((await f.sample()).disk.totalBytes,10);
  assert.equal(starts,2);
});
