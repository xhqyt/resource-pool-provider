import os from 'node:os';

/**
 * CPU 利用率：对比两次 os.cpus() 快照的计算时间差
 * 返回 0-100 的百分比（所有核心平均）
 */
let prev: { idle: number; total: number } | null = null;

export function cpuMetric(): { cpuPct: number } {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.idle + c.times.user + c.times.nice + c.times.sys + c.times.irq;
  }
  if (prev) {
    const dIdle = idle - prev.idle;
    const dTotal = total - prev.total;
    if (dTotal > 0) {
      prev = { idle, total };
      return { cpuPct: Math.round((1 - dIdle / dTotal) * 100) };
    }
  }
  prev = { idle, total };
  return { cpuPct: 0 };
}
