# Working in this repo

Notes for anyone changing this code with a coding agent. Every line under Traps prevented a real
mistake, most of them mistakes already made in this codebase.

**When a correction applies beyond the task at hand, add it here as a rule before moving on.** If
a rule stops being true, delete it.

---

## Commands you cannot guess

```
npm run dev                   # http://localhost:4820, embedded database, no setup
npm test                      # schema + server, fast, no database needed. Run before every push.
npx tsc --noEmit -p server    # there is no linter
npx tsc --noEmit -p packages/schema   # CI runs this one too
npm run demo:build            # rebuilds the hosted demo in docs/ after a client or demo change
npm run prompts:snap -w @haii/server   # BEFORE editing a prompt: baseline what the model is told
npm run prompts:check -w @haii/server  # AFTER: section-by-section diff of what changed
```

**Snapshot before you edit a prompt, or the diff harness has nothing to compare against.** Stop the
dev server first, or give the harness its own database for both commands:
`DATA_DIR=.data-promptdiff npm run prompts:snap -w @haii/server` (bash syntax). If the dev server
holds the database, the harness prints a line naming the lock and exits. It diffs the assembled
PROMPT, not model output; it cannot tell you a change was *good*, only that it happened.

**The demo is the real client on canned answers.** `server/public/demo.js` answers every API call
in the browser when the address carries `?demo`. `demo.test.ts` holds every quote in the demo to the
verbatim rule and walks every path the client calls, so add an answer to `demo.js` when you add a
route the client calls.

---

## Rules that get assumed wrong

**Cards come from what the user said, and nothing else.** Two sources. Meeting transcripts
(pasted, a Google Doc named like meeting notes, or a notetaker) go through `jobs/extract.ts`. The
user's own Slack messages go through `jobs/slackListen.ts` every four hours, which writes them as a
`transcripts` row with `source = 'slack'` and deletes any card whose quote fails
`lib/slackEvidence.ts`. Gmail, Jira, Confluence, Linear, Asana and the Slack messages `pollSlack`
reads become rows in `items`, which are context for briefs, never card sources. `items` in,
`transcripts` → `cards` out. (`POST /api/v1/cards/propose` is an admin tool that inserts cards a
caller already drafted. It does not run the quote check.)

**`executed` is not `approved`.** The line is **was the artifact created in a system OUTSIDE Haii**:
Slack post, Jira issue, calendar event, Gmail draft. A to-do lives in Haii's own table, so the work
is only remembered, and it is `captured`. The rule lives in `LEAVES_HAII` in `lib/metrics.ts`. When
a metric's prose and its table disagree, the table is the metric.

**`userId: ''` means system-wide**, not "missing", in `job_runs` and `llm_ledger`. Scheduled global
jobs use it; a manual trigger carries the caller's id.

**The server runs UTC by design.** Every user-facing "today" derives from `users.tz`. Never set `TZ`.

**A server-only deploy has no fingerprint unless you give it one.** `/healthz` reports `commit` from
the `COMMIT_SHA` environment variable, and `dev` when it is unset.

**Per-user budget caps must stay below the global ones** or the global cap binds first and pauses
everybody.

---

## Invariants

**Prompts are versioned and stamped onto every card.** Never edit `extract.vNNN` or `briefing.vNNN`
in place; add a file and bump. Rewriting history makes quality numbers meaningless. The first public
commit is the baseline for versioned prompts: every prompt file as it stands there is a version of record.

**The list of action types is closed.** Adding one is a product decision, not a convenience. It
means all of: `packages/schema` (enum + payload + PAYLOADS + Payload union), the executor switch,
`BLOCKED_CONNECTOR`, a NEW `extract.vNNN` (a type the extractor is never told about is never
proposed), and the structured-output schema inside that prompt file. Miss the prompt and nothing
breaks, it just silently never happens.

**Nothing sends without a gesture.** The decision endpoint refuses anything unrecognised rather than
defaulting to approve.

**A SWIPE MUST PRODUCE THE THING. Never an error the user has to go and fix.** If Haii can work out
an answer, it must, and then say what it did in the result the user sees, with undo intact. A
calendar time that has passed, a slot someone took, a payload with no usable time: all three have
the same answer, find the next open slot. Only report a failure when the OUTSIDE WORLD failed: the
connector is not connected, the provider is down, the API rejected us. **Watch for a guard whose
failure branch ends the interaction**, that is the shape every violation has taken.

**No card runs without a gesture, whoever wrote the text it came from.** Indirect prompt injection
is the primary threat here: a transcript is mostly other people's words, and any Google Doc the
account can open whose name looks like meeting notes is read as one (`TRANSCRIPT_NAME` in
`connectors/drive.ts`). Anything widening what text reaches the extractor is a security change, not
a feature.

**A quote is verbatim or it is not shown.** Extraction strips any quote it cannot find in the
transcript, and the practice card and the demo follow the same rule. Never fabricate evidence to
fill a slot.

**`lib/tz.ts` owns all timezone maths.** Every bug in this area has been a call site bypassing it.

**Users never see raw provider errors.** `recordFailure` splits the audiences: `detail` is the
banner, `operatorNote` is for whoever runs the instance.

**Never print secrets.** `ENCRYPTION_KEY` decrypts every stored connector token and cannot be
rotated, so it never goes in an image layer or a log.

