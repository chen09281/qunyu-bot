#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename -- "${BASH_SOURCE[0]}")"
QQBOT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
MOUNT="${DISK_GUARD_MOUNT:-/}"
THRESHOLD="${DISK_GUARD_THRESHOLD:-90}"
CONTAINER="${DISK_GUARD_CONTAINER:-qunyu-qq-bot-1}"
if [[ -n "${DISK_GUARD_DATA_DIR:-}" ]]; then
  DATA_DIR="$DISK_GUARD_DATA_DIR"
elif [[ -d "$QQBOT_ROOT/data" ]]; then
  DATA_DIR="$QQBOT_ROOT/data"
else
  DATA_DIR="$QQBOT_ROOT/data"
fi
FORCE=0
INSTALL_CRON=0

fail() { printf '%s\n' "$*" >&2; exit 1; }

while (($# > 0)); do
  case "$1" in
    --force) FORCE=1; shift ;;
    --install-cron) INSTALL_CRON=1; shift ;;
    --threshold)
      (($# >= 2)) || fail '用法：--threshold <1-99>'
      THRESHOLD="$2"; shift 2 ;;
    --mount)
      (($# >= 2)) || fail '用法：--mount <路径>'
      MOUNT="$2"; shift 2 ;;
    --container)
      (($# >= 2)) || fail '用法：--container <容器名>'
      CONTAINER="$2"; shift 2 ;;
    --data-dir)
      (($# >= 2)) || fail '用法：--data-dir <数据目录>'
      DATA_DIR="$2"; shift 2 ;;
    *)
      fail '用法：bash scripts/vps-disk-guard.sh [--force] [--threshold <1-99>] [--mount <路径>] [--install-cron]' ;;
  esac
done

[[ "$THRESHOLD" =~ ^[0-9]{1,2}$ ]] && ((THRESHOLD >= 1 && THRESHOLD <= 99)) || fail '存储阈值必须为 1–99 的整数百分比'

if ((INSTALL_CRON == 1)); then
  CRON_FILE="${DISK_GUARD_CRON_FILE:-/etc/cron.d/qqbot-disk-guard}"
  LOG_FILE="${DISK_GUARD_LOG_FILE:-/var/log/qqbot-disk-guard.log}"
  cat > "$CRON_FILE" <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/15 * * * * root "$SCRIPT_PATH" --threshold "$THRESHOLD" --mount "$MOUNT" >> "$LOG_FILE" 2>&1
EOF
  chmod 0644 "$CRON_FILE"
  printf '已安装定时磁盘巡检任务：%s（每 15 分钟检查 %s，超过 %s%% 自动清理）\n' "$CRON_FILE" "$MOUNT" "$THRESHOLD"
  exit 0
fi

read_usage_percent() {
  df -P "$MOUNT" | awk 'NR==2 {gsub(/%/, "", $5); print $5}'
}

USED_BEFORE="$(read_usage_percent)"
[[ "$USED_BEFORE" =~ ^[0-9]{1,3}$ ]] || fail "无法读取挂载点 $MOUNT 的磁盘使用率"

if ((FORCE == 0 && USED_BEFORE < THRESHOLD)); then
  printf '[%s] 磁盘负载正常：%s 当前使用率 %s%%（阈值 %s%%），无需清理。\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$MOUNT" "$USED_BEFORE" "$THRESHOLD"
  exit 0
fi

printf '[%s] 触发自动磁盘清理：%s 当前使用率 %s%%（阈值 %s%%，强制=%s）…\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$MOUNT" "$USED_BEFORE" "$THRESHOLD" "$FORCE"

# 1. 清理运行中容器与宿主机的过期临时目录（绝不重启或停止容器）
if command -v docker >/dev/null 2>&1; then
  if [[ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" == 'true' ]]; then
    docker exec "$CONTAINER" sh -c 'find /tmp -mindepth 1 -maxdepth 1 \( -name "org.chromium.Chromium.*" -o -name ".org.chromium.Chromium.*" -o -name "qqbot-*" \) -mmin +30 -exec rm -rf {} + 2>/dev/null || true' || true
  fi
fi

for tmp_root in /tmp /var/tmp; do
  if [[ -d "$tmp_root" ]]; then
    find "$tmp_root" -mindepth 1 -maxdepth 1 \( -name 'org.chromium.Chromium.*' -o -name '.org.chromium.Chromium.*' -o -name 'qqbot-*' \) -mmin +30 -exec rm -rf {} + 2>/dev/null || true
  fi
done

if [[ -d "${HOME:-/tmp}/.cache/qqbot-android" ]]; then
  rm -rf "${HOME:-/tmp}/.cache/qqbot-android" 2>/dev/null || true
fi

# 清理超过 3 天的 NTQQ 群视频与日志临时缓存，保留全部登录态与数据库文件
if [[ -d "$DATA_DIR/napcat/qq" ]]; then
  find "$DATA_DIR/napcat/qq" -path '*/nt_qq_*/nt_data/Video/*' -type f -mtime +3 -delete 2>/dev/null || true
  find "$DATA_DIR/napcat/qq" -path '*/nt_qq_*/nt_data/log/*' -type f -mtime +3 -delete 2>/dev/null || true
fi

# 2. 清理历史回滚镜像、悬空镜像与 Docker 构建缓存
if command -v docker >/dev/null 2>&1; then
  while IFS= read -r img; do
    [[ -n "$img" ]] || continue
    docker rmi "$img" >/dev/null 2>&1 || true
  done < <(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^qunyu-qq-bot:(before-|pre-|rollback-|latest)|^hello-world:|^diygod/rsshub:latest' || true)

  docker image prune -f >/dev/null 2>&1 || true
  docker builder prune -f --reserved-space 500MB >/dev/null 2>&1 || docker builder prune -f >/dev/null 2>&1 || true
fi

# 3. 清理系统 journal 归档日志与 apt 缓存
if command -v journalctl >/dev/null 2>&1; then
  journalctl --vacuum-size=50M >/dev/null 2>&1 || true
fi
if command -v apt-get >/dev/null 2>&1; then
  apt-get clean >/dev/null 2>&1 || true
fi

USED_AFTER="$(read_usage_percent)"
printf '[%s] 清理完成：%s 使用率 %s%% -> %s%%（容器与 QQ 登录态保持运行）。\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$MOUNT" "$USED_BEFORE" "$USED_AFTER"
