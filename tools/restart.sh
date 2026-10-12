#!/usr/bin/env bash
# 봇을 내리고 다시 띄운다.
#
# 터미널에서 띄운다. macOS 에서 launchd 로 띄우면 그 tmux 판은 ~/Documents 접근이
# 막힌다(EPERM). 작업 폴더가 거기 있으면 그대로는 못 쓴다.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${AGENT_BRIDGE_LOG:-$REPO/agent-bridge.log}"
LOCK="$REPO/.spool/bot.lock"

for name in $(tmux ls -F '#{session_name}' 2>/dev/null); do
  if tmux capture-pane -p -t "=$name:" -S -0 2>/dev/null | grep -qiE 'esc to interrupt|Working \('; then
    echo "⚠️  $name 이 작업 중이다. 지금 내리면 그 턴의 답장은 채널에 안 갈 수 있다."
  fi
done

# 이 저장소의 봇만 내린다. 이름으로 찾으면 같은 방식으로 띄운 다른 node 앱까지 죽는다.
old=$(cat "$LOCK" 2>/dev/null)
if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
  kill "$old"
  for _ in $(seq 10); do kill -0 "$old" 2>/dev/null || break; sleep 1; done
  echo "이전 봇을 내렸다 (PID $old)"
fi

cd "$REPO" || exit 1
if [ ! -d node_modules/dotenv ]; then
  echo "node_modules 가 없다. 깐다…"
  npm ci --silent || { echo "npm ci 실패"; exit 1; }
fi
echo "--- 봇 시작 $(date '+%F %T')" >> "$LOG"
nohup node src/index.js >> "$LOG" 2>&1 &
sleep 5
pid=$(cat "$LOCK" 2>/dev/null)
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  echo "떴다 (PID $pid, 로그 $LOG)"
else
  echo "안 뜬다. tail $LOG 를 봐라"
  exit 1
fi
