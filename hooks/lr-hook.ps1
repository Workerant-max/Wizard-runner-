# Library Runner hook for Claude Code (Windows).
# Claude Code pipes one JSON event on stdin; we append it as one line for the extension to read.
$ErrorActionPreference = 'SilentlyContinue'
$raw = [Console]::In.ReadToEnd()
$line = ($raw -replace "`r?`n", ' ').Trim()
if ($line) {
  $dir = Join-Path $env:USERPROFILE '.library-runner'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  [IO.File]::AppendAllText((Join-Path $dir 'events.jsonl'), $line + "`n", (New-Object Text.UTF8Encoding $false))
}
exit 0
