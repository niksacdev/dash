import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const source = process.platform === "darwin" ? "AppleSmartBattery · PowerTelemetryData.SystemLoad" : null;

export interface PowerReading { watts: number | null; source: string | null; at: string }
interface Sample { ms: number; watts: number | null }
export interface PowerSummary {
  source: string | null;
  scope: "Whole device";
  interval_ms: number;
  samples: Sample[];
  average_w: number | null;
  peak_w: number | null;
  sampled_seconds: number;
  estimated_energy_j: number | null;
}
export function parseWatts(xml: string): number | null {
  const section = /<key>PowerTelemetryData<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(xml);
  const value = section && /<key>SystemLoad<\/key>\s*<integer>(\d+)<\/integer>/.exec(section[1]);
  const mw = value ? Number(value[1]) : null;
  return mw !== null && Number.isSafeInteger(mw) && mw > 0 && mw < 2000000 ? mw / 1000 : null;
}
export async function readPower(signal?:AbortSignal): Promise<PowerReading> {
  let watts: number | null = null;
  if (process.platform === "darwin") {
    try {
      const { stdout } = await exec("/usr/sbin/ioreg", ["-r","-n","AppleSmartBattery","-a"], { signal, timeout:1200, maxBuffer:2_000_000 });
      watts = parseWatts(stdout);
    } catch { /* Some Macs lack the whole-device sensor. */ }
  }
  return { watts, source, at: new Date().toISOString() };
}
export async function startPower(
  read: (signal?:AbortSignal) => Promise<Pick<PowerReading, "watts">> = readPower, interval = 1000,
  mode:"boundary"|"passive" = "boundary"
): Promise<() => Promise<PowerSummary>> {
  const samples: Sample[] = [];
  let pending: Promise<void> | null = null;
  const controller = new AbortController();
  const started = performance.now();
  async function sample(): Promise<void> {
    let watts: number | null = null;
    try { watts = (await read(controller.signal)).watts; } catch { /* Preserve a gap when a telemetry read fails. */ }
    if (!controller.signal.aborted) samples.push({ ms: Math.round(performance.now() - started), watts });
  }
  function tick() {
    if (!pending) pending = sample().finally(() => { pending = null; });
  }
  if (mode==="passive") tick(); else await sample();
  const timer = setInterval(tick, interval);
  timer.unref();
  return async () => {
    clearInterval(timer);
    if (mode==="passive") {
      // Planning uses only reads completed during this attempt. A fast reply never waits for a sensor.
      controller.abort();
    } else {
      if (pending) await pending;
      await sample();
    }
    let joules = 0, covered = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i-1], b = samples[i], dt = (b.ms - a.ms) / 1000;
      if (a.watts == null || b.watts == null || dt <= 0 || dt > 3) continue;
      joules += dt * (a.watts + b.watts) / 2;
      covered += dt;
    }
    const values = samples.map(s => s.watts).filter((w): w is number => w !== null && Number.isFinite(w));
    return { source, scope: "Whole device", interval_ms: interval, samples,
      average_w: covered ? joules / covered : (values.length === 1 ? values[0] : null),
      peak_w: values.length ? Math.max(...values) : null,
      sampled_seconds: covered, estimated_energy_j: covered ? joules : null };
  };
}
