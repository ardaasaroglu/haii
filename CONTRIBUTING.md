# Contributing

Small, focused changes are welcome. A few rules keep Haii what it is.

1. **A quote is verbatim or it is not shown.** Never invent evidence to fill a slot, in the product, in a test or in the demo.
2. **Nothing sends without a gesture.** No setting, flag or shortcut may act on its own.
3. **The list of actions is closed.** A new action type is a product decision. Open an issue before writing one.
4. **A swipe produces the thing.** If Haii can work out an answer, it does, and says what it did. It reports a failure only when the outside world failed.
5. **Prompts are versioned.** Never edit a prompt file in place. Add the next version and say why it exists.

Before opening a pull request:

* Run `npm test`, `npx tsc --noEmit -p server` and `npx tsc --noEmit -p packages/schema`. CI runs all three.
* Optional: run `git config core.hooksPath .githooks` once. The hook in `.githooks/pre-push` then runs `npm test` before every push and stops the push if a test fails. `git push --no-verify` skips it.
* Drive the change in a browser. `http://localhost:4820/?demo` runs the real interface on canned answers, with no key and no reads from the database. A file that parses is not a change that works.
* If you changed the client or the demo, run `npm run demo:build` and commit the result. CI fails when `docs/index.html` is out of date.
* If you added a route the client calls, give the demo an answer for it in `server/public/demo.js`.

`CLAUDE.md` lists the invariants and the traps already hit in this codebase. Read it first.

Found a security problem? Follow [SECURITY.md](SECURITY.md) and do not open a public issue.
