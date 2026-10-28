import fs from 'node:fs';
import path from 'node:path';
import type { ProviderConfig } from '../shared/protocol.js';
import { consoleUrlFromBase, decodeEnroll } from '../shared/enroll.js';

/**
 * 供给端配置：环境变量 > provider.config.json > 默认值。
 * 支持一键引导：`npx tsx src/provider/index.ts --enroll rce_xxx`
 * （引导串内嵌云端地址与供给凭证，首次运行自动写入 provider.config.json）
 */
export function loadConfig(): ProviderConfig {
  // 1. 引导串优先：解码成功即落盘（幂等：已写入的配置与引导串一致时跳过）
  const enrollArg = process.argv.find((a) => a.startsWith('rce_'));
  if (enrollArg) {
    const payload = decodeEnroll(enrollArg);
    if (!payload) {
      console.error('[provider] --enroll 引导串无效（应为 rce_ 开头的完整串）');
      process.exit(2);
    }
    const configPath = path.resolve(process.cwd(), 'provider.config.json');
    const desired = {
      consoleUrl: consoleUrlFromBase(payload.c),
      token: payload.k,
      intervalMs: 5000,
      tunneled: false,
      ssh: { host: '127.0.0.1', port: 22, user: process.platform === 'win32' ? process.env.USERNAME ?? 'user' : 'root' },
      _说明: '由 enroll 引导串自动生成；tunneled=true 可切换为内网穿透模式（见 README）',
    };
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      /* 无既有配置 */
    }
    if (existing.consoleUrl !== desired.consoleUrl || existing.token !== desired.token) {
      fs.writeFileSync(configPath, JSON.stringify({ ...existing, ...desired }, null, 2), 'utf8');
      console.log('[provider] 已通过引导串完成配置（provider.config.json）');
    }
    // 安装脚本模式：仅写配置即退出
    if (process.argv.includes('--print-config')) {
      console.log(`[provider] 配置目标: ${desired.consoleUrl}`);
      process.exit(0);
    }
  }

  let file: Partial<ProviderConfig> = {};
  const file_ = path.resolve(process.cwd(), 'provider.config.json');
  if (fs.existsSync(file_)) {
    try {
      file = JSON.parse(fs.readFileSync(file_, 'utf8')) as Partial<ProviderConfig>;
    } catch (err) {
      console.error('[provider] provider.config.json 解析失败，使用默认配置:', err);
    }
  }
  try {
    process.loadEnvFile(path.resolve(process.cwd(), '.env'));
  } catch {
    /* 无 .env 忽略 */
  }
  const cwdRoot = path.parse(process.cwd()).root;
  const isWin = process.platform === 'win32';
  return {
    consoleUrl: process.env.CONSOLE_URL ?? file.consoleUrl ?? 'ws://127.0.0.1:7000/ws/server',
    token: process.env.AGENT_TOKEN ?? file.token,
    serverId: process.env.SERVER_ID ?? file.serverId ?? undefined,
    intervalMs: Number(process.env.METRICS_INTERVAL_MS ?? file.intervalMs ?? 5000),
    diskPaths: file.diskPaths?.length ? file.diskPaths : [cwdRoot],
    tunneled: process.env.TUNNELED === 'true' || process.env.TUNNELED === '1' || file.tunneled === true,
    cleanup: process.env.CLEANUP ?? file.cleanup ?? 'retain',
    ssh: {
      host: process.env.ADVERTISE_HOST ?? file.ssh?.host ?? '127.0.0.1',
      port: Number(process.env.ADVERTISE_PORT ?? file.ssh?.port ?? 22),
      user: process.env.ADVERTISE_USER ?? file.ssh?.user ?? (isWin ? process.env.USERNAME ?? 'user' : 'root'),
    },
  };
}
