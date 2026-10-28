import os from 'node:os';
import type { ServerStaticInfo } from '../shared/protocol.js';

export type DirectAddr = ServerStaticInfo['direct'][number];

/** RFC1918 私网 + 常见内网段 */
function isPrivateV4(ip: string): boolean {
  return (
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

/** 全局单播 IPv6（排除回环/链路本地/组播） */
function isGlobalV6(ip: string): boolean {
  if (!ip.includes(':')) return false;
  const low = ip.toLowerCase();
  if (low === '::1' || low.startsWith('fe80') || low.startsWith('ff') || low.startsWith('::')) return false;
  return true;
}

/** 从网络接口与配置收集直连候选地址（lan → ipv6 → public 排序，去重） */
export function collectDirectAddresses(configured?: { host?: string; port: number }): DirectAddr[] {
  const port = configured?.port ?? 22;
  const lan = new Set<string>();
  const ipv6 = new Set<string>();
  const publicV4 = new Set<string>();

  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.internal) continue;
      if (ni.family === 'IPv4') {
        if (isPrivateV4(ni.address)) lan.add(ni.address);
        else publicV4.add(ni.address);
      } else if (ni.family === 'IPv6' && isGlobalV6(ni.address)) {
        ipv6.add(ni.address);
      }
    }
  }

  // 配置声明的 advertise 地址视为 public（手动权威）
  const cfgHost = configured?.host?.trim();
  if (cfgHost && cfgHost !== '127.0.0.1' && cfgHost !== 'localhost') {
    if (cfgHost.includes(':')) ipv6.add(cfgHost);
    else if (isPrivateV4(cfgHost)) lan.add(cfgHost);
    else publicV4.add(cfgHost);
  }

  const out: DirectAddr[] = [];
  for (const host of lan) out.push({ host, port, kind: 'lan' });
  for (const host of ipv6) out.push({ host, port, kind: 'ipv6' });
  for (const host of publicV4) out.push({ host, port, kind: 'public' });
  return out;
}
