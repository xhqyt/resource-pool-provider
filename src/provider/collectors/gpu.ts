import { exec } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type { GpuInfo, GpuMetric } from '../../shared/protocol.js';

const run = promisify(exec);

const QUERY = 'index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,power.draw,power.limit';

function num(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 每卡利用率滚动窗口（60s @ 5s 采样 = 12 点），用于平滑瞬时抖动 */
const utilWindow = new Map<number, number[]>();
const UTIL_WINDOW_SIZE = 12;

function rollingAvg(index: number, utilPct: number): number {
  const buf = utilWindow.get(index) ?? [];
  buf.push(utilPct);
  if (buf.length > UTIL_WINDOW_SIZE) buf.splice(0, buf.length - UTIL_WINDOW_SIZE);
  utilWindow.set(index, buf);
  return Math.round(buf.reduce((a, b) => a + b, 0) / buf.length);
}

/** 功耗滚动窗口（60s @ 5s = 12 点） */
const powerWindow = new Map<number, number[]>();

function powerAvg(index: number, w: number): number {
  const buf = powerWindow.get(index) ?? [];
  buf.push(w);
  if (buf.length > UTIL_WINDOW_SIZE) buf.splice(0, buf.length - UTIL_WINDOW_SIZE);
  powerWindow.set(index, buf);
  return Math.round((buf.reduce((a, b) => a + b, 0) / buf.length) * 10) / 10;
}

/** 解析 nvidia-smi 数值字段（支持 [N/A]） */
function numOrUndef(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const s = v.replace(/\[.*?\]/g, '').trim();
  if (!s || s === 'N/A' || s === 'Not Supported') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * nvidia-smi 采集；无 NVIDIA GPU 返回空。
 * 统一内存设备（GB10/DGX Spark）：nvidia-smi 的显存字段为 [N/A]，
 * 用系统内存池近似（UMA 上 GPU 显存与系统内存本就是同一物理池）。
 */
export interface GpuProcess {
  pid: number;
  name: string;
  memMb: number;
}

/** 查询 GPU 上的进程及显存占用（用于 standby 判定） */
export async function queryGpuProcesses(): Promise<GpuProcess[]> {
  try {
    const { stdout } = await run(
      'nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits',
      { timeout: 5000, windowsHide: true },
    );
    const procs: GpuProcess[] = [];
    for (const line of stdout.trim().split('\n')) {
      const [pid, name, mem] = line.split(',').map((x) => x.trim());
      if (!pid || !name) continue;
      procs.push({ pid: Number(pid) || 0, name: name.split('/').pop() || name, memMb: Number(mem) || 0 });
    }
    return procs;
  } catch {
    return [];
  }
}

export async function queryGpus(): Promise<{ info: GpuInfo[]; metrics: GpuMetric[]; umaFallback?: boolean }> {
  try {
    const { stdout } = await run(`nvidia-smi --query-gpu=${QUERY} --format=csv,noheader,nounits`, {
      timeout: 5000,
      windowsHide: true,
    });
    const info: GpuInfo[] = [];
    const metrics: GpuMetric[] = [];
    let umaFallback = false;
    const sysTotalMb = Math.round(os.totalmem() / 1024 / 1024);
    const sysFreeMb = Math.round(os.freemem() / 1024 / 1024);
    for (const line of stdout.trim().split(String.fromCharCode(10))) {
      if (!line.trim()) continue;
      const [index, name, total, used, free, util, temp, powerDraw, powerLimit] = line.split(',').map((s) => s.trim());
      if (index === undefined || name === undefined) continue;
      const idx = num(index);
      const utilPct = num(util);
      // GB10 等统一内存设备：显存字段 N/A → 以系统内存池近似
      const na = (v?: string) => !v || v.includes('N/A') || v.includes('not supported');
      const pDraw = numOrUndef(powerDraw);
      const pLimit = numOrUndef(powerLimit);
      if (na(total) || num(total) === 0) {
        umaFallback = true;
        info.push({ index: idx, name, totalMb: sysTotalMb });
        metrics.push({
          index: idx,
          usedMb: sysTotalMb - sysFreeMb,
          freeMb: sysFreeMb,
          utilPct,
          utilAvgPct: rollingAvg(idx, utilPct),
          tempC: num(temp),
          powerW: pDraw,
          powerLimitW: pLimit,
          powerAvgW: pDraw !== undefined ? powerAvg(idx, pDraw) : undefined,
        });
        continue;
      }
      info.push({ index: idx, name, totalMb: num(total) });
      metrics.push({
        index: idx,
        usedMb: num(used),
        freeMb: num(free),
        utilPct,
        utilAvgPct: rollingAvg(idx, utilPct),
        tempC: num(temp),
        powerW: pDraw,
        powerLimitW: pLimit,
        powerAvgW: pDraw !== undefined ? powerAvg(idx, pDraw) : undefined,
      });
    }
    return { info, metrics, umaFallback };
  } catch {
    return { info: [], metrics: [] };
  }
}
