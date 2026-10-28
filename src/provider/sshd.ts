import fs from 'node:fs';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CloudCommand } from '../shared/protocol.js';

const run = promisify(exec);
const runFile = promisify(execFile);

/**
 * 供给端本地 SSH 访问治理（方案 C 的服务器侧）：
 * 1. config-ca：sshd 信任云端 SSH CA（TrustedUserCAKeys）+ AuthorizedPrincipalsFile（幂等）
 * 2. principal-sync：声明式全量对账——principal 文件内容替换为云端下发的全集（多余即删）
 * 3. 自愈：60s 扫描，条目 expiresAt 过期即删（云端失联也能收敛）
 * 4. cleanup-allocation：按目录模式杀残留进程并移除工作目录
 *
 * 凭证治理不变量：本机可接受的 SSH 凭证数 = 云端活跃分配数。
 */

export interface PrincipalEntry {
  principal: string;
  expiresAt: number;
}

const isWin = process.platform === 'win32';

/** 生成 principals 文件内容：一行一个 principal，注释携带过期时间（自愈依据） */
export function renderPrincipals(entries: PrincipalEntry[]): string {
  const lines = entries
    .slice()
    .sort((a, b) => a.expiresAt - b.expiresAt)
    .map((e) => `${e.principal} # exp=${e.expiresAt}`);
  return `# managed by resource-console provider — DO NOT EDIT\n${lines.join('\n')}\n`;
}

/** 解析 principals 文件；返回有效条目与过期条目（自愈用） */
export function parsePrincipals(content: string): { active: PrincipalEntry[]; expired: PrincipalEntry[] } {
  const active: PrincipalEntry[] = [];
  const expired: PrincipalEntry[] = [];
  const now = Date.now();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^(\S+)(?:\s*#\s*exp=(\d+))?/);
    if (!m) continue;
    const entry: PrincipalEntry = { principal: m[1]!, expiresAt: m[2] ? Number(m[2]) : Number.MAX_SAFE_INTEGER };
    if (entry.expiresAt <= now) expired.push(entry);
    else active.push(entry);
  }
  return { active, expired };
}

export class SshGovernor {
  private readonly principalsFile: string;
  private readonly caPubFile: string;
  private timer?: NodeJS.Timeout;
  private lastError?: string;

  cleanupPolicy?: string;

  constructor(
    private readonly stateDir: string,
    /** 测试注入自定义路径（默认按平台使用系统 sshd 配置路径） */
    paths?: { principalsFile?: string; caPubFile?: string },
  ) {
    this.principalsFile = paths?.principalsFile ?? (isWin ? 'C:/ProgramData/ssh/rc_principals' : '/etc/ssh/rc_principals');
    this.caPubFile = paths?.caPubFile ?? (isWin ? 'C:/ProgramData/ssh/rc_ca.pub' : '/etc/ssh/rc_ca.pub');
  }

  get status(): { ok: boolean; lastError?: string; principalsFile: string } {
    return { ok: !this.lastError, lastError: this.lastError, principalsFile: this.principalsFile };
  }

  /** 落地 CA 信任与 principals 配置（幂等；需要管理员/root 运行供给端） */
  async configureCa(caPublicKey: string): Promise<void> {
    try {
      fs.writeFileSync(this.caPubFile, caPublicKey.trim() + '\n', { mode: 0o644 });
      if (!fs.existsSync(this.principalsFile)) {
        fs.writeFileSync(this.principalsFile, renderPrincipals([]), { mode: 0o644 });
      }
      if (isWin) {
        const conf = 'C:/ProgramData/ssh/sshd_config';
        await this.ensureConfigLines(conf, [
          `TrustedUserCAKeys ${this.caPubFile}`,
          `AuthorizedPrincipalsFile ${this.principalsFile}`,
        ]);
        await run('powershell -Command "Restart-Service sshd -Force"', { timeout: 30_000, windowsHide: true });
      } else {
        const conf = '/etc/ssh/sshd_config';
        await this.ensureConfigLines(conf, [
          `TrustedUserCAKeys ${this.caPubFile}`,
          `AuthorizedPrincipalsFile ${this.principalsFile}`,
        ]);
        // 先验证配置再重载，避免打挂 sshd。
        // 非 root 运行时读不到 host 私钥，sshd -t 必报 "no hostkeys available"——
        // 此时 sshd_config 指令已由 root 的 setup 脚本写入并校验过，跳过即可。
        try {
          await run('sshd -t', { timeout: 10_000 });
          await run('systemctl reload sshd || systemctl reload ssh || service ssh reload', {
            timeout: 15_000,
            shell: '/bin/sh',
          });
        } catch (err) {
          if (String(err).includes('no hostkeys available')) {
            console.log('[ssh] 非 root 运行：sshd_config 已由 setup 脚本配置，跳过校验/重载');
          } else {
            throw err;
          }
        }
      }
      this.lastError = undefined;
      console.log('[ssh] sshd 已信任云端 CA（TrustedUserCAKeys + AuthorizedPrincipalsFile）');
    } catch (err) {
      this.lastError = `sshd 配置失败: ${(err as Error).message}`;
      console.error(`[ssh] ${this.lastError}`);
    }
  }

