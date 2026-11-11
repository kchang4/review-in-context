---
name: review-code-in-context
description: Review the checked-out pull request file by file in a browser view that shows each change inside its whole file, with what calls it and what it uses, a chat with Claude anchored to the line you click, and line comments posted back to the GitHub PR. Use for /review-code-in-context, "review this PR in context", or "--resume" to pick up an earlier review session.
---

# Review code in context

The reviewer has pulled a PR branch and wants to understand and review it. You prepare an analysis of every changed file, open a local page that shows it, then stay in the terminal answering the questions they ask from that page until they submit their review.

Everything mechanical is done by `rcc.mjs`, which sits next to this file. Call it as `node "<this skill's folder>/rcc.mjs" <command>`, shortened to `rcc` below. It needs Node 18 or newer and git. Never rewrite or re-implement it, and never edit `viewer.html`.

Sessions are saved outside the repository, under `~/.review-code-in-context/sessions/<id>/`, so nothing is added to the working tree and a review survives a closed terminal or a restart.

## Which mode

- `--resume` in the arguments: go to "Resuming".
- Otherwise start a new session at step 1. An optional argument is the base branch to compare against, for example `origin/main`.

## 1. First time in this repository: setup

Run `rcc config get`. If it prints `{}`, do this once, then continue:

1. Look at `git remote -v`. If the remote is GitHub, check `gh auth status`. If `gh` is missing or not signed in, tell the reviewer the review still works but comments will be saved to a file, and that running `gh auth login` themselves fixes it. If the remote is not GitHub, say that posting comments back is only supported for GitHub in this version.
2. Ask the reviewer what they use to track tasks (Jira, Linear, GitHub issues, something else, or nothing) and whether you already have a way to read it here (an MCP server or a signed-in CLI). If you do, use it later for context. If not, carry on without it.
3. Save the answers: `rcc config set prHost github`, `rcc config set tracker jira`, `rcc config set trackerAccess "<how you read it, or none>"`.

Never ask the reviewer to paste a token or password into the chat, and never store credentials. Signing in is something they do themselves with the tool's own login command.

## 2. Start the session

Run `rcc skeleton [base]`. It works out the base, creates the session, and prints every changed file with its changes and their line ranges. Files marked "not shown" (lock files, generated files, binaries) need no analysis.

If it prints a NOTE about earlier unfinished sessions, mention it in one line and carry on with the new one unless the reviewer says to resume.

## 2b. Read what has already been said

**On the PR.** Run `rcc comments`. It prints the PR conversation, review summaries and every line comment, whoever wrote them. Use them:

- If a reviewer already raised something you would flag, say so in that change's note instead of presenting it as new.
- If a question on the PR is answered by the code, say where.
- Comments marked as on an older version of the code may no longer apply; check before relying on them.

The page shows the same comments on their lines and in its "On the PR" tab, and the reviewer can refresh them there at any time.

**Tickets.** Find the ticket key in the branch name, PR title or PR description. You want the whole chain: the engineering task, its story, and the epic, each with its description, comments and attachments. Decisions are often made in ticket comments and never copied into the description, so read the comments.

- Try `rcc jira <KEY>` first. It reads Jira directly when `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN` are set in the shell, climbs from the task to its parents, and downloads attachments.
- If it prints `NO_JIRA_ENV`, or the tracker is not Jira, use whatever access you have (an MCP server or a signed-in CLI). For each ticket in the chain, run `rcc tickets path <KEY>` to get its folder, write `ticket.json` there in the shape below, and save any attachments you can download into that folder's `files/` subfolder. Then run `rcc tickets set <EPIC> <STORY> <TASK>`, outermost first.
- If you cannot read the tracker at all, say so in one line and carry on without it.

```json
{ "key": "ORG-223", "type": "Task", "summary": "…", "status": "In review", "url": "https://…/browse/ORG-223",
  "description": "plain text", "parent": "ORG-220",
  "comments": [ { "author": "Dana", "at": "2026-11-08T12:00:00Z", "body": "plain text" } ],
  "attachments": [ { "name": "design.png", "mime": "image/png", "file": "name of the saved file in files/, or null if not downloaded" } ] }
```

Tickets are stored once, in a shared folder, and every session that links a ticket reads that same copy. Never keep a private copy inside a session. Because the copy is shared it must be kept fresh: fetch the chain again at the start of every session and on every resume, even when another session already saved it, and again whenever `rcc tickets` marks a ticket STALE (older than 30 minutes) and you are about to rely on it. Fetching overwrites the shared copy, so every session sees the newer version.

