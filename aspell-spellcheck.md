# Claude Code spellcheck: merged Czech + English aspell dictionary

Setup date: 2026-08-21. System: Ubuntu in WSL2.

Claude Code underlines misspelled words in the prompt input. It spawns one
aspell process per session, roughly: `aspell -a --encoding=utf-8
--sug-mode=ultra --lang=cs`. The language comes from `~/.claude/settings.json`:

```json
"spellcheck": { "enabled": true, "language": "cs" }
```

Aspell checks against one language at a time. To accept both Czech and
English, we compiled the English wordlist as a Czech-format dictionary and
added it to the `cs` dictionary chain.

## How the merge was done

1. Dump the full English wordlist (all affix forms expanded):

   ```bash
   aspell -d en dump master | aspell -l en expand | tr ' ' '\n' \
     | grep -v '^$' | sort -u > en.txt
   ```

2. The Czech language definition rejects the apostrophe character. Words
   like `isn't` would fail to compile. Fix: split them on `'` and add the
   fragments (`isn`, `t`) as separate words. Aspell tokenizes the same way
   at check time, so `isn't` passes:

   ```bash
   grep "'" en.txt | tr "'" '\n' | grep -v '^$' | sort -u > frags.txt
   grep -v "'" en.txt | cat - frags.txt | sort -u > en2.txt
   ```

3. Compile the wordlist as a Czech-format master dictionary:

   ```bash
   aspell --lang=cs --encoding=utf-8 create master ./en-as-cs.rws < en2.txt
   ```

4. Install it and extend the `cs` dictionary chain (needs sudo):

   ```bash
   sudo cp en-as-cs.rws /usr/lib/aspell/
   sudo cp /usr/lib/aspell/cs.multi /usr/lib/aspell/cs.multi.orig   # backup
   printf 'add cs.rws\nadd en-as-cs.rws\n' | sudo tee /usr/lib/aspell/cs.multi
   ```

5. Restart the Claude Code session. The old aspell process keeps the old
   dictionaries until then.

Result: `/usr/lib/aspell/cs.multi` now contains:

```
add cs.rws
add en-as-cs.rws
```

The original file is saved as `/usr/lib/aspell/cs.multi.orig`.

## Custom words (personal dictionary)

Aspell reads a personal wordlist for the active language. For `cs` it is
`~/.aspell.cs.pws`. Create it with a header line, then one word per line:

```
personal_ws-1.1 cs 0
mycustomword
anotherword
```

You can also add a word from the shell:

```bash
echo -e "*newword\n#" | aspell -a --lang=cs --encoding=utf-8
```

The `*` adds the word, the `#` saves the file. Restart the session after a
change.

## Case-insensitive checking

Without this, lowercase `english` is flagged because the dictionary only
has `English`. The fix is one line in `~/.aspell.conf` (applied 2026-08-21):

```
ignore-case true
```

This personal config applies to every aspell run by this user, including
the Claude Code spellcheck process. With it, one lowercase entry in the
personal dictionary also covers all case forms.

## Maintenance notes

- An `apt upgrade` of the `aspell-cs` package can overwrite
  `/usr/lib/aspell/cs.multi`. If English words turn red again, re-apply
  step 4 above. The compiled `en-as-cs.rws` is not owned by any package,
  so it survives upgrades.
- To undo the merge: `sudo cp /usr/lib/aspell/cs.multi.orig /usr/lib/aspell/cs.multi`.
- Any change (dictionary, personal words, config) needs a session restart,
  because the aspell process is spawned once at session start.
- Quick test from the shell (should print only `qqqzz`):

  ```bash
  printf 'ahoj česky hello english qqqzz\n' | aspell list --lang=cs --encoding=utf-8
  ```
