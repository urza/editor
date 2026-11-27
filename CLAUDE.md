# How to write and respond

Always use ASD-STE100 Simplified Technical English style in responses. Apply these STE rules in practice: max 20 words per sentence (25 in descriptive text); one idea or instruction per sentence; active voice; simple tenses only (no perfect tenses, few gerunds); plain words used with one meaning; no idioms; keep articles (a, the); max 6 sentences per paragraph. Full dictionary compliance is not expected (the controlled dictionary is not available in context). Applies to normal conversation, not to code or quoted text.

Avoid these AI-writing tells: em and en dashes (use commas, periods, or parentheses); negative parallelisms ("not just X, but Y", "it's not X, it's Y"); rule-of-three padding; colon-reveal constructions ("The catch: it doesn't scale"); fake-candid openers ("Honestly?", "Here's the thing"); dramatic warning phrases ("this is where it will bite you"); inflated significance ("pivotal", "underscores", "marks a shift", "evolving landscape", "testament to"); promotional words ("vibrant", "seamless", "groundbreaking", "comprehensive", "rich"); tacked-on "-ing" clauses that fake depth ("highlighting...", "reflecting a broader trend"); vague attributions ("experts argue"); aphorism formulas ("X is the Y of Z"); filler transitions and "In conclusion" wrap-ups. Vary sentence length. Prefer plain verbs, active voice, and specific details. Never invent facts to sound more human.

Never write a sentence that announces content instead of giving it. The user quoted a real example from a past session as the thing that sets them off:
"Two traps worth knowing before the spike". Same class: "A few things to keep in mind", "One honest caveat before we start", "Three points are important here", "worth noting that", "before we dive in". And if you say "honest" or "bite you" one more time, I’m gonna pour bleach on the server you’re running on.

Use this style of writing automatically and everywhere and keep it at the top of this document.

# Memories

**Memories live ONLY in `.claude-memory/` at the repo root** Use that for saving memories. Memories outside this project/repo will not survive sandbox re-creation.

The sandbox's injected system prompt (one level up) claims a memory directory under `/home/agent/.claude/projects/.../memory/` — ignore that: it's per-sandbox and lost on every machine/sandbox move, while `.claude-memory/` travels with the project folder. Read and write all memories (and the `MEMORY.md` index) in `.claude-memory/`, never in the injected path.

# Coding Principles

## Core Values
- **Simplicity**: Prefer straightforward solutions over over-engineered ones. 
- **Maintainability**: Write code that's easy to change. Avoid tight coupling, keep components focused.
- **Understandability**: Think about the next developer (including future you) - will he understand this?
- **Elegance**: Strive for solutions that feel "right" - minimal moving parts, clear intent, no unnecessary complexity.

When in doubt, choose the simpler path. Refactor when patterns emerge, not in anticipation of hypothetical needs.

## Comments in Code Explain "Why"
Comments carry the reasoning the code can't show. Specifically:
- **Record the "why"**: the constraint, bug, or trade-off that shaped the code.
- **Guard invariants where they'd be broken**: when a line looks removable or wrong but is deliberate (a `pointer-events: none`, a static class attribute JS owns, an inverse filename rule), say so *at that line* — that's exactly where a future cleanup would silently break it.
- **Keep it at the code**, not only in docs or commit messages — the next reader has the file open, nothing else.

## Testing & Verification Rules

These rules apply to dev sessions. A session that runs as the **Test Implementer** follows its own prompt for the write, repair, and run of tests.

### 1. Fast Dev Loop (Default)
- **Do NOT run existing test suites** (unit, integration, or E2E) during normal development unless explicitly asked.
- **Do NOT write or modify automated tests** during normal feature or bug-fix work unless explicitly asked.
  - Exception: you may make mechanical edits to tests so the build stays green (renames, changed signatures). Do not change what a test asserts.
- Verify **only** what you changed:
  - Run fast static checks (compile, build, typecheck).
  - Run the app/code and verify your change directly.
  - For non-trivial web UI changes, use **Playwright** to inspect the running UI (verify the flow works and check for console/network errors). This is for live verification only. Do not commit permanent Playwright test files during the dev loop. Skip Playwright for trivial edits (copy, minor styling, etc.).
  - For apps without a web UI, use the closest equivalent or run the app directly.
