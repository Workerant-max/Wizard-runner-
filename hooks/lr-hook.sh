#!/bin/sh
# Library Runner hook for Claude Code (macOS / Linux).
# Claude Code pipes one JSON event on stdin; we append it as one line for the extension to read.
dir="$HOME/.library-runner"
mkdir -p "$dir"
line=$(tr -d '\r\n')
[ -n "$line" ] && printf '%s\n' "$line" >> "$dir/events.jsonl"
exit 0
