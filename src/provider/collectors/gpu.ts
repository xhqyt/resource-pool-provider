import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { GpuInfo, GpuMetric } from '../../shared/protocol.js';

const run = promisify(exec);

const QUERY = 'index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu';

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

/** nvidia-smi 采集；无 NVIDIA GPU 返回空 */
export async function queryGpus(): Promise<{ info: GpuInfo[]; metrics: GpuMetric[] }> {
  try {
    const { stdout } = await run(`nvidia-smi --query-gpu=${QUERY} --format=csv,noheader,nounits`, {
      timeout: 5000,
      windowsHide: true,
    });
    const info: GpuInfo[] = [];
    const metrics: GpuMetric[] = [];
    for (const line of stdout.trim().split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [index, name, total, used, free, util, temp] = line.split(',').map((s) => s.trim());
      if (index === undefined || name === undefined) continue;
      info.push({ index: num(index), name, totalMb: num(total) });
      metrics.push({ index: num(index), usedMb: num(used), freeMb: num(free), utilPct: num(util), tempC: num(temp) });
    }
    return { info, metrics };
  } catch {
    return { info: [], metrics: [] };
  }
}
