#!/usr/bin/env bash
set -Eeuo pipefail

QQBOT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd -- "$QQBOT_ROOT"
QQBOT_ACTION="${1:-deploy}"

fail() { printf '\n%s\n' "$*" >&2; exit 1; }
case "$QQBOT_ACTION" in
  deploy|status|logs|stop|restart|password|doctor|disk-guard) ;;
  *) fail '用法：bash ubuntu.sh {deploy|status|logs|stop|restart|password|doctor|disk-guard}' ;;
esac
[[ "$(uname -s)" == Linux ]] || fail '本脚本用于 Ubuntu / Linux 服务器；Mac 本机请继续使用 npm run deploy。'
command -v docker >/dev/null 2>&1 || fail '未安装 Docker Engine。安装方法见 README.md 或 https://docs.docker.com/engine/install/ubuntu/'
if ! docker info >/dev/null 2>&1; then
  docker info >&2 || true
  fail 'Docker 不可用。先执行 sudo systemctl enable --now docker；权限不足时执行 sudo bash ubuntu.sh deploy。'
fi
docker compose version >/dev/null 2>&1 || fail '缺少 Compose 插件。使用 Docker 官方 apt 软件源安装 docker-compose-plugin。'

if [[ ! -e .env.ubuntu ]]; then
  # macOS 的 cp 会沿用源文件权限，umask 不足以保证 600，这里显式收紧（文件内含 Token）。
  (umask 077; cp .env.ubuntu.example .env.ubuntu && chmod 600 .env.ubuntu) || fail '无法创建 .env.ubuntu，请检查项目目录权限或执行 sudo bash ubuntu.sh deploy。'
  printf '%s\n' '已生成 Ubuntu 配置 .env.ubuntu（后台默认开放 0.0.0.0:3080）。'
fi
compose() { docker compose --env-file "$QQBOT_ROOT/.env.ubuntu" -f "$QQBOT_ROOT/compose.ubuntu.yaml" "$@"; }
compose config --quiet || fail 'Ubuntu Compose 配置无效，请检查 .env.ubuntu。'

show_status() {
  compose ps
  printf '\n后台实际端口绑定：\n'
  compose port qq-bot 3080 || true
}
wait_ready() {
  local count status container
  container="$(compose ps -a -q qq-bot)"
  [[ -n "$container" ]] || fail '未找到后台容器，请先执行 bash ubuntu.sh deploy。'
  for ((count=0; count<45; count++)); do
    status="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")"
    if [[ "$status" == 'running healthy' ]]; then return; fi
    if [[ "$status" == exited* || "$status" == dead* ]]; then break; fi
    if ((count % 10 == 0)); then printf '正在等待后台健康检查：%s\n' "$status"; fi
    sleep 2
  done
  compose logs --tail=60 qq-bot >&2 || true
  fail '后台未通过健康检查。请按上方错误修复后再次部署，或执行 bash ubuntu.sh doctor。'
}
read_binding() {
  # Read the resolved config inside a tools container; .env.ubuntu is never executed as shell code.
  compose run --rm --no-deps --entrypoint node -T init -e '
    const bind = process.env.EXPECTED_BIND; const port = process.env.EXPECTED_PORT;
    if (!require("node:net").isIPv4(bind) || !/^\d+$/.test(port) || +port < 1 || +port > 65535) {
      console.error("UBUNTU_BIND 必须为 IPv4 地址，UBUNTU_PORT 必须为 1–65535 的端口号"); process.exit(1);
    }
    for (const key of ["UBUNTU_UID", "UBUNTU_GID"]) {
      if (!/^\d+$/.test(process.env[key]) || +process.env[key] < 1 || +process.env[key] > 2147483647) {
        console.error(`${key} 必须为非 root 的有效数字 ID`); process.exit(1);
      }
    }
    import("./src/init-ubuntu.mjs").then(({validateDataSource}) => {
      validateDataSource(process.env.EXPECTED_DATA_DIR);
      console.log(`${bind}:${+port}`);
    }).catch(error => {console.error(error.message); process.exit(1)});
  '
}
verify_binding() {
  local container expected="$1" actual
  container="$(compose ps -q qq-bot)"
  actual="$(docker inspect --format '{{range (index .NetworkSettings.Ports "3080/tcp")}}{{println .HostIp ":" .HostPort}}{{end}}' "$container" | tr -d ' ')"
  [[ "$actual" == "$expected" ]] || fail "端口绑定不符合配置：期望 ${expected}，实际 ${actual}。请执行 bash ubuntu.sh doctor。"
  printf '\n后台已健康运行，实际端口：%s\n' "$actual"
  if [[ "$actual" == 0.0.0.0:* ]]; then
    printf '请在云防火墙 / 安全组放行 TCP %s，然后打开 http://服务器公网IP:%s\n' "${actual##*:}" "${actual##*:}"
  else
    printf '后台按 .env.ubuntu 配置监听指定地址。需要公网访问时设置 UBUNTU_BIND=0.0.0.0 后重新部署。\n'
  fi
}

case "$QQBOT_ACTION" in
  deploy)
    printf '%s\n' '构建 Vue 后台和机器人镜像（服务器无需 Node.js / npm）…'
    compose build qq-bot
    compose pull napcat
    QQBOT_EXPECTED_BINDING="$(read_binding)" || fail '端口或运行用户配置无效，尚未停止现有服务。'
    printf '%s\n' '停止本项目容器，初始化并修复 data 目录权限…'
    compose stop qq-bot napcat
    compose run --rm --no-deps -T init
    printf '%s\n' '按 Ubuntu 配置重新创建容器，应用公网端口…'
    compose up -d --no-build --force-recreate napcat qq-bot
    wait_ready
    verify_binding "$QQBOT_EXPECTED_BINDING"
    printf '%s\n' '首次使用请打开后台设置管理员账号和密码；已有账号保持不变。' 'QQ群登录：进入后台 → QQ 连接 → 获取二维码。'
    ;;
  status) show_status ;;
  logs) compose logs --tail=100 -f qq-bot ;;
  stop) compose stop qq-bot napcat ;;
  restart) compose restart napcat qq-bot; wait_ready; show_status ;;
  password)
    compose exec -T qq-bot node -e '
      const fs = require("node:fs"), p = "/app/data/initial-password.txt";
      if (fs.existsSync(p)) process.stdout.write(fs.readFileSync(p));
      else console.log("没有密码重置文件。首次使用请在后台创建管理员；已有账号请使用已设置的密码。");
    '
    ;;
  doctor)
    show_status
    printf '\n容器内健康检查：\n'
    compose exec -T qq-bot node -e 'fetch("http://127.0.0.1:3080/health", {signal: AbortSignal.timeout(5000)}).then(async r => {console.log("HTTP", r.status, await r.text()); if (!r.ok) process.exit(1)}).catch(e => {console.error(e.message); process.exit(1)})' || true
    printf '\n最近后台日志（不输出 NapCat 二维码和 Token）：\n'
    compose logs --tail=40 qq-bot
    printf '\n如本机健康但公网打不开，请确认云防火墙 / 安全组放行上方端口，并在网址中带上端口号。\n'
    ;;
  disk-guard)
    shift || true
    exec bash "$QQBOT_ROOT/scripts/vps-disk-guard.sh" "$@"
    ;;
esac
