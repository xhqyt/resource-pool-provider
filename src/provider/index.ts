import os from 'node:os';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { CloudCommand, ProviderConfig, ServerMetrics, ServerStaticInfo, ServerMessage } from '../shared/protocol.js';
import { PROVIDER_VERSION } from '../shared/protocol.js';
import { loadConfig } from './config.js';
import { queryGpus } from './collectors/gpu.js';
import { memoryMetric } from './collectors/memory.js';
import { diskMetricsAuto } from './collectors/disk.js';
import { SshGovernor } from './sshd.js';
import { TunnelBridge } from './tunnel.js';
import { collectDirectAddresses } from './addresses.js';

/**
 * 供给端守护进程（数据面）：
 * - L1 控制通道：向云端注册供给与 SSH 直连信息、心跳资源指标
 * - 本地 SSH 治理：sshd CA 信任、principal 全集对账（声明式）、自愈清理、分配残留清理
 * - 内网穿透：云端中继隧道 ↔ 本机 sshd 字节级桥接（SSH 自身端到端加密）
 * - 不执行调度、不接触任务数据：任务由需求方经 SSH 交付
 */
class Provider {
  private readonly config: ProviderConfig;
  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectDelay = 1000;
  private metricsTimer?: NodeJS.Timeout;
  private gpuInfo: Awaited<ReturnType<typeof queryGpus>>['info'] = [];
  private readonly governor: SshGovernor;
  private tunnel: TunnelBridge | null = null;

  constructor() {
    this.config = loadConfig();
    this.governor = new SshGovernor('data');
  }

  async start(): Promise<void> {
    this.gpuInfo = (await queryGpus()).info;
    console.log(`[provider] 供给节点 ${this.serverId()} 启动 → ${this.config.consoleUrl}`);
    console.log(`[provider] GPU: ${this.gpuInfo.length ? this.gpuInfo.map((g) => g.name).join(', ') : '未检测到 NVIDIA GPU'}`);
    if (this.config.tunneled) {
      console.log(`[provider] 内网模式(tunneled)：需求方经云端中继隧道访问本机 sshd（端口 ${this.config.ssh.port}）`);
    } else {
      console.log(`[provider] SSH 直连信息(advertise): ${this.config.ssh.user}@${this.config.ssh.host}:${this.config.ssh.port}`);
    }
    this.governor.startSelfHeal();
    this.connect();
  }

  private serverId(): string {
    return this.config.serverId ?? os.hostname();
  }

  private connect(): void {
    const url = new URL(this.config.consoleUrl);
    if (this.config.token) url.searchParams.set('token', this.config.token);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url.toString());
    } catch (err) {
      console.error('[provider] WebSocket 创建失败:', String(err));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      this.tunnel = new TunnelBridge((msg) => this.send(msg));
      console.log('[provider] 已连接云端调度');
      this.send({
        type: 'register',
        info: this.staticInfo(),
      });
      if (!this.metricsTimer) {
        this.metricsTimer = setInterval(() => void this.reportMetrics(), this.config.intervalMs);
      }
      void this.reportMetrics();
    });

    ws.addEventListener('message', (ev) => {
      let cmd: CloudCommand;
      try {
        cmd = JSON.parse(String(ev.data)) as CloudCommand;
      } catch {
        return;
      }
      // 隧道数据走快速路径（高频小帧）
      if (cmd.type === 'tunnel-data' || cmd.type === 'tunnel-open' || cmd.type === 'tunnel-close') {
        this.tunnel?.handleCommand(cmd);
        return;
      }
      void this.handleCommand(cmd);
    });

    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.tunnel?.closeAll('l1-disconnected');
      this.tunnel = null;
      if (ev.code === 4001) {
        console.error('[provider] 云端拒绝连接：注册凭证已失效或被吊销（检查 token / 联系管理员）');
      } else if (ev.code === 4003) {
        console.error('[provider] 云端关闭连接：' + (ev.reason || '凭证被禁用/超出注册上限'));
      } else {
        console.log('[provider] 与云端断开，等待重连（SSH 凭证治理与自愈继续本地运行）...');
      }
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      /* close 统一处理 */
    });
  }

  private async handleCommand(cmd: CloudCommand): Promise<void> {
    switch (cmd.type) {
      case 'config-ca':
        await this.governor.configureCa(cmd.caPublicKey);
        break;
      case 'principal-sync': {
        const { removed, added } = this.governor.syncPrincipals(cmd.principals);
        if (removed || added) {
          console.log(`[provider] principal 对账: +${added} / -${removed}（当前 ${cmd.principals.length} 条）`);
        }
        break;
      }
      case 'cleanup-allocation':
        await this.governor.cleanupAllocation(cmd);
        break;
      case 'update-provider':
        this.startUpdate(cmd);
        break;
    }
  }

  /**
   * 云端触发的软件自更新：分离进程运行 deploy/update.sh
   * （git pull → npm install → 重启服务），本进程随后被重启/退出。
   */
  private startUpdate(cmd: Extract<CloudCommand, { type: 'update-provider' }>): void {
    const repoDir = process.cwd();
    const script = `${repoDir}/deploy/update.sh`;
    if (!fs.existsSync(script)) {
      console.warn('[provider] 更新失败：deploy/update.sh 不存在（需 git 部署方式）');
      return;
    }
    console.log(`[provider] 收到升级指令（目标 ${cmd.targetVersion ?? 'latest'}）：git pull + 重启`);
    try {
      const child = spawn('bash', [script], {
        cwd: repoDir,
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env, RC_UPDATE_TARGET: cmd.targetVersion ?? '' },
      });
      child.unref();
    } catch (err) {
      console.error('[provider] 更新脚本启动失败:', (err as Error).message);
    }
  }

  private scheduleReconnect(): void {
    setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(30_000, this.reconnectDelay * 2);
  }

  private send(msg: ServerMessage): void {
    if (this.ws && this.connected) this.ws.send(JSON.stringify(msg));
  }

  private staticInfo(): ServerStaticInfo {
    const cpus = os.cpus();
    return {
      serverId: this.serverId(),
      hostname: os.hostname(),
      platform: `${os.platform()}-${os.arch()}`,
      release: os.release(),
      cpuModel: cpus[0]?.model ?? 'unknown',
      cpuCount: cpus.length,
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
      gpus: this.gpuInfo,
      diskPaths: this.config.diskPaths,
      agentVersion: PROVIDER_VERSION,
      ssh: this.config.ssh,
      direct: collectDirectAddresses(this.config.ssh),
      tunneled: this.config.tunneled === true,
    };
  }

  private async reportMetrics(): Promise<void> {
    if (!this.connected) return;
    const metrics: ServerMetrics = {
      ts: Date.now(),
      ...memoryMetric(),
      gpus: (await queryGpus()).metrics,
      disks: await diskMetricsAuto(this.config.diskPaths),
    };
    this.send({ type: 'metrics', metrics });
  }
}

const provider = new Provider();
void provider.start();

process.on('SIGINT', () => {
  console.log('[provider] 退出');
  process.exit(0);
});
