# 资源池供给端（ResourcePool Provider）

把本机资源（**GPU / 内存 / 存储**）接入**资源池（ResourcePool）**的供给端守护进程。

- 向云端控制台注册并持续上报资源指标，参与统一调度
- 按云端治理 SSH 访问：自动配置 sshd 信任云端 CA、维护"仅活跃分配可登录"的 principal 白名单、分配结束自动清理
- **内网穿透模式**：无公网 IP / 无入站端口也能被需求方经云端中继访问（SSH 端到端加密）

> 平台三方架构：需求方（CLI）→ 云端（调度/信任锚）→ **供给端（本仓库）**。管理员在控制台为你创建"供给凭证"并交付一键引导串。

## 前置要求

| 项 | 要求 |
|---|---|
| Node.js | **≥ 22**（`node -v` 检查；[官方安装](https://nodejs.org/dist/latest-v22.x/) 或 nodesource） |
| 运行权限 | Linux `root` / Windows **管理员**（首次运行需配置 sshd） |
| OpenSSH Server | 本机 sshd 运行中（`systemctl status sshd` / `Get-Service sshd`）——内网穿透模式同样需要（交付走本机回环） |
| GPU 上报 | 安装 NVIDIA 驱动（`nvidia-smi` 可用即可；无 GPU 也可作为 CPU/内存供给） |

## 快速开始（enroll 一键接入）

从管理员处获得引导串（`rce_` 开头），然后：

```bash
git clone <本仓库地址> && cd resource-console-provider
npm install
npx tsx src/provider/index.ts rce_xxxxxxxxxxxx   # 引导串作为参数，自动写配置并连接
```

看到 `已连接云端调度` 即接入成功；控制台服务器列表会出现本机（归属你的凭证）。

**Linux 常驻部署（推荐）**：

```bash
sudo ./deploy/install.sh rce_xxxxxxxxxxxx        # npm install + 写配置 + systemd 常驻（开机自启）
journalctl -u rc-provider -f                     # 看日志
```

**Windows 常驻部署（开机自启）**：

```powershell
# 先用引导串跑一次完成配置，然后（管理员 PowerShell）：
.\启动供给端.bat rce_xxxxxxxxxxxx                 # 生成 provider.config.json 后 Ctrl+C 退出
powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1   # 注册计划任务（开机自启+崩溃自动拉起）
# 卸载: powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1 -Remove
```

临时前台运行：管理员身份运行 `启动供给端.bat rce_xxxxxxxx`。

## 配置（provider.config.json）

enroll 会自动生成；手动调整以下字段后重启生效（云端地址以管理员签发的引导串为准，不在本仓库中出现）：

```jsonc
{
  "consoleUrl": "wss://<你的云端地址>/ws/server", // 由 enroll 引导串自动写入
  "token": "rpk_...",                          // 供给凭证（enroll 自动写入）
  "intervalMs": 5000,                          // 指标上报间隔
  "diskPaths": ["/"],                          // 上报的磁盘（Windows 如 ["C:\\"]）
  "tunneled": false,                           // ★ true=内网穿透模式
  "ssh": { "host": "本机地址", "port": 22, "user": "root" }  // 需求方直连信息
}
```

- **内网机器**（家里 GPU、机房内网）：把 `tunneled` 改为 `true`——无需公网 IP、端口转发或任何入站端口
- **直连模式**：`ssh.host` 填需求方可达的本机地址（公网 IP 或与需求方同网的内网 IP）

## 常见问题

| 现象 | 处理 |
|---|---|
| `云端拒绝连接：注册凭证已失效或被吊销` | 凭证被管理员禁用/删除，或引导串已换新——联系管理员 |
| `云端关闭连接: 凭证被禁用/超出注册上限` | 该凭证注册服务器数达上限（maxServers）——联系管理员 |
| `[ssh] sshd 配置失败` | 未以 root/管理员运行；或 sshd_config 权限异常。修复后重启供给端（幂等重配） |
| `未检测到 NVIDIA GPU` | 无驱动或无 N 卡；仍可作为 CPU/内存/存储供给 |
| 需求方 SSH 连不上（直连模式） | 检查防火墙放行 `ssh.port`；内网机器请改用 `tunneled: true` |
| 心跳断开自动重连 | 正常设计：断线期间本地 SSH 治理与自愈继续，重连后自动对账 |

## 安全说明

- 供给端只持有**注册凭证**（rpk_），不持有任何云端账户或长期 SSH 私钥
- 需求方经短期证书 + principal 白名单登录本机（证书随租约过期，白名单随对账收敛）；本机不保存任何需求方公钥
- 凭证泄露：联系管理员吊销，名下服务器连接即时断开

## 与主仓库的关系

本仓库是资源池（ResourcePool）平台的供给端子集（`src/shared` 为通信契约）。协议升级时以主仓库为准同步本目录。

## 软件升级

平台支持**云端一键升级**：控制台「供给服务器」页会显示每台机器的版本，落后于最新版时出现「可升级」按钮——点击后供给端自动执行 `git pull → npm install → 服务重启`，全程无需登录机器。

手动升级（任一供给机）：

```bash
cd ~/resource-console-provider && bash deploy/update.sh
```

> 前提：以 git clone 方式部署（自更新即 git pull）。tar 包部署的旧实例请重新 clone 一次。
