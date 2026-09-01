# First-Run Setup

Status: DONE (2026-09-01)

Do the tasks below one time in each new sandbox. Do them in order. When all tasks are complete:

1. Write a short result under each task, in its **Result** line.
2. Change the status line above to `Status: DONE (YYYY-MM-DD)`. Use today's date.

If a task fails, do not mark the file as done. Write the error in the task's **Result** line and tell the user.

---

## Task 1 - Memories

Check if ".claude-memory" folder exists in this project. If not, create it. Your memories will be stored there. We may or may not add that to .gitignore depending on public/private status of this repository on GitHub. Ask user about it if you just created.

**Result:** Created `.claude-memory/` at the repo root. This folder is not yet a git repo, so the .gitignore question is on hold. Asked the user about public/private status.

## Task 2 — Prompt spellcheck

**Goal:** Claude Code underlines misspelled words in the prompt input.

1. Install the spell checker and the English dictionary:

   ```bash
   sudo apt-get install -y aspell aspell-en
   ```

2. Add this block to `~/.claude/settings.json`:

   ```json
   {
     "spellcheck": {
       "enabled": true
     }
   }
   ```

   **Caution:** This must go in the **user** settings file (`~/.claude/settings.json`). Claude Code ignores a `spellcheck` block in project or local settings. If the file already exists, merge the block into it — do not overwrite the other keys. A safe merge command:

   ```bash
   mkdir -p ~/.claude
   [ -f ~/.claude/settings.json ] || echo '{}' > ~/.claude/settings.json
   jq '.spellcheck = {"enabled": true}' ~/.claude/settings.json > ~/.claude/settings.json.tmp \
     && mv ~/.claude/settings.json.tmp ~/.claude/settings.json
   ```
3. Set Case-insensitive checking

Without this, lowercase `english` is flagged because the dictionary only
has `English`. The fix is one line in `~/.aspell.conf`:

```
ignore-case true
```

This personal config applies to every aspell run by this user, including
the Claude Code spellcheck process. With it, one lowercase entry in the
personal dictionary also covers all case forms.


4. Verify:

   ```bash
   command -v aspell            # must show a path
   jq .spellcheck ~/.claude/settings.json   # must show {"enabled": true}
   ```

   The underline shows after the next session restart.

   Note: aspell can do only one laguage, guide how to manually merge dictionaries is in

**Result:** Installed aspell and aspell-en. Added `spellcheck.enabled: true` to `~/.claude/settings.json`, other keys kept as is. Added `ignore-case true` to `~/.aspell.conf`. Verified with the commands above.

A prior sandbox merged a Czech dictionary into aspell, per `aspell-spellcheck.md`. That setup lives outside the project folder, so it did not survive this sandbox. Only the plain English setup from this task is in place now. Ask the user if they want the Czech merge redone.

## Task 3 - Status line

Install Calude code cli status line customization from statusline.sh - read that file, there are instructions inside.

**Result:** Added `statusLine` to `~/.claude/settings.json`, pointing to `bash /d/PROJECTS/urza/vrtti-editor/statusline.sh`. Tested with sample JSON input, output rendered correctly.

---

<!-- Add more tasks above this line. Keep the same structure: Goal, steps, verify, Result. -->