  private async ensureConfigLines(confPath: string, lines: string[]): Promise<void> {
    let conf = fs.readFileSync(confPath, 'utf8');
    // 幂等：所需指令均已存在则不写（sshd_config 可能 root 只读，由 setup 脚本一次性配置）
    if (lines.every((line) => conf.includes(line))) return;
    for (const line of lines) {
      const key = line.split(' ')[0]!;
      // 移除已有同名指令（含被注释的），追加我们的
      const re = new RegExp(`^\\s*#?\\s*${key}\\s+.*$`, 'gim');
      if (re.test(conf)) {
        conf = conf.replace(re, '');
      }
      conf += `\n${line}\n`;
    }
    fs.writeFileSync(confPath, conf, 'utf8');
  }

  /** 全量对账：文件内容替换为云端 desired 全集；返回被移除的条目数 */
  syncPrincipals(desired: PrincipalEntry[]): { removed: number; added: number } {
    try {
      const current = fs.existsSync(this.principalsFile)
        ? parsePrincipals(fs.readFileSync(this.principalsFile, 'utf8'))
        : { active: [], expired: [] };
      const desiredKeys = new Set(desired.map((e) => e.principal));
      const removed = current.active.filter((e) => !desiredKeys.has(e.principal)).length + current.expired.length;
      const currentKeys = new Set(current.active.map((e) => e.principal));
      const added = desired.filter((e) => !currentKeys.has(e.principal)).length;
      fs.writeFileSync(this.principalsFile, renderPrincipals(desired), { mode: 0o644 });
      return { removed, added };
    } catch (err) {
      this.lastError = `principal 同步失败: ${(err as Error).message}`;
      console.error(`[ssh] ${this.lastError}`);
      return { removed: 0, added: 0 };
    }
  }

  /** 自愈：删除过期条目（云端失联时独立收敛） */
  selfHeal(): number {
    try {
      if (!fs.existsSync(this.principalsFile)) return 0;
      const { active, expired } = parsePrincipals(fs.readFileSync(this.principalsFile, 'utf8'));
      if (expired.length > 0) {
        fs.writeFileSync(this.principalsFile, renderPrincipals(active), { mode: 0o644 });
        console.log(`[ssh] 自愈清理过期 principal ${expired.length} 条`);
      }
      return expired.length;
    } catch {
      return 0;
    }
  }

  startSelfHeal(intervalMs = 60_000): void {
    this.timer = setInterval(() => {
      this.selfHeal();
      this.cleanExpiredWorkdirs();
    }, intervalMs);
    this.timer.unref?.();
  }

  /** 清理 retain-Nd 到期的工作目录 */
  private cleanExpiredWorkdirs(): void {
    try {
      const dir = path.dirname(this.principalsFile);
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith('rc-cleanup-') || !f.endsWith('.expiry')) continue;
        const file = path.join(dir, f);
        const expiry = Number(fs.readFileSync(file, 'utf8'));
        if (Date.now() < expiry) continue;
        const allocId = f.replace('rc-cleanup-', '').replace('.expiry', '');
        const home = isWin ? process.env.USERPROFILE ?? 'C:' : process.env.HOME ?? '/root';
        const workdir = path.join(home, 'rc-runs', allocId);
        fs.rmSync(workdir, { recursive: true, force: true });
        fs.rmSync(file, { force: true });
        console.log(`[ssh] 工作目录已过期清理: ${workdir}`);
      }
    } catch {
      /* noop */
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * 分配结束处理：科研安全——只关闭 SSH 访问（云端已吊销 principal/隧道），
   * 不杀正在运行的进程（实验可能跑到一半），不删工作目录。
   * 目录清理由 cleanup 策略控制；杀进程仅由用户主动 stop 触发。
   */
  async cleanupAllocation(cmd: Extract<CloudCommand, { type: 'cleanup-allocation' }>): Promise<void> {
    const home = isWin ? process.env.USERPROFILE ?? 'C:' : process.env.HOME ?? '/root';
    const dir = path.join(home, cmd.workDir.replace(/\\/g, '/'));
    const policy = this.cleanupPolicy ?? 'retain';

    // 记录目录到期时间（janitor 按 retain-Nd 策略定期清理）
    const m = policy.match(/^retain-(\d+)d$/);
    if (m) {
      const expiry = path.join(path.dirname(this.principalsFile), `rc-cleanup-${cmd.allocationId}.expiry`);
      try { fs.writeFileSync(expiry, String(Date.now() + Number(m[1]) * 86400_000)); } catch { /* noop */ }
    }

    if (policy === 'delete') {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`[ssh] 分配 ${cmd.allocationId} 目录已清理（进程未动，用户主动 stop 可停）`);
      } catch (err) {
        console.warn(`[ssh] 分配 ${cmd.allocationId} 目录清理失败:`, (err as Error).message);
      }
    } else {
      console.log(`[ssh] 分配 ${cmd.allocationId} 租约结束：SSH 访问已关闭，进程继续运行，目录保留（${dir}，策略=${policy}）`);
    }
  }
}
