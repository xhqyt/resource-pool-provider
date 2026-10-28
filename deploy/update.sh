#!/usr/bin/env bash
# ============================================================================
# 供给端自更新：git pull → npm install → 重启服务
# 可手动运行，也可由云端触发（收到 update-provider 指令时供给端自动调用）。
# 日志: /tmp/rc-provider-update.log
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
LOG=/tmp/rc-provider-update.log
exec >>"$LOG" 2>&1
echo "===== $(date '+%F %T') 自更新开始（目标 ${RC_UPDATE_TARGET:-latest}）"

pull_ok=0
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "--- git pull（GitHub）"
  if timeout 90 git pull --ff-only origin main; then
    pull_ok=1
  else
    echo "git pull 失败（网络不可达或本地改动），尝试云端发布包兜底"
  fi
fi

if [ "$pull_ok" != "1" ]; then
  # 云端地址取自 provider.config.json 的 consoleUrl（GitHub 不可达环境的可靠兜底源）
  CONSOLE_URL=$(python3 -c "import json;print(json.load(open('provider.config.json'))['consoleUrl'])" 2>/dev/null || true)
  if [ -z "$CONSOLE_URL" ]; then
    echo "无法确定云端地址（provider.config.json 缺失），更新中止"
    exit 1
  fi
  REL_URL=$(echo "$CONSOLE_URL" | sed -E 's#^(wss?)://#http://; s#/ws/server.*##')/provider-release.tar.gz
  echo "--- 下载云端发布包: $REL_URL"
  if ! curl -fsSL --max-time 120 -o /tmp/rc-rel.tar.gz "$REL_URL"; then
    echo "云端发布包下载失败，更新中止"
    exit 1
  fi
  tar -xzf /tmp/rc-rel.tar.gz --strip-components=1 -C . && rm -f /tmp/rc-rel.tar.gz
fi

echo "--- npm install"
npm install --no-audit --no-fund || { echo "npm install 失败"; exit 1; }

# 等当前进程把 WS 回执发完
sleep 1

echo "--- 重启服务"
if systemctl --user list-units 'rc-provider*' --no-legend 2>/dev/null | grep -q rc-provider && \
   [ "${XDG_RUNTIME_DIR:-}" != "" ] && systemctl --user is-active --quiet rc-provider.service 2>/dev/null; then
  systemctl --user restart rc-provider.service && echo "已重启（用户级 systemd）"
elif command -v sudo >/dev/null && sudo -n true 2>/dev/null; then
  sudo systemctl restart rc-provider && echo "已重启（系统级 systemd）"
else
  # 无 systemd 管理（前台运行）：由调用方自行重启；杀掉旧进程兜底
  pkill -f "tsx src/provider/index.ts" 2>/dev/null
  echo "未检测到 systemd 服务，已尝试停止旧进程（请以常驻方式运行）"
fi

echo "===== 自更新完成"
