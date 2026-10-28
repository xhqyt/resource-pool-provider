/**
 * 三方架构契约：需求方 Agent（CLI）— 云端（调度/SSH CA/信任锚）— 供给服务器（守护进程+sshd）
 *
 * 链路：
 *  L1 供给控制通道  Server ←WS→ Cloud（注册/心跳/指令）
 *  L2 需求通道      Agent CLI ←HTTPS→ Cloud（需求提交/分配/释放，需求凭证认证）
 *  L3 交付通道      Agent CLI ←SSH→ Server（直连执行/日志/停止，短期证书+principal 白名单验证）
 */

// ════════════════ L1：供给服务器 ════════════════

export interface GpuInfo {
  index: number;
  name: string;
  totalMb: number;
}

export interface GpuMetric {
  index: number;
  usedMb: number;
  freeMb: number;
  /** 瞬时利用率（本次采样） */
  utilPct: number;
  /** 60 秒滚动平均利用率（平滑瞬时抖动） */
  utilAvgPct?: number;
  tempC: number;
}

export interface DiskMetric {
  path: string;
  totalGb: number;
  freeGb: number;
  error?: string;
}

export interface ServerStaticInfo {
  serverId: string;
  hostname: string;
  platform: string;
  release: string;
  cpuModel: string;
  cpuCount: number;
  totalMemMb: number;
  gpus: GpuInfo[];
  diskPaths: string[];
  agentVersion: string;
  /** SSH 直连信息（advertise）：配置声明的对外地址 */
  ssh: { host: string; port: number; user: string };
  /**
   * 直连候选地址（供给端自动收集 + 配置补充），需求方按 lan→ipv6→public 顺序探测，
   * 全部不可达时走云端中继。内网设备（tunneled）同样可含局域网/IPv6 地址实现同网或 v6 直连。
   */
  direct: { host: string; port: number; kind: 'lan' | 'ipv6' | 'public' }[];
  /**
   * 统一内存设备（GB10/DGX Spark 等）：GPU 显存与系统内存为同一物理池，
   * 调度上 CPU/GPU 需求共池扣减并预留 OS 余量
   */
  unifiedMemory?: boolean;
  /**
   * true = 内网设备：无法公网直连，需求方优先探测 direct（同网/v6），兜底走云端中继隧道
   * （隧道仅转发 SSH 字节流，SSH 协议自身端到端加密，云端不可解密）
   */
  tunneled: boolean;
}

export interface ServerMetrics {
  ts: number;
  memTotalMb: number;
  memFreeMb: number;
  gpus: GpuMetric[];
  disks: DiskMetric[];
}

export type ServerMessage =
  | { type: 'register'; info: ServerStaticInfo }
  | { type: 'metrics'; metrics: ServerMetrics }
  /** 中继隧道：上行数据（base64 的 SSH 字节流，SSH 自身端到端加密） */
  | { type: 'tunnel-data'; tunnelId: string; payload: string }
  /** 中继隧道：供给端侧关闭（目标连接断开等） */
  | { type: 'tunnel-close'; tunnelId: string; reason?: string };

export type CloudCommand =
  /** 首次注册后下发 CA 公钥，供给端落地 sshd 信任（幂等） */
  | { type: 'config-ca'; caPublicKey: string }
  /** 声明式全量对账：文件中应存在的 principal 全集（多余即删） */
  | { type: 'principal-sync'; principals: { principal: string; expiresAt: number }[] }
  /** 分配结束：清理残留进程与工作目录 */
  | { type: 'cleanup-allocation'; allocationId: string; workDir: string }
  /** 中继隧道：云端请求供给端向本机 targetPort 建立隧道 */
  | { type: 'tunnel-open'; tunnelId: string; targetPort: number }
  /** 中继隧道：下行数据（base64 的 SSH 字节流） */
  | { type: 'tunnel-data'; tunnelId: string; payload: string }
  /** 中继隧道：关闭 */
  | { type: 'tunnel-close'; tunnelId: string; reason?: string }
  /** 云端触发供给端软件自更新（git pull + npm install + 重启，由 systemd 拉起新版本） */
  | { type: 'update-provider'; targetVersion?: string; reason?: string };

// ════════════════ L2：需求 / 分配 / 凭证 ════════════════

export interface ResourceDemand {
  gpuMemMb?: number;
  memMb?: number;
  diskGb?: number;
}

export type CredentialKind = 'demand' | 'provider';

export interface CredentialQuota {
  /** 并发活跃分配数上限（demand） */
  maxConcurrentAllocations?: number;
  /** GPU 显存总占用上限（MB）（demand） */
  maxGpuMemMb?: number;
  maxMemMb?: number;
  maxDiskGb?: number;
  /** 可注册供给服务器数量上限（provider） */
  maxServers?: number;
}

