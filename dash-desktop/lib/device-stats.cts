import * as os from "node:os";
import { statfs } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { ProcessMetric } from "electron";
import { readPower, type PowerReading } from "./power.cjs";

export interface DeviceStats extends PowerReading {
  scope: "Whole device";
  cpu: { systemPercent: number | null; appPercent: number | null; logicalCores: number | null };
  memory: { totalBytes: number | null; freeBytes: number | null; appWorkingSetBytes: number | null };
  disk: { totalBytes: number | null; availableBytes: number | null; usedBytes: number | null };
}
interface AppProcess {
  pid: number;
  creationTime: number;
  cpu: Pick<ProcessMetric["cpu"], "cumulativeCPUUsage">;
  memory: Pick<ProcessMetric["memory"], "workingSetSize">;
}
interface DeviceSources {
  userData: string;
  getAppMetrics: () => AppProcess[];
  hostCpus?: () => Pick<os.CpuInfo, "times">[];
  totalMemory?: () => number;
  freeMemory?: () => number;
  readPower?: () => Promise<PowerReading>;
  filesystem?: (path: string) => Promise<{ blocks: bigint; bsize: bigint; bfree: bigint; bavail: bigint }>;
  clock?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}
type Ticks = { cores: number; total: number; idle: number };
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const bytes = (n: unknown): number | null => finite(n) && Number.isSafeInteger(n) ? n : null;
function read<T>(fn: () => T): T | null { try { return fn(); } catch { return null; } }

function hostTicks(cpus: Pick<os.CpuInfo,"times">[]): Ticks | null {
  if (!cpus.length) return null;
  let total = 0, idle = 0;
  for (const { times } of cpus) {
    const counters = [times.idle, times.user, times.sys, times.irq, times.nice];
    if (!counters.every(finite)) return null;
    idle += times.idle;
    total += counters.reduce((sum,n) => sum + n, 0);
  }
  return { cores:cpus.length, total, idle };
}
function hostPercent(a: Ticks | null, b: Ticks | null): number | null {
  if (!a || !b || a.cores !== b.cores) return null;
  const total = b.total - a.total, idle = b.idle - a.idle;
  return total > 0 && idle >= 0 && idle <= total ? 100 * (total - idle) / total : null;
}
function appPercent(previous: AppProcess[] | null, current: AppProcess[] | null, elapsedMs: number, cores: number | null): number | null {
  if (!previous?.length || !current || previous.length !== current.length || !cores || elapsedMs <= 0) return null;
  const identity = (p: AppProcess) => p.pid + "/" + p.creationTime;
  const before = new Map(previous.map(p => [identity(p), p.cpu?.cumulativeCPUUsage]));
  let seconds = 0;
  for (const p of current) {
    const start = before.get(identity(p)), end = p.cpu?.cumulativeCPUUsage;
    if (!finite(start) || !finite(end) || end < start) return null;
    seconds += end - start;
  }
  return Math.min(100, seconds * 100_000 / (elapsedMs * cores));
}
function workingSet(processes: AppProcess[] | null): number | null {
  if (!processes?.length) return null;
  let totalKiB = 0;
  for (const p of processes) {
    const kib = p.memory?.workingSetSize;
    if (!finite(kib)) return null;
    totalKiB += kib;
  }
  return totalKiB > 0 ? bytes(totalKiB * 1024) : null;
}
async function volume(sources: DeviceSources): Promise<DeviceStats["disk"]> {
  const unavailable = { totalBytes:null, availableBytes:null, usedBytes:null };
  try {
    const { blocks, bsize, bfree, bavail } = await (sources.filesystem ?? (p => statfs(p, { bigint:true })))(sources.userData);
    if (blocks <= 0n || bsize <= 0n || bfree < 0n || bfree > blocks || bavail < 0n || bavail > bfree) return unavailable;
    return { totalBytes:bytes(Number(blocks*bsize)), availableBytes:bytes(Number(bavail*bsize)), usedBytes:bytes(Number((blocks-bfree)*bsize)) };
  } catch { return unavailable; }
}

// A stalled volume/sensor must leave the other measurements available. Keep
// its operation in flight so subsequent requests cannot pile up native work.
function boundedSource<T>(source: () => Promise<T>, unavailable: T): () => Promise<T> {
  let active: Promise<T> | null = null;
  return () => {
    // Share the timed observation as well as the native work. After timeout it remains
    // resolved until the source settles, so repeated polls cannot retain more callbacks.
    active ??= new Promise<T>(resolve => {
      const timer = setTimeout(() => resolve(unavailable), 1500);
      const finish = (value:T) => {
        clearTimeout(timer);
        active = null;
        resolve(value);
      };
      void Promise.resolve().then(source).then(finish, () => finish(unavailable));
    });
    return active;
  };
}

export function createDeviceSampler(sources: DeviceSources): () => Promise<DeviceStats> {
  const now = sources.clock ?? (() => performance.now());
  const cpus = sources.hostCpus ?? os.cpus;
  const samplePower = boundedSource<PowerReading | null>(sources.readPower ?? readPower, null);
  const sampleVolume = boundedSource(() => volume(sources), { totalBytes:null, availableBytes:null, usedBytes:null });
  let cached: { at:number; data:DeviceStats } | null = null, pending: Promise<DeviceStats> | null = null;
  async function measure(): Promise<DeviceStats> {
    const power = samplePower();
    const storage = sampleVolume();
    const first = read(() => hostTicks(cpus())), before = read(sources.getAppMetrics), start = now();
    await (sources.wait ?? delay)(250);
    const last = read(() => hostTicks(cpus())), after = read(sources.getAppMetrics), elapsed = now() - start;
    const cores = last?.cores ?? null;
    const [sensor, disk] = await Promise.all([power, storage]);
    const total = bytes(read(sources.totalMemory ?? os.totalmem)), free = bytes(read(sources.freeMemory ?? os.freemem));
    return {
      scope:"Whole device", watts:sensor?.watts != null && finite(sensor.watts) ? sensor.watts : null,
      source:sensor?.source ?? null, at:sensor?.at ?? new Date().toISOString(),
      cpu:{ systemPercent:hostPercent(first,last), appPercent:appPercent(before,after,elapsed,cores), logicalCores:cores },
      memory:{ totalBytes:total !== null && total > 0 ? total : null, freeBytes:total !== null && free !== null && free > total ? null : free, appWorkingSetBytes:workingSet(after) },
      disk,
    };
  }
  // One active sample per desktop. Hover, keyboard focus and status refreshes
  // within two seconds share sensor work, without an always-running poller.
  return () => {
    if (pending) return pending;
    if (cached && now() - cached.at < 2000) return Promise.resolve(cached.data);
    pending = measure().then(data => { cached = { at:now(), data }; return data; }).finally(() => { pending = null; });
    return pending;
  };
}