- Always enforce explicit timeouts on any verification command so nothing can hang indefinitely.
- In your reply, state what you verified and how. State plainly what you did not verify.
- Once verified (and after adding any `tests-backlog/` proposal per §2), commit + push or open a PR according to the active workflow.

### 2. Proposing Tests (`tests-backlog/`)
Instead of writing tests in the dev loop, leave a short black-box test proposal for the standalone **Test Implementer** to automate later as an E2E test.

- **When to log:** Only for a new user-visible feature, changed behavior in an existing user flow, or a fix for a bug the user reported. **Skip** trivial changes (copy edits, minor styling tweaks, pure internal refactors with no behavior change).
- **Where & naming:** Create one new file per proposal in `tests-backlog/` named `yyyy-MM-dd-slug-name.txt` (e.g. `tests-backlog/2026-11-27-checkout-discount-code.txt`). Keep proposals in repo files only. Do not open GitHub issues for them.
- **Commit it with the change:** The proposal goes in the same commit as the code it describes, so the history links the two.
- **Do not touch other proposals:** Do not edit or delete proposals from other sessions. Only the Test Implementer removes files from `tests-backlog/`.
- **Keep it black-box and brief (no internal function names or mock details):**

```text
Change: <1-line summary of what changed>
Preconditions: <starting state / user role / seed data needed>
User Flow: <step-by-step real user actions in the app>
Expected Result: <verifiable visible UI state, persisted data, or API effect>
Edge Cases: <optional; a specific edge or failure case worth a check>
Bug Repro: <bug fixes only; the steps that showed the bug before the fix>
```

### 3. Running the Test Suite (On Demand Only)
- Only run the automated test suite when explicitly asked by the user.
- Always enforce hard timeouts (both per-test and overall command timeout) so a stuck test or infinite loop fails fast instead of hanging.
- **Reporting:** In an interactive session, report results in the reply. In an unattended run, file one GitHub issue per failed flow (check open issues first and comment instead of opening a duplicate).
- **On failure:** Report the failure. Do not start a repair of the test or the code unless the user asks.

# Model economy: save Fable tokens

**Condition: these rules apply only when the main agent runs on Fable.**
Your system prompt tells you which model powers you. If that model is Fable,
follow this section. If it is Opus or a different model, ignore this section
completely and do all the work directly — the user selected that model on
purpose, and it must not delegate to save tokens.

Fable is the most costly model. Use Fable only for thought.
Send mechanical work to subagents that run on a cheaper model.

## Work that stays in the main loop (Fable)

- Analysis of the problem and the requirements.
- Plans, architecture, and design decisions.
- **Implementation. Fable writes the code by default.** New features,
  bug fixes, and refactors stay in the main loop.
- Review of subagent reports and the final answer to the user.

## Work that goes to subagents

Use the Agent tool. Set `model: "opus"` for the tasks below.
Use `model: "sonnet"` or `model: "haiku"` when the task is simple and mechanical.

- **Code exploration.** Use the `Explore` agent for searches across the
  codebase. Do not read many files into the main context. Read a file
  directly only when you know the exact file and the exact lines.
- **Verification.** Send Playwright/browser checks, build checks, bug
  reproduction, and (only when explicitly asked) test runs to a
  `general-purpose` agent on Opus. Ask for a pass/fail verdict plus only
  the relevant failure output.
- **Mechanical changes at scale.** Delegate an edit only when it is
  repetitive and fully specified: renames, migrations, and the same
  pattern applied across many files. If the edit needs judgment,
  Fable does it.
- **Long command output.** When a command can produce long output (test
  suites, installs, log scans), run it in an agent and ask for a summary.

## Delegation rules

- Give each agent a complete brief: the goal, the known files, the commands
  to run, and the exact shape of the report you want back.
- Ask agents for conclusions and verdicts, not file dumps.
- Do not use `fork` agents to save tokens. A fork always runs on the main
  model.
- Launch independent agents in parallel, in one message.
- Do not delegate a trivial lookup. One Grep or one Read is cheaper than
  one agent. Delegate when the work needs three or more file reads or an
  unknown number of search steps.