Then run `rcc tickets`. It prints the whole chain, when each ticket was last fetched, and the local path of every downloaded attachment. Open the images and documents with your file-reading tool and actually look at them: designs, screenshots and diagrams often show what "done" means better than the text. Say which attachments you could not open.

Use all of this as context for "before and after" and for flags. Where the code and a ticket disagree, show the disagreement in the change's note and do not pick a side.

## 3. Analyse and write annotations.json

Write `annotations.json` in the session folder that `skeleton` printed. This is the part only you can do. Read the code; do not guess.

For each shown file, and for each change in it (in the same order `skeleton` listed them):

- **What starts this code**: who calls the changed function, method, type or config. Search the whole repository, not only the diff. Prefer a language-aware lookup (a language server or the compiler's find-references) when one is available; otherwise search by name and read each hit to confirm it is a real use. For a deleted file, this is everything that still points at it.
- **What this code uses**: what the changed lines call or depend on that is defined elsewhere.
- **Flags**: things a diff view hides. A caller that was not updated to match a changed signature. A safety or permission check that exists and is not used. Something still pointing at deleted code. Behaviour that differs between old and new. Mark these `"attention": true` on the entity and `"level": "attention"` on the change, and say plainly what the problem is and where.
- **Before and after**, in one or two plain sentences each, for every change and once more for the file as a whole.

Rules:

- Every snippet is copied from the real file, with its real starting line number. Never write code from memory.
- If you looked and found no callers, use an empty list. The page then says "None found". Do not invent one.
- Say when something is inferred, for example a link read from infrastructure config rather than a function call.
- Plain language. A reviewer who has never seen this code should understand each sentence.
- Keep cards short: `name` is the thing, `sub` is a few words on how this PR relates to it.

Shape of the file:

```json
{
  "pr": { "title": "optional override", "summary": "one or two sentences on what the PR does" },
  "entities": {
    "someId": {
      "name": "ExportJob.finish()",
      "sub": "Older caller · not updated to match",
      "what": "What it does, one or two sentences.",
      "status": "How this PR relates to it.",
      "where": "src/exports/exportJob.ts, line 77",
      "snippet": { "label": "Where it calls markDone()", "start": 75, "highlight": 77, "lines": ["line 75 text", "line 76 text", "line 77 text"] },
      "signature": "async finish(jobId: string): Promise<void>",
      "inPr": false, "attention": true, "external": false,
      "file": "path of the changed file it lives in, only if it is one of the PR's files"
    }
  },
  "files": {
    "src/jobs/jobStore.ts": {
      "summary": "One sentence on what changed in this file.",
      "before": "The file as a whole, before.",
      "after": "The file as a whole, after.",
      "flow": [ { "label": "Lambda handler", "note": "you are here", "state": "here" } ],
      "types": [ { "name": "JobStatus", "def": "type JobStatus = ...", "where": "src/jobs/types.ts:3", "note": "optional" } ],
      "refs": [ { "line": 27, "text": "this.set", "id": "someId" }, { "line": 8, "text": "JobKind", "types": true } ],
      "changes": [
        { "title": "markDone()", "level": "attention", "note": "The flag or remark, if any.", "before": "...", "after": "...", "starts": ["someId"], "uses": ["otherId"] }
      ]
    }
  }
}
```

- `flow` is required for every file: it fills the "Where this code sits" strip at the top of the page. Give three to six steps in the order things happen at run time (what triggers this code, this file, what it hands off to), with exactly one step for this file marked `"state": "here"`. `state` is one of `here`, `changed` (another file in this PR), `unchanged`, `external`. For a file with no run-time path (config, types, docs, tests), describe what reads or depends on it instead, for example build → this config → the Lambda that loads it. `rcc build` warns about any file without one.
- `refs` make a name in the code clickable. `line` is the new line number (the old one for a deleted file) and `text` must appear on that line.
- `level` is `attention`, `ok`, or left out.
- `types` are the type definitions a reader needs for this file, copied from the code.

For a large PR, annotate the files in order and run steps 4 and 5 after the first batch so the reviewer can begin; running `rcc build` and `rcc start` again later refreshes the page with the rest.

## 4. Build

Run `rcc build`. If it lists problems (an unknown id, a ref whose text is not on that line, a change count that does not match), fix `annotations.json` and build again until it is clean.

## 5. Open the review

Run `rcc start`. It starts a small local server, opens the browser, and prints the address. Tell the reviewer in two or three sentences what the PR does and how many files have flags, then say the page is open and you are listening for questions.

## 6. Listen and answer

Loop:

1. Run `rcc wait 270` with the shell tool's timeout set to 300000 ms. It blocks until something happens. Keep the wait under five minutes: a longer pause can let the prompt cache expire, and then every wake-up re-reads the whole conversation at full price.
2. `IDLE`: nothing was asked. Run it again.
3. `QUESTION <id>`: the output gives what the reviewer clicked (file, line, change or card), the code around it, anything already said on that line in the PR, and what they wrote. If they ask you to fetch the tickets or PR comments again, rerun `rcc jira <KEY>` (or your own fetch) or `rcc comments` and say what is new. Investigate in the repository as needed, then answer with
   ```
   rcc reply <id> <<'EOF'
   your answer
   EOF
   ```
   The `reply` command sends the answer and then keeps listening by itself: it blocks like `wait 270` and prints the next `IDLE`, `QUESTION`, `PAUSED` or `FINISHED`. Run it with the same 300000 ms timeout and handle its output exactly as in this list. Never end your turn after answering: the reviewer can only ask one question at a time and the page stays locked until you are listening again.
4. `PAUSED`: the reviewer pressed "Pause session" on the page because they are stepping away. Run `rcc stop`, stop looping, and tell them in one line that everything is saved and `/review-code-in-context --resume` picks it up. Do not post or summarise anything.
5. `FINISHED`: the reviewer submitted the review. Report what happened (the review link, or the file the review was saved to), run `rcc stop`, and stop looping.

Answering:

- The click tells you what they mean. Do not ask them to repeat the file or line.
- Lead with the answer. Two to six sentences is usual. Name files and lines so they can go there.
- If you are not sure, say so and say what you checked.
- If they propose a change, check it against the code first, and tell them if it would break something or is already handled.
- Answers are shown as plain text; backticks for code are fine.

Posting to GitHub happens only when the reviewer presses Submit in the page. Never post, approve, or request changes with `gh` yourself, even if asked in the chat; point them to the Review tab.

## Resuming

1. Run `rcc sessions`. It lists every session, newest first, with when it was started and last used, the repository and branch, and progress.
2. If exactly one session belongs to this repository and is not submitted, resume it. Otherwise show the list as printed and ask which one.
3. Run `rcc resume <id>`. Read out any NOTE or WARNING it prints (for example that the branch has moved since the session started).
4. Read the session's `annotations.json` to get your earlier analysis back, and run `rcc history` to read the earlier conversation, the reviewer's draft comments and which files they marked reviewed, since this terminal session may have no memory of them. Treat that conversation as already said: do not answer old questions again unless they are marked not answered. Then refresh what may have changed while you were away: run `rcc comments`, and fetch the linked tickets again as in step 2b. Tell the reviewer about anything new.
5. Tell the reviewer where they left off, then continue at step 6. Questions that were asked but never answered are delivered again by `rcc wait`.

If `resume` says the analysis was not finished, continue from step 3 using that session's `skeleton.json`.

## Where things are kept

```
~/.review-code-in-context/
  config.json                 per-repository setup answers
  sessions/<id>/              one review of one PR at one commit
    meta.json                 repository, branch, PR, commit, linked ticket keys, progress
    skeleton.json             the diff, as files, lines and changes
    annotations.json          your analysis
    data.json                 the two merged, as shown in the page
    state.json                files marked reviewed, draft comments, the conversation
    pr-comments.json          the last copy of what is on the PR
  tickets/<KEY>/              one folder per ticket, shared by every session that links it
    ticket.json, files/
```

Tickets are stored once and linked from sessions, so two reviews under the same story or epic share them. `rcc sessions`, `rcc tickets` and `rcc resume` report other sessions that share a ticket with the current one. When they do, tell the reviewer in one line, and read the related session's `annotations.json` if it helps you explain how the two PRs fit together.

## Limits to state honestly

- Caller and usage tracing is only as good as the search. In dynamically typed code, say when a link is a best guess.
- GitHub accepts line comments only on changed lines and a few lines around them. Comments elsewhere are added to the review summary with their file and line; the page says so when the reviewer writes one.
- The page shows the commit that was checked out when the session started. New commits need a new session.
- Images pasted into GitHub comments are shown as links, not inline. Ticket attachments over 20 MB are not downloaded.