export type DemandStatus =
  | 'queued'    // 排队等待资源/缓冲
  | 'allocated' // 已分配（租约活跃，凭证与 principal 存在）
  | 'released'  // 已释放（正常）
  | 'expired'   // 租约到期回收
  | 'revoked'   // 管理员强吊销
  | 'rejected'; // 提交即被拒（超额等）

export interface AllocationInfo {
  id: string;
  serverId: string;
  serverHost: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  /** 服务器工作目录（SSH 目录协议根：~/rc-runs/<allocationId>/） */
  workDir: string;
  /** OpenSSH 用户证书（公钥材料，云端签发，随租约过期失效） */
  cert: string;
  expiresAt: number;
  /** 直连候选（lan→ipv6→public，供给端收集），需求方探测择优；皆不可达走 tunnel 兜底 */
  candidates?: { host: string; port: number; kind: 'lan' | 'ipv6' | 'public' }[];
  /**
   * 云端中继隧道（随租约常备的兜底通道）：
   * path = 云端 /ws/relay/<serverId>；token = 隧道令牌（多连接可复用至租约结束）。
   */
  tunnel?: { path: string; token: string };
}

export interface DemandRecord {
  id: string;
  credentialId: string;
  credentialName: string;
  resources: ResourceDemand;
  workload: { command: string };
  /** 需求方公钥（OpenSSH 单行格式，公钥材料；证书签发与续租用） */
  sshPublicKey?: string;
  ttlSec: number;
  status: DemandStatus;
  rejectReason?: string;
  createdAt: number;
  allocatedAt?: number;
  expiresAt?: number;
  releasedAt?: number;
  endedBy?: 'agent' | 'admin' | 'ttl' | 'quota';
  allocation?: AllocationInfo;
}

/** 凭证（服务账户）：需求方（demand）调用需求 API；供给方（provider）注册供给服务器 */
export interface CredentialRecord {
  id: string;
  kind: CredentialKind;
  name: string;
  /** 归属的控制台用户（operator 自助创建的凭证）；缺省为管理员创建的全局凭证 */
  ownerUsername?: string;
  /** sha256(token)，明文 token 仅创建时返回一次；demand=rcd_ / provider=rpk_ */
  tokenHash: string;
  quota: CredentialQuota;
  enabled: boolean;
  description?: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface CredentialPublic {
  id: string;
  kind: CredentialKind;
  name: string;
  ownerUsername?: string;
  quota: CredentialQuota;
  enabled: boolean;
  description?: string;
  createdAt: number;
  lastUsedAt?: number;
  activeAllocations: number;
  /** 当前活跃占用（聚合值） */
  usedResources: ResourceDemand;
  /** provider 凭证当前注册的服务器数 */
  registeredServers: number;
}

export const DEMAND_TOKEN_PREFIX = 'rcd_';
export const PROVIDER_TOKEN_PREFIX = 'rpk_';
export const PROVIDER_VERSION = '1.6.3';

// ════════════════ 云端服务器视图（L1 + 管理状态） ════════════════

export interface AllocatableView {
  gpuFreeMb: number;
  memFreeMb: number;
  diskFreeGb: number;
  reservedGpuMb: number;
  reservedMemMb: number;
  activeAllocations: number;
}

export interface ServerView extends ServerStaticInfo {
  connected: boolean;
  lastSeen: number;
  latest?: ServerMetrics;
  allocatable?: AllocatableView;
  locked: boolean;
  lockedReason?: string;
  /** 排空：锁定 + 存量分配结束后不再接新 */
  drain: boolean;
  /** 分配缓冲中（临时禁配）截至时刻；0 表示无 */
  settlingUntil: number;
  /** 归属：注册凭证名称（credential:xxx）或 system（全局 AGENT_TOKEN） */
  owner: string;
  /** 管理备注（云端持久化，operator 可编辑） */
  note?: string;
}

// ════════════════ 前端事件（WS /ws/ui） ════════════════

export type UiEvent =
  | { type: 'snapshot'; servers: ServerView[]; demands: DemandRecord[] }
  | { type: 'metrics'; serverId: string; metrics: ServerMetrics }
  | { type: 'demand-update'; demand: DemandRecord }
  | { type: 'server-update'; server: ServerView };

// ════════════════ 控制台用户体系（人员，与需求凭证分离） ════════════════

/** viewer 只读 / operator 可管理需求 / admin 全部（含凭证与锁定） */
export type Role = 'viewer' | 'operator' | 'admin';

export interface UserPublic {
  username: string;
  role: Role;
  enabled: boolean;
  createdAt: number;
}

export interface AuditEntry {
  ts: number;
  user: string;
  action: string;
  detail?: string;
}

// ════════════════ 供给端配置 ════════════════

export interface ProviderConfig {
  consoleUrl: string;
  token?: string;
  serverId?: string;
  intervalMs: number;
  diskPaths: string[];
  /** SSH 直连信息（advertise） */
  ssh: { host: string; port: number; user: string };
  /** 内网设备：true 时需求方经云端中继隧道访问 */
  tunneled?: boolean;
}
