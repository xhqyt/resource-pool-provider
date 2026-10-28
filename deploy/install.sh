#!/usr/bin/env bash
# ============================================================================
# 资源供给端 - Linux 一键安装（systemd 常驻）
#
# 用法（在仓库根目录，以 root 运行）：
#   ./deploy/install.sh rce_<管理员分发的引导串>
#
# 做了什么：npm install → 引导串写入 provider.config.json → 安装 systemd 服务 → 启动
# 幂等：重复执行安全（更新代码后重跑即完成升级重启）
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

ENROLL="${1:-}"
SERVICE=rc-provider

# Node 检查
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)'; then
  echo "错误: 需要 Node.js >= 22（当前 $(node -v 2>/dev/null || echo 未安装)）"
  echo "安装: curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && yum install -y nodejs"
  echo "      或从 https://nodejs.org/dist/latest-v22.x/ 下载官方二进制包"
  exit 1
fi

echo "==> 安装依赖"
npm install --no-audit --no-fund

echo "==> 写入配置"
if [ -n "$ENROLL" ]; then
  npx tsx src/provider/index.ts --print-config "$ENROLL"
fi
[ -f provider.config.json ] || { echo "错误: 缺少 provider.config.json（需要引导串或手动创建，见 provider.config.example.json）"; exit 1; }
chmod 600 provider.config.json

echo "==> 安装 systemd 服务 $SERVICE"
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Resource Console Provider
After=network.target

[Service]
WorkingDirectory=$(pwd)
ExecStart=$(which npx) tsx src/provider/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now $SERVICE
sleep 3
systemctl --no-pager -l status $SERVICE | head -5
echo
echo "完成。常用命令: journalctl -u $SERVICE -f   # 看日志"
echo "          systemctl restart $SERVICE        # 改配置后重启"
