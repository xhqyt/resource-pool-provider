import { promises as fsp } from 'node:fs';
import type { DiskMetric } from '../../shared/protocol.js';

/** 解析 /proc/mounts：仅保留真实数据盘（排除伪文件系统/引导分区/snap/容器叠加层） */
export function parseMounts(content: string): string[] {
  const REAL_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'ntfs', 'ntfs3', 'vfat', 'exfat', 'f2fs', 'apfs', 'fuseblk']);
  const out: string[] = [];
  for (const line of content.split('\n')) {
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const [dev, mount, fstype] = parts;
    if (!dev || !mount) continue;
    if (!dev.startsWith('/dev/')) continue; // 排除 proc/sys/cgroup/tmpfs/overlay 等
    if (!REAL_FS.has(fstype)) continue;
    if (mount.startsWith('/boot') || mount.startsWith('/snap/')) continue;
    out.push(mount);
  }
  return [...new Set(out)];
}

/** 自动发现本机全部真实挂载盘：Linux 读 /proc/mounts；Windows 探测盘符 */
export async function discoverDiskPaths(): Promise<string[]> {
  if (process.platform === 'win32') {
    const out: string[] = [];
    for (let i = 67; i <= 90; i++) { // C..Z
      const letter = String.fromCharCode(i) + ':\\';
      try {
        await fsp.statfs(letter);
        out.push(letter);
      } catch {
        /* 盘符不存在 */
      }
    }
    return out;
  }
  try {
    const mounts = await fsp.readFile('/proc/mounts', 'utf8');
    return parseMounts(mounts);
  } catch {
    return ['/'];
  }
}

/** 上报磁盘 = 自动发现的全部挂载盘 + 配置额外路径（去重，按发现顺序） */
export async function diskMetricsAuto(extraPaths: string[] = []): Promise<DiskMetric[]> {
  const discovered = await discoverDiskPaths();
  const all = [...new Set([...discovered, ...extraPaths.filter(Boolean)])];
  return diskMetrics(all);
}

export async function diskMetrics(paths: string[]): Promise<DiskMetric[]> {
  const out: DiskMetric[] = [];
  for (const p of paths) {
    try {
      const st = (await fsp.statfs(p)) as { blocks: number | bigint; bsize: number | bigint; bavail: number | bigint };
      const total = Number(st.blocks) * Number(st.bsize);
      const free = Number(st.bavail) * Number(st.bsize);
      out.push({ path: p, totalGb: round1(total / 1024 ** 3), freeGb: round1(free / 1024 ** 3) });
    } catch (err) {
      out.push({ path: p, totalGb: 0, freeGb: 0, error: String(err) });
    }
  }
  return out;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
