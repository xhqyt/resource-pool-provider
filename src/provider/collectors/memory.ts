import os from 'node:os';

export function memoryMetric(): { memTotalMb: number; memFreeMb: number } {
  return {
    memTotalMb: Math.round(os.totalmem() / 1024 / 1024),
    memFreeMb: Math.round(os.freemem() / 1024 / 1024),
  };
}
