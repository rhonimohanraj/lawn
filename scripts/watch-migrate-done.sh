#!/usr/bin/env bash
# watch-migrate-done.sh
#
# Polls for the lawn-migrate sentinel file. When it appears, fires a
# Telegram/iMessage ping via notify.sh on a1 and exits.
#
# Usage:
#   nohup bash watch-migrate-done.sh > /tmp/lawn-migrate-watch.log 2>&1 &
# Or one-shot:
#   bash watch-migrate-done.sh

set -u

SENTINEL="$HOME/Empire/TEG/_shared/Tools/lawn/.lawn-migrate-done"
INTERVAL_SEC=600   # 10 min

# Same Claude Code session ID Rhoni can paste back to resume:
SESSION_ID="30935d42-2189-4cdb-872f-38268130343d"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

log "watcher started — sentinel=$SENTINEL interval=${INTERVAL_SEC}s"

while true; do
  if [[ -f "$SENTINEL" ]]; then
    payload="$(head -c 800 "$SENTINEL" 2>/dev/null || echo '<unreadable>')"
    log "sentinel found"
    log "payload: $payload"

    msg="lawn-migrate complete on Frame. Sentinel: $SENTINEL — $payload — Resume Claude session $SESSION_ID and say 'migration done, run the consolidation' to kick off restructureFrameio sequence."

    # Try notify.sh on a1 (Telegram bridge per memory). Fall back to local
    # AppleScript notification + voice if SSH fails so Rhoni still hears it.
    if ssh -o BatchMode=yes -o ConnectTimeout=10 a1 "bash /home/ubuntu/Scripts/notify.sh \"$msg\"" 2>>/tmp/lawn-migrate-watch.log; then
      log "notify.sh sent"
    else
      log "notify.sh FAILED — falling back to local notification"
      osascript -e "display notification \"lawn-migrate complete — resume Frame consolidation\" with title \"Frame migration done\" sound name \"Glass\"" || true
      say "lawn migrate complete. Resume Frame consolidation." || true
    fi

    log "exiting cleanly"
    exit 0
  fi
  sleep "$INTERVAL_SEC"
done
