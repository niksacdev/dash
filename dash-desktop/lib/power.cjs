const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const source = process.platform === "darwin" ? "AppleSmartBattery · PowerTelemetryData.SystemLoad" : null;
function parseWatts(xml) {
  const section = /<key>PowerTelemetryData<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(xml);
  const value = section && /<key>SystemLoad<\/key>\s*<integer>(\d+)<\/integer>/.exec(section[1]);
  const mw = value ? Number(value[1]) : null;
  return Number.isSafeInteger(mw) && mw > 0 && mw < 2000000 ? mw/1000 : null;
}
async function readPower() {
  let watts = null;
  if(process.platform==="darwin") {
    try {
      const {stdout} = await exec("/usr/sbin/ioreg",["-r","-n","AppleSmartBattery","-a"],
        {timeout:1200,maxBuffer:2_000_000});
      watts=parseWatts(stdout);
    } catch { /* A Mac may lack this sensor. */ }
  }
  return {watts, source, at:new Date().toISOString()};
}
async function startPower(read=readPower, interval=1000) {
  const samples=[];
  let timer, pending;
  const started=performance.now();
  const sample=async()=>{
    const reading=await read();
    samples.push({ms:Math.round(performance.now()-started),watts:reading.watts});
  };
  await sample();
  timer=setInterval(()=>{
    if(!pending)pending=sample().finally(()=>{pending=null;});
  },interval);
  timer.unref();
  return async()=>{
    clearInterval(timer);
    if(pending)await pending;
    await sample();
    let joules=0, covered=0;
    for(let i=1;i<samples.length;i++){
      const a=samples[i-1], b=samples[i], dt=(b.ms-a.ms)/1000;
      if(a.watts==null || b.watts==null || dt<=0 || dt>3)continue;
      joules+=dt*(a.watts+b.watts)/2;
      covered+=dt;
    }
    const values=samples.map(s=>s.watts).filter(Number.isFinite);
    return {source,scope:"Whole device",interval_ms:interval,samples,
      average_w:covered?joules/covered:(values.length===1?values[0]:null),
      peak_w:values.length?Math.max(...values):null,
      sampled_seconds:covered,estimated_energy_j:covered?joules:null};
  };
}
module.exports={readPower, startPower, parseWatts};
