# Security

Haii reads what you said in meetings and can act on your behalf. That is a lot to trust a program with, so this page says plainly what it does.

## What stays on your machine

* Run locally, the server binds to `127.0.0.1` only. Local mode has no login, so the server refuses to start on any other address unless you opt in with `ALLOW_LAN_DEV=1`.
* Because there is no login, the server treats a request as you only when it comes from its own page, or from a program on your machine that is not a browser, such as `curl`. A request that another website makes your browser send, or one that arrives under a foreign host name, is refused.
* Your meetings, cards, history and the facts Haii keeps about you live in an embedded database in `server/.data`.
* Credentials you connect in the app are stored encrypted with AES-256-GCM. The key is in `server/.env`, which the server creates on first start and `.gitignore` keeps out of git. If you lose that key, stored credentials cannot be read again. Values you write into `server/.env` yourself, such as your Claude API key, are kept there in plain text.

## What leaves your machine

* **Anthropic, on your own API key.** Whatever Claude reads is sent to the Claude API:
  * a transcript you paste, one from a connected notetaker, or a Google Doc that Haii reads as meeting notes (see below);
  * with Slack connected, every four hours, your own recent messages and up to four messages before each one;
  * for a brief, the invite text, up to two attached documents, part of the last related meeting's transcript, and related items from your connected tools: the sender, subject and Gmail's short preview of an email, Slack messages, Jira, Linear and Asana issues, and Confluence pages you switched on;
  * for the morning digest, the ten newest items from those tools and the titles of today's meetings;
  * once a week, how you decided on recent cards, with a few of their titles, how you rated recent briefs, and any notes you wrote about briefs, so Haii can learn your preferences;
  * the context that goes with each of those, which differs by job:
    * a meeting read, a Slack one included, carries the facts Haii keeps about you that fit the meeting, the titles of your open cards, and how you decided on up to ten recent cards, with their titles;
    * a brief carries the facts Haii keeps about you, your open cards and to-dos, and how you rated recent briefs, with the titles of their meetings;
    * the weekly job carries the facts Haii already keeps about you, so it revises them rather than repeating them;
    * the morning digest carries none of these. Its own line above is all it sends.
* **The tools you connect.** Haii reads from them and writes to them only with the credentials you gave it.
* **Telegram, only if you link a chat.** Card titles, briefs, the morning digest and reminders are sent to your own chat.
* **An operator chat, only if you set one.** With `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_CHAT_ID` set, that chat receives a message when the server starts or crashes, alerts about budget caps, the Anthropic account and Google connections that need signing in again, a daily summary, and an alert when a job or an action fails. A failure alert names the user and their email, the title of what failed and the error. When several people share one instance, it also receives a short line for each thing a user does, and the text of any note a user writes about a brief.
* **Your browser's voice, if you have a brief read aloud.** Haii uses a voice your browser provides, and some browsers provide online voices.
* **Nothing else.** There is no analytics and no telemetry.

## What it will not do

* **Act without a gesture.** Every action waits for your approval, and there is a short undo after it.
* **Send an email from your mailbox.** An email card becomes a draft in your own mailbox. You press send. Google itself sends email in three cases: when you approve a calendar card with guests, a document card with people to share it with, or a file share, Google emails those people.

## What it does without a gesture

* **It reads.** Connected tools are polled on a schedule, and briefs and the morning digest are written without being asked.
* **It updates what it knows about you.** Reading a transcript can add, change or remove facts in Haii's long-term memory, and a weekly job adds more from your decisions. These facts shape later cards and briefs. You can read and delete them in Setup.

## Other people's text

A transcript is mostly other people's sentences, and anyone who can get text in front of Haii can try to steer it. Their text is not ignored. The defence is this:

* **Only your own commitments are meant to become cards.** The extraction prompt asks for things you said you would do or agreed to do. For Slack, code also deletes any card whose quote does not come from one of your own messages.
* **Every card waits for your gesture.** Nothing a transcript says can make a card run.
* **A quote that is not found word for word in the source is stripped.** The match ignores case, spacing and quote styles. A quote under 12 characters is too short to check and is kept. A card left with no quote is dropped.
* **An unexpected recipient is named on the card.** If a card would send something to an email address that was not on the meeting invite and is not at your own company's domain, the card shows that address before you decide.

One thing to know: any Google Doc your connected account can open whose name contains "transcript", "meeting notes", "Notes by Gemini" or "Gemini notes" is read as a meeting, whoever wrote it. It can propose cards. It cannot run one without your gesture.

## The demo

`?demo` and the hosted demo answer every call the app makes to its own API in the browser, from fictional data. No server is asked, nothing is read and nothing is sent.

## Reporting a vulnerability

Report it privately at <https://github.com/ardaasaroglu/haii/security/advisories/new>. Please do not open a public issue for a security problem.

That link works only while private vulnerability reporting is enabled in this repository's settings. If it shows an error, open an issue asking for a private contact, and leave out any details of the problem.