**Claude is reached with the API key in `server/.env` and nothing else.** Anthropic does not allow an
app like this to run on a Claude subscription login, so do not add a second way in. With no key
set, `llmJson` returns `no_claude_key`, and the routes a person triggers turn that into one
sentence that says what to do (`lib/skipReason.ts`).

**Local mode has no login, so `lib/localRequest.ts` is the only gate on the automatic identity.**
It refuses a request another site made the browser send, and a request that arrives under a
foreign host name. Anything that acts for the user stays behind `requireUser`. Never read
`DEV_AUTOLOGIN` directly to decide who is asking.

---

## Traps

**A CSS rule you write is competing with one already there, and it usually loses.** Before adding a
rule inside an existing block, find what already matches that element and check you win on
specificity, not just on being written later.

**Never assert `el.hidden` to prove something is hidden.** A CSS `display` value beats the
attribute, so `hidden` stays true while the element sits on screen. Assert
`getComputedStyle(el).display` or `offsetHeight`, and pair any `display:` rule on a toggled element
with its own `[hidden]{display:none}`.

**A CSS animation outranks an inline style, and `fill-mode: both` never lets go.** A card with a
deal animation discarded the transform that drag writes: it sat still while the decision sent
anyway. Prefer `backwards`, and drop the class on `pointerdown`.

**A BACKTICK INSIDE A TEMPLATE LITERAL ENDS IT, including inside an HTML comment, and the wreckage
PARSES.** A comment inside an `innerHTML` template quoted a CSS selector in backticks. The first one
closed the string and the rest parsed as arithmetic on an undeclared variable, so the screen threw
on every render. It shipped because the only client check was `new vm.Script(...)`: **parsing is
not running.** `clientHtml.test.ts` now fails the build on a backtick in an HTML comment.

**An element updated live needs an id.** A class selector's target is chosen by the user's data:
`querySelector` returns the first match in document order, so which counter got written depended on
whether that user had failures or meetings that day. A plausible number in the wrong place reads as
correct.

**A migration array runs on EVERY boot, so never put a relative time window in one.**
`created_at < now() - interval '1 hour'` silently widens forever. Name the rows you mean with a
fixed timestamp.

**A window-level keyboard shortcut must ignore keystrokes from editable targets.** Guard the
handler, not the field, or the next input inherits the bug.

**Setting `innerHTML` resets `scrollTop` to zero, so a re-render IS a jump to the top.** Split fetch
from paint, keep the last payload, and capture and restore `scrollTop` around the assignment. A
screen with an input must not repaint under someone who is typing.

**A flag set by one event and checked by another will be missed.** When a check depends on server
state that changes asynchronously, run it wherever that state arrives, not only where it was
convenient to write.

**`offsetTop` is measured against the nearest POSITIONED ancestor, not the scroller.** Sum it up the
`offsetParent` chain.

**`overflow-x: clip` is downgraded to `hidden` on any element whose OTHER axis scrolls**, and
`hidden` leaves the element scrollable to script. The views are pinned in JS instead.

**A gesture with no affordance does not exist.** Before debugging why an interaction "does not
work", check whether a person could tell it exists.

**The live card is horizontal-only on purpose.** A thumb draws arcs, and no ratio separates a swipe
from a scroll. Several other designs were tried first. Changes near it want a very good reason.

**PGlite has ONE writer.** Stop the dev server before any script that opens the database. Never
delete `.data/.lock` to get a server started: it is the only thing stopping two writers, which IS
the corruption. Never hard-kill the server: that skips the exit handler that closes the database
cleanly. A corrupt directory is renamed aside, never deleted.

**The service worker falls back to the cached app shell for any path when the network fails.**
`sw.js` is network first, so a new file in `server/public` loads normally while the server is up.
With the server down, a missing file can still look like the app loaded, so check the server first.

**Google Drive's `contains` is prefix matching on `name`.** `name contains 'Notes by Gemini'` can
never match, because Gemini puts the phrase last. Filter in JS.

**Tightening a CSP breaks subresources SILENTLY.** A stricter policy killed a webfont: nothing
threw, the page rendered in a fallback and looked fine enough to ship. After any CSP change, ask
what the page PULLS, not whether it errors. And a wrong content type under `nosniff` means a file
that returns 200 and is still refused, so a test surface that is more permissive than the real
server manufactures confidence.

**Web Speech is a different product on every platform.** On Apple, `compact` in a `voiceURI` is a
namespace, not a quality grade, so a picker that penalised it demoted the good voices. Never
overrule `voice.default` without a positive reason, and read the CONTENT's language, never
`navigator.language`.

**A hidden browser tab does not composite.** Transitions never run there, `requestAnimationFrame`
and `scroll` do not fire, and a coordinate click can deliver nothing. Verify a click landed before
believing what the click did.

---

## Verifying

**read endpoint → seed known rows → read again → assert deltas → clean up.** Deltas make it immune
to whatever is already in the local database.

**Verify a client-only change without the database.** `?demo` runs the real page on canned
answers, so checking a layout or a gesture reads nothing from PGlite. After `npm run demo:build`,
`docs/index.html` does the same from any static file server, with no Haii server running.

**Reading the code is not verifying it.** The defects that matter here are behavioural or visual,
the class code review cannot see. Drive the thing, or say plainly that you did not.

**Grep counts lie about rendered output.** A phrase can survive inside the comment explaining its
removal. Check for the rendered element, not the words.
