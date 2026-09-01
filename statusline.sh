#!/usr/bin/env bash
  # Claude Code status line: "MyProject > main > Fable 5 (max) > 42% cntx"
  #
  # Reads the JSON snapshot Claude Code pipes on stdin. Segments that have no data
  # (not a git repo, no effort field, no usage yet) drop out instead of showing
  # placeholders, so the line degrades to e.g. "MyProject > Fable 5".
  #
  # Reusable: copy this file anywhere and point settings.json at it:
  #   "statusLine": { "type": "command", "command": "bash /path/to/statusline.sh" }
  # Requires jq.

  input=$(cat)

  j() { printf '%s' "$input" | jq -r "$1"; }

  # ANSI colours. The escape byte comes from printf so this file stays plain text.
  esc=$(printf '\033')
  rst="$esc[0m"
  dim="$esc[2m"
  cyan="$esc[36m"
  green="$esc[32m"
  yellow="$esc[33m"
  red="$esc[31m"

  project=$(basename "$(j '.workspace.project_dir // .cwd // "?"')")

  # Branch of whatever directory the session is in - a linked worktree has its own
  # checked-out branch, so this covers "worktree info" too. Detached HEAD -> short SHA.
  dir=$(j '.workspace.current_dir // .workspace.project_dir // empty')
  branch=""
  if [ -n "$dir" ]; then
      branch=$(git -C "$dir" --no-optional-locks branch --show-current 2>/dev/null)
      [ -z "$branch" ] && branch=$(git -C "$dir" --no-optional-locks rev-parse --short HEAD 2>/dev/null)
  fi

  model=$(j '.model.display_name // "?"')
  # Docs-confirmed shape: effort is an object, {"level":"max"}; the whole key is
  # absent when the model does not support the effort parameter, so this renders
  # nothing rather than an empty bracket.
  effort=$(j '.effort.level // empty')
  pct=$(j '.context_window.used_percentage // empty')

  # Context segment turns yellow at 70% and red at 90%, on the same rounded value
  # that gets printed, so the colour never disagrees with the number.
  pctcol="$green"
  if [ -n "$pct" ]; then
      printf -v pctint '%.0f' "$pct"
      if [ "$pctint" -ge 90 ]; then
          pctcol="$red"
      elif [ "$pctint" -ge 70 ]; then
          pctcol="$yellow"
      fi
  fi

  sep="$dim > $rst"
  out="$cyan$project$rst"
  [ -n "$branch" ] && out="$out$sep$green$branch$rst"
  out="$out$sep$model"
  [ -n "$effort" ] && out="$out $dim($effort)$rst"
  [ -n "$pct" ] && out=$(printf '%s%s%s%.0f%%%s%s cntx%s' "$out" "$sep" "$pctcol" "$pct" "$rst" "$dim" "$rst")
  printf '%s' "$out"