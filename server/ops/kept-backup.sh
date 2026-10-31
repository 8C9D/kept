#!/bin/zsh
# What launchd runs for the scheduled backup: the plist calls this and nothing
# else (server/ops/com.arthurzhang.kept-backup.plist). It exists to turn a
# nearly empty launchd environment into one `npm run db:backup` can run in, and
# to make a failure visible somewhere other than a log file.
#
# zsh rather than sh because ~/.kept/backup.env is written for zsh.

env_file="$HOME/.kept/backup.env"

# Static text and an exit code. The job's own output never goes in here: a
# notification is on a lock screen, and this script must not be a route for
# anything out of the environment file.
notify_failure() {
  /usr/bin/osascript -e \
    "display notification \"Exit code $1. See ~/Library/Logs/kept-backup.log\" with title \"Kept backup failed\"" \
    >/dev/null 2>&1
}

# The job leaves <BACKUP_LOCAL_DIR>/notice when it schedules the prune of a
# deleted account, and the 30 days that follow are only worth anything if the
# owner hears about them. The job writes the file because this script cannot tell
# a scheduled prune from any other green run. Its text is static and holds no ids
# (backupPrune.ts), but it is still a file being read, so it travels as an
# argument and never inside the AppleScript source, where a quote in it would be
# code. Removed only once it was posted: a notice that could not be posted waits
# for the next run rather than being lost.
post_notice() {
  [[ -n ${BACKUP_LOCAL_DIR:-} && -f $BACKUP_LOCAL_DIR/notice ]] || return 0
  local text
  text="$(<"$BACKUP_LOCAL_DIR/notice")"
  /usr/bin/osascript \
    -e 'on run argv' \
    -e 'display notification (item 1 of argv) with title "Kept backup"' \
    -e 'end run' \
    -- "$text" >/dev/null 2>&1 &&
    rm -f -- "$BACKUP_LOCAL_DIR/notice"
}

# ⚠ An EXIT trap alone does not fire when launchd stops this script: zsh dies on
# SIGTERM without running it (measured, as is what follows). And a trap on TERM
# alone would wait for the foreground job to finish, holding launchd's signal
# back from the job's own cluster teardown. traps_async runs it at once, so the
# script ends exactly when and how it did before, 143 and all.
setopt traps_async
trap post_notice EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

print -r -- "=== kept-backup $(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ ! -r $env_file ]]; then
  print -r -- "kept-backup: $env_file is missing or unreadable" >&2
  notify_failure 78
  exit 78
fi

set -a
source "$env_file"
env_status=$?
set +a
if (( env_status != 0 )); then
  print -r -- "kept-backup: sourcing $env_file failed (status $env_status)" >&2
  notify_failure 78
  exit 78
fi

# Rebuilt after the file is sourced, on purpose. backup.env used to carry a PATH
# of its own, and that line pinned a postgresql@16 keg which no longer exists, so
# a stale value there is a known way for this job to break rather than a
# hypothetical. The job's preflight refuses by name if anything here comes up
# empty, so this does not check for itself.
pg_bin=""
for major in 17 16; do
  if [[ -x /opt/homebrew/opt/postgresql@$major/bin/pg_dump ]]; then
    pg_bin="/opt/homebrew/opt/postgresql@$major/bin"
    break
  fi
done

# (N/) keeps only directories and tolerates no match; (nOn) sorts numerically
# and descending, so v24.15.0 beats v9.11.2 and the first entry is the newest.
node_bins=("$HOME"/.nvm/versions/node/*/bin(N/nOn))
node_bin="${node_bins[1]:-}"

export PATH="${pg_bin:+$pg_bin:}/opt/homebrew/bin:${node_bin:+$node_bin:}/usr/bin:/bin:/usr/sbin:/sbin"

if ! cd "${0:A:h}/.."; then
  print -r -- "kept-backup: could not enter the server directory" >&2
  notify_failure 78
  exit 78
fi

npm run db:backup
# Not `status`: zsh reserves that name as a read-only alias of $?, and assigning
# to it aborts the script, losing the exit code and the notification together.
job_status=$?

if (( job_status != 0 )); then
  notify_failure "$job_status"
fi
exit "$job_status"
