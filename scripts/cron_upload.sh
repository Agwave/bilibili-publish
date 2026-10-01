#!/usr/bin/env bash
# cron 包装脚本：把 game-wind 当天生成的日报视频自动投稿到 B站
#
# 排在 game-wind 的出片任务（每天 8:10）之后运行。做三件事：
#   1. 找 node —— cron 不加载 shell 配置，PATH 里没有 nvm，必须自己找绝对路径；
#   2. 等视频 —— 出片可能还没跑完，等一会儿而不是直接失败；
#   3. 幂等 —— 已投过的日期直接退出，避免重复投稿。
#
# 日志默认追加到 logs/cron.log。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$ROOT/logs/cron.log"
mkdir -p "$ROOT/logs"

log() { printf '%s [bilibili-publish] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# 写日志的同时也在终端可见（手动跑的时候方便）
run() { log "$*"; }

find_node() {
  local c newest
  # nvm 下可能装了多个版本，取版本号最大的那个（按字典序会挑错，别用）
  newest="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
  [ -n "$newest" ] && [ -x "$newest" ] && { printf '%s' "$newest"; return 0; }
  for c in /usr/local/bin/node /usr/bin/node; do
    [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  command -v node 2>/dev/null
}

NODE="$(find_node)"
if [ -z "${NODE:-}" ]; then
  run "找不到 node，退出"
  exit 1
fi
run "node: $NODE"

GW="$("$NODE" -e "process.stdout.write(require('$ROOT/config.json').gamewindPath)" 2>/dev/null)"
if [ -z "${GW:-}" ] || [ ! -d "$GW" ]; then
  run "game-wind 路径无效：${GW:-<空>}，退出"
  exit 1
fi

DATE="$("$NODE" -e "process.stdout.write(require('$ROOT/src/gamewind').latestDate('$GW')||'')" 2>/dev/null)"
if [ -z "${DATE:-}" ]; then
  run "推导不出日期，退出"
  exit 1
fi

VIDEO="$GW/data/videos/$DATE.mp4"
PUBLISHED="$GW/data/videos/$DATE.publish.json"

if [ -f "$PUBLISHED" ]; then
  run "$DATE 已经有投稿记录，跳过（要重投请删掉 $PUBLISHED）"
  exit 0
fi

# 等出片。game-wind 的 make_video.sh 里有 flock，同一时刻只会有一个出片任务。
WAIT_SECS="${WAIT_SECS:-600}"
waited=0
while [ ! -f "$VIDEO" ]; do
  if [ "$waited" -ge "$WAIT_SECS" ]; then
    run "等了 $((WAIT_SECS / 60)) 分钟仍没有 $VIDEO，放弃本次投稿"
    exit 1
  fi
  [ "$waited" -eq 0 ] && run "等 $DATE.mp4 生成……"
  sleep 30
  waited=$((waited + 30))
done
run "视频就绪：$VIDEO ($(du -h "$VIDEO" | cut -f1))"

# 投稿。默认就是真投（--dry-run 只在手动调试时用）。
# 输出直接走 stdout，由 crontab 那条统一重定向进 logs/cron.log（和 game-wind 的做法一致）。
"$NODE" "$ROOT/cli.js" upload --date "$DATE"
code=$?

if [ "$code" -eq 0 ]; then
  bvid="$("$NODE" -e "try{process.stdout.write(require('$GW/data/videos/$DATE.publish.json').bvid||'')}catch(e){}" 2>/dev/null)"
  run "$DATE 投稿成功${bvid:+，bvid=$bvid}"
else
  run "$DATE 投稿失败（退出码 $code），详见 $LOG"
fi
exit "$code"
