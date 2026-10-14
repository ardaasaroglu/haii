/* The Haii demo: the real interface on a fictional week, answered entirely in the browser.
 *
 * It does nothing unless the address carries ?demo (or the single-file build sets HAII_DEMO).
 * When it is on, every call the app makes to its own API is answered from the data below. No
 * server is asked, no mailbox is read and nothing is ever sent.
 *
 * THE ONE RULE HOLDS HERE TOO. Every quote on a card is copied verbatim from one of the fictional
 * transcripts in this file, and tapping the evidence opens that transcript with the sentence
 * marked. demo.test.ts fails the build if a quote stops matching. A demo that invented its
 * evidence would be demonstrating the opposite of the product.
 *
 * The people, the companies and the meetings are invented. Any resemblance is a coincidence.
 */
(function () {
  "use strict";
  var w = window;
  var active = w.HAII_DEMO === true || /[?&]demo(=|&|$)/.test((w.location && w.location.search) || "");
  if (!active) return;
  w.HAII_DEMO = true;

  var MIN = 60000, HOUR = 3600000, DAY = 86400000;
  var ME = "Alex";
  var iso = function (ms) { return new Date(Date.now() + ms).toISOString(); };
  var pad = function (n) { return String(n).padStart(2, "0"); };
  var ymd = function (days) {
    var d = new Date(Date.now() + days * DAY);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  };
  var nextWeekday = function (dow) {
    for (var i = 1; i <= 7; i++) if (new Date(Date.now() + i * DAY).getDay() === dow) return ymd(i);
    return ymd(1);
  };
  // The last day of the month that `days` from now falls in, for "before the end of the month".
  var monthEnd = function (days) {
    var d = new Date(Date.now() + days * DAY);
    var e = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return e.getFullYear() + "-" + pad(e.getMonth() + 1) + "-" + pad(e.getDate());
  };
  var clone = function (x) { return JSON.parse(JSON.stringify(x)); };

  /* ---------------- the fictional transcripts ---------------- */
  var TRANSCRIPTS = {
    tr_renewal: {
      title: "Northwind renewal call", at: -19 * HOUR,
      lines: [
        ["Dana Reyes", "Before we get into the renewal, I still do not have the tiered pricing. I asked for it last Tuesday."],
        [ME, "You are right, and that one is on me. I'll send you the tiered pricing by end of day tomorrow, with the volume breaks."],
        ["Marcus Hale", "From the finance side I need the annual option in writing as well. Without it I cannot take this to approval."],
        [ME, "Understood. The annual option goes in the same email."],
        ["Dana Reyes", "And the security review. Who is running that on your side?"],
        [ME, "Priya owns it. I'll set up thirty minutes with you, me and Priya on Thursday so you can ask her directly."],
        ["Dana Reyes", "Thursday at three works."],
        ["Marcus Hale", "One more thing. Could you share the implementation plan? My team has not seen it."],
        [ME, "Yes. I'll share the implementation plan with both of you today."],
        ["Marcus Hale", "And when do you need our approval by?"],
        [ME, "I'll come back to you on approval timing by Monday."],
        ["Dana Reyes", "Good. If the pricing lands tomorrow we can sign next week."],
        [ME, "Then that is the plan. I'll log where we got to so nothing gets lost on our side."],
      ],
    },
    tr_standup: {
      title: "Product standup", at: -3 * HOUR,
      lines: [
        ["Priya Shah", "The webhook retries are still dropping events under load. It needs a ticket or it gets lost again."],
        [ME, "Agreed. I'll raise a ticket for the webhook retries right after this."],
        ["Omar Haddad", "I am blocked on the onboarding empty state. I need a decision before I can finish the copy."],
        [ME, "We show the sample deck, not a blank screen. I'll post that decision in the design channel so it is written down."],
        ["Noor Aziz", "Northwind asked whether the export works with their single sign-on setup."],
        [ME, "I do not know yet. I'll check the export against their single sign-on setup and come back to you."],
        ["Priya Shah", "Can we also get the migration plan in writing? Finance keeps asking me for it."],
        [ME, "Yes. I'll write up the migration plan this week so finance has something to read."],
      ],
    },
    tr_planning: {
      title: "Weekly planning", at: -3 * DAY,
      lines: [
        ["Noor Aziz", "The quarterly numbers for the board pack are due at the end of the month."],
        [ME, "I'll prepare the quarterly numbers before the end of the month."],
        ["Omar Haddad", "The new pricing page is ready for a last look."],
        [ME, "I'll review the pricing page in the next two days."],
        ["Priya Shah", "Legal sent back the revised agreement for Northwind."],
        [ME, "Good. I'll send the revised agreement to Dana once legal signs off."],
        ["Noor Aziz", "Can we book the roadmap review before the quarter closes? Next Tuesday at eleven suits me."],
        [ME, "I'll book the roadmap review for next week."],
        ["Omar Haddad", "And the research summary from the customer calls?"],
        [ME, "I'll send the research summary to the team this afternoon."],
      ],
    },
  };
  Object.keys(TRANSCRIPTS).forEach(function (id) {
    var t = TRANSCRIPTS[id];
    t.id = id;
    t.content_md = t.lines.map(function (l) { return l[0] + ": " + l[1]; }).join("\n\n");
  });

  /* ---------------- cards ---------------- */
  var card = function (id, actionType, tr, title, summary, quote, payload, priority, confidence, status, decidedAgo, feedback) {
    var src = TRANSCRIPTS[tr];
    return {
      id: id, userId: "demo", schemaVersion: 1, type: "action", actionType: actionType,
      status: status || "proposed", title: title, summary: summary,
      confidence: confidence, priority: priority || "normal",
      sourceJson: { kind: "meeting", title: src.title, when: iso(src.at) },
      payload: payload,
      context: { why: [{ who: ME, text: quote }], entities: [], links: [] },
      expiresAt: iso(7 * DAY), simulated: false, transcriptId: tr, meetingId: null,
      model: "demo", promptVersion: "extract.v011",
      feedback: feedback || null, snoozeCount: 0,
      createdAt: iso(src.at + 20 * MIN), decidedAt: decidedAgo ? iso(decidedAgo) : null,
    };
  };
  var done = function (detail, ago) {
    return { decision: "approved", edit_diff: [], latency_ms: 2400, via: "swipe", decided_at: iso(ago), executed: { mode: "real", detail: detail } };
  };

  var CARDS = [
    card("c_pricing", "send_email", "tr_renewal", "Send Dana the tiered pricing",
      "Promised by end of day tomorrow, with the volume breaks and the annual option Marcus needs.",
      "I'll send you the tiered pricing by end of day tomorrow, with the volume breaks.",
      { to: "dana.reyes@northwind.example", subject: "Tiered pricing and the annual option",
        body: "Hi Dana,\n\nHere is the tiered pricing with the volume breaks, as promised. The annual option Marcus asked for is in the second table.\n\nIf it works for you, we can walk through it on Thursday before the security review.\n\nAlex" },
      "high", 0.93),
    card("c_ticket", "create_task", "tr_standup", "Raise the webhook retries ticket",
      "Priya asked for a ticket so it does not get lost again.",
      "I'll raise a ticket for the webhook retries right after this.",
      { destination: "linear", title: "Webhook retries drop events under load",
        description: "Raised by Priya in standup. Retries drop events under load, and without a ticket the problem keeps getting lost.", due: "" },
      "high", 0.91),
    card("c_review", "create_calendar_event", "tr_renewal", "Book the security review",
      "Thirty minutes on Thursday so Dana can ask Priya directly.",
      "I'll set up thirty minutes with you, me and Priya on Thursday so you can ask her directly.",
      { title: "Northwind security review", date: nextWeekday(4), time: "15:00", duration_min: 30,
        attendees: "dana.reyes@northwind.example, priya@lumen.example" },
      "normal", 0.9),
    card("c_decision", "send_slack_message", "tr_standup", "Post the empty state decision",
      "Omar is blocked until this is written down.",
      "I'll post that decision in the design channel so it is written down.",
      { channel: "#design", message: "Decision on the onboarding empty state: we show the sample deck, not a blank screen. Omar, you are unblocked." },
      "normal", 0.88),
    card("c_plan", "share_file", "tr_renewal", "Share the implementation plan",
      "Marcus's team has not seen it. Haii can only share a file it created.",
      "I'll share the implementation plan with both of you today.",
      { file_name: "Northwind implementation plan", emails: "dana.reyes@northwind.example, marcus.hale@northwind.example", role: "reader" },
      "normal", 0.86),
    card("c_migration", "create_document", "tr_standup", "Write up the migration plan",
      "Finance keeps asking Priya for it.",
      "I'll write up the migration plan this week so finance has something to read.",
      { title: "Migration plan",
        content: "Migration plan\n\nWhy now\nFinance needs a written plan before the renewal goes to approval.\n\nWhat moves\n1. Accounts and permissions, in the first week.\n2. Historical exports, in the second week.\n3. Webhooks last, once the retry fix has shipped.\n\nWho owns it\nPriya owns the technical migration. Alex owns the dates.",
        share_with: "priya@lumen.example" },
      "normal", 0.84),
    card("c_sso", "create_todo", "tr_standup", "Check the export against Northwind's single sign-on",
      "Noor is waiting for an answer.",
      "I'll check the export against their single sign-on setup and come back to you.",
      { title: "Check the export against Northwind's single sign-on", due: "", notes: "Noor asked in standup. Come back to her with the answer." },
      "normal", 0.8),
    // Already decided, so History has something true to show on first load.
    card("h_log", "create_crm_note", "tr_renewal", "Log the renewal call",
      "So nothing gets lost on our side.", "I'll log where we got to so nothing gets lost on our side.",
      { contact: "dana.reyes@northwind.example", note: "Renewal call. Pricing due tomorrow, annual option in writing, security review Thursday." },
      "normal", 0.78, "executed", -18 * HOUR, done("Demo. A real install writes this note to your CRM.", -18 * HOUR)),
    card("h_roadmap", "create_calendar_event", "tr_planning", "Book the roadmap review",
      "Before the quarter closes.", "I'll book the roadmap review for next week.",
      { title: "Roadmap review", date: nextWeekday(2), time: "11:00", duration_min: 45, attendees: "noor@lumen.example, priya@lumen.example" },
      "normal", 0.89, "executed", -3 * DAY + 2 * HOUR, done("Demo. A real install books this on your Google Calendar.", -3 * DAY + 2 * HOUR)),
    card("h_research", "send_email", "tr_planning", "Send the research summary",
      "Promised for the same afternoon.", "I'll send the research summary to the team this afternoon.",
      { to: "team@lumen.example", subject: "Research summary from the customer calls", body: "Team,\n\nThe summary from last week's customer calls is attached.\n\nAlex" },
      "normal", 0.87, "executed", -3 * DAY + 3 * HOUR, done("Demo. A real install drafts this in your Gmail, ready to send.", -3 * DAY + 3 * HOUR)),
    card("h_timing", "create_todo", "tr_renewal", "Come back to Marcus on approval timing",
      "Due Monday.", "I'll come back to you on approval timing by Monday.",
      { title: "Come back to Marcus on approval timing", due: nextWeekday(1), notes: "" },
      "normal", 0.82, "executed", -18 * HOUR, done("Saved to your to-do list in Haii.", -18 * HOUR)),
    card("h_page", "create_todo", "tr_planning", "Review the pricing page",
      "Omar has it ready for a last look.", "I'll review the pricing page in the next two days.",
      { title: "Review the pricing page", due: ymd(-1), notes: "" },
      "normal", 0.8, "executed", -3 * DAY + 4 * HOUR, done("Saved to your to-do list in Haii.", -3 * DAY + 4 * HOUR)),
  ];
  var byId = function (id) { for (var i = 0; i < CARDS.length; i++) if (CARDS[i].id === id) return CARDS[i]; return null; };

  var RECEIPT = {
    send_email: "Demo. A real install drafts this in your Gmail, ready to send.",
    create_calendar_event: "Demo. A real install books this on your Google Calendar.",
    send_slack_message: "Demo. A real install posts this to Slack.",
    create_document: "Demo. A real install writes this as a Google Doc.",
    share_file: "Demo. A real install shares a file only if Haii created it. Any other file comes back as not sent.",
    create_crm_note: "Demo. A real install writes this note to your CRM.",
    create_task: "Demo. A real install files this in your tracker.",
    create_jira_issue: "Demo. A real install files this in Jira.",
    create_todo: "Saved to your to-do list in Haii.",
    send_text: "Demo. A real install opens Messages with this ready to send.",
  };

  /* ---------------- follow-ups ---------------- */
  var todo = function (id, title, due, tr, quote, isDone, cardId) {
    return {
      id: id, title: title, due: due || null, notes: "", done: Boolean(isDone), group: "yours", connector: null,
      card_id: cardId || null, source: TRANSCRIPTS[tr].title,
      quote: { text: quote, who: ME, t: null }, created_at: iso(TRANSCRIPTS[tr].at + 25 * MIN),
      promote_targets: [], sort_order: null, reopenable: true, promoted: null,
    };
  };
  var TODOS = [
    todo("t_page", "Review the pricing page", ymd(-1), "tr_planning", "I'll review the pricing page in the next two days.", false, "h_page"),
    todo("t_timing", "Come back to Marcus on approval timing", nextWeekday(1), "tr_renewal", "I'll come back to you on approval timing by Monday.", false, "h_timing"),
    todo("t_agreement", "Send the revised agreement to Dana", "", "tr_planning", "I'll send the revised agreement to Dana once legal signs off."),
    todo("t_numbers", "Prepare the quarterly numbers", monthEnd(-3), "tr_planning", "I'll prepare the quarterly numbers before the end of the month."),
    todo("t_summary", "Send the research summary to the team", ymd(-3), "tr_planning", "I'll send the research summary to the team this afternoon.", true),
  ];

  /* ---------------- meetings and briefs ---------------- */
  var BRIEFS = {
    br_renewal: {
      tldr: "Dana still does not have the tiered pricing you promised, and she opened with it last time. Bring the number, or bring the hour it lands.",
      sections: [
        { h: "The people", items: [
          "Dana Reyes signs this. She has asked for the pricing twice.",
          "Marcus Hale is finance. He cannot take it to approval without the annual option in writing.",
          "You own the number. Nobody else in the room can give it.",
        ] },
        { h: "What to say first", items: [
          "Open with the pricing, not the apology.",
          "Confirm Thursday for the security review, with Priya in the room.",
          "Give Marcus a date for approval timing before he asks again.",
        ] },
      ],
      last_met: [
        { st: "open", t: "You said the tiered pricing would land by end of day tomorrow." },
        { st: "open", t: "You said you would set up the security review for Thursday." },
        { st: "done", t: "You logged where the renewal call got to." },
      ],
      open_threads: [
        "Tiered pricing with the volume breaks, promised and not yet sent.",
        "The annual option, in writing, for Marcus.",
        "Whether the export works with Northwind's single sign-on.",
      ],
    },
    br_design: {
      tldr: "Omar is waiting on one decision and you already made it in standup. Say it again here and move on.",
      sections: [
        { h: "The people", items: ["Omar Haddad is blocked on the empty state copy.", "Priya Shah wants the webhook fix scheduled before anything new."] },
        { h: "What to say first", items: ["The empty state shows the sample deck.", "The webhook ticket exists and has an owner."] },
      ],
      last_met: [{ st: "open", t: "You said you would post the empty state decision in the design channel." }],
      open_threads: ["The onboarding empty state.", "When the pricing page goes live."],
    },
  };
  var MEETINGS = [
    { id: "m_standup", title: "Product standup", start: -3 * HOUR, mins: 25, brief: null, attendees: ["Priya Shah", "Omar Haddad", "Noor Aziz"] },
    { id: "m_renewal", title: "Northwind renewal", start: 24 * MIN, mins: 45, brief: "br_renewal", attendees: ["Dana Reyes", "Marcus Hale"] },
    { id: "m_design", title: "Design review", start: 3 * HOUR, mins: 30, brief: null, attendees: ["Omar Haddad", "Priya Shah"] },
  ];
  MEETINGS.forEach(function (m) { m.t0 = Date.now() + m.start; });
  var briefRow = function (id) {
    var m = MEETINGS.filter(function (x) { return x.brief === id; })[0];
    return { id: id, userId: "demo", meetingId: m ? m.id : null, contentJson: BRIEFS[id], model: "demo",
      promptVersion: "briefing.v005", rating: RATING[id] || null, feedbackNote: null, readSeconds: 0, createdAt: iso(-95 * MIN) };
  };
  var RATING = {};

  var MEMORIES = [
    "Alex keeps emails short and puts the ask in the first line.",
    "Dana Reyes signs for Northwind. Marcus Hale approves the budget.",
    "Alex does not book meetings before 10:00.",
    "Priya Shah owns security reviews.",
    "Alex writes decisions in the design channel, not in direct messages.",
  ].map(function (content, i) { return { id: i + 1, content: content, updatedAt: iso(-(i + 1) * DAY) }; });

  /* ---------------- answering the app ---------------- */
  var timers = {};
  var rank = { high: 0, normal: 1, low: 2 };
  var proposed = function () {
    return CARDS.filter(function (c) { return c.status === "proposed"; })
      .sort(function (a, b) { return (rank[a.priority] - rank[b.priority]) || (b.confidence - a.confidence); });
  };
  var settle = function (c) {
    // What the real executor does a few seconds after the nod, once undo has expired.
    c.status = "executed";
    c.feedback.executed = { mode: "real", detail: RECEIPT[c.actionType] || "Demo." };
    if (c.actionType === "create_todo" && !TODOS.some(function (t) { return t.card_id === c.id; })) {
      var q = c.context.why[0];
      TODOS.unshift({
        id: "t_" + c.id, title: c.payload.title || c.title, due: c.payload.due || null, notes: c.payload.notes || "", done: false,
        group: "yours", connector: null, card_id: c.id, source: c.sourceJson.title,
        quote: { text: q.text, who: q.who, t: null }, created_at: new Date().toISOString(),
        promote_targets: [], sort_order: null, reopenable: true, promoted: null,
      });
    }
  };

  var feed = function () {
    var next = MEETINGS.filter(function (m) { return m.t0 + m.mins * MIN > Date.now(); })[0] || null;
    return {
      failures: { total: 0, items: [] },
      user: { id: "demo", name: ME, role: "Product lead at Lumen", is_admin: false, telegram_linked: false,
        tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"), tz_pinned: false, email: "", created_at: iso(-21 * DAY),
        owns: "", catches: [], needs_name: false },
      now: new Date().toISOString(),
      today_meetings: MEETINGS.map(function (m) {
        return { id: m.id, title: m.title, starts_at: new Date(m.t0).toISOString(), ends_at: new Date(m.t0 + m.mins * MIN).toISOString(), brief_id: m.brief };
      }),
      next_meeting: next ? {
        id: next.id, userId: "demo", title: next.title, startsAt: new Date(next.t0).toISOString(), endsAt: new Date(next.t0 + next.mins * MIN).toISOString(),
        attendees: next.attendees.map(function (n) { return { name: n }; }),
        briefing: next.brief ? { id: next.brief, content: BRIEFS[next.brief], rating: RATING[next.brief] || null, note: null, model: "demo",
          prompt_version: "briefing.v005", written_at: iso(-95 * MIN) } : null,
      } : null,
      cards: clone(proposed()),
      digest: { rows: [
        { text: "<b>3 meetings</b> today. The Northwind renewal is the one that matters." },
        { text: "<b>3 promises</b> to Northwind are waiting in your deck: the pricing, the security review and the implementation plan." },
        { text: "In the renewal call you made <b>5 commitments</b>. Three are in your deck and you already approved two." },
      ] },
      signals_24h: 37,
      connections: [{ id: "google", status: "connected" }, { id: "slack", status: "connected" }, { id: "jira", status: "disconnected" },
        { id: "linear", status: "connected" }, { id: "telegram", status: "disconnected" }, { id: "anthropic", status: "connected" }],
      undo_grace_ms: 5000,
      has_real_cards: true,
      snoozed_count: CARDS.filter(function (c) { return c.status === "snoozed"; }).length,
      onboarding: "done",
    };
  };

  var NOT_HERE = "This is the demo week. Run Haii on your own machine to use it on your own meetings.";
  var ok = function (json) { return { status: 200, json: json }; };
  var bad = function (status, error) { return { status: status, json: { error: error } }; };

  var route = function (method, path, query, body) {
    var m;
    if (path === "/healthz") return ok({ ok: true, mode: "demo", commit: "demo", ts: new Date().toISOString() });
    if (path === "/api/v1/feed") return ok(feed());
    if (path === "/api/v1/settings") return ok({ host: "127.0.0.1" });

    if ((m = path.match(/^\/api\/v1\/cards\/([^/]+)\/decision$/))) {
      var c = byId(decodeURIComponent(m[1]));
      if (!c) return bad(404, "not found");
      if (method === "DELETE") {
        if (c.status === "executed") return bad(409, "too late: execution already started");
        if (["approved", "dismissed", "snoozed"].indexOf(c.status) < 0) return bad(409, "cannot undo: card is " + c.status);
        clearTimeout(timers[c.id]); delete timers[c.id];
        c.status = "proposed"; c.feedback = null; c.decidedAt = null;
        return ok({ ok: true, status: "proposed", promotion_released: false });
      }
      if (["approved", "edited", "dismissed", "snoozed"].indexOf(body.decision) < 0) return bad(400, "invalid decision: expected approved | edited | dismissed | snoozed");
      if (c.status !== "proposed") return bad(409, "card is " + c.status);
      if (body.decision === "snoozed") {
        c.status = "snoozed"; c.snoozeCount += 1;
        var back = new Date(Date.now() + DAY); back.setHours(8, 0, 0, 0);
        return ok({ ok: true, decision: "snoozed", returns_at: back.toISOString(), rule: "next_morning", snooze_count: c.snoozeCount });
      }
      c.feedback = { decision: body.decision, edited_payload: body.decision === "edited" ? (body.edited_payload || null) : null,
        edit_diff: body.edit_diff || [], latency_ms: body.latency_ms || 0, via: body.via || "unknown", decided_at: new Date().toISOString() };
      c.decidedAt = new Date().toISOString();
      if (body.decision === "dismissed") { c.status = "dismissed"; return ok({ ok: true, status: "dismissed" }); }
      if (body.decision === "edited" && body.edited_payload) c.payload = body.edited_payload;
      c.status = "approved";
      timers[c.id] = setTimeout(function () { delete timers[c.id]; if (c.status === "approved") settle(c); }, 5000);
      return ok({ ok: true, status: "approved", undo_deadline: iso(5000) });
    }
    if ((m = path.match(/^\/api\/v1\/cards\/([^/]+)\/dismiss-reason$/))) {
      var dc = byId(decodeURIComponent(m[1]));
      if (dc && dc.feedback) dc.feedback.reason = body.reason || "";
      return ok({ ok: true });
    }
    if (/^\/api\/v1\/cards\/[^/]+\/retry$/.test(path)) return ok({ ok: true, detail: "Nothing to retry in the demo." });

    if (path === "/api/v1/history") {
      var decided = CARDS.filter(function (x) { return ["approved", "executing", "executed", "dismissed", "failed", "expired"].indexOf(x.status) >= 0; })
        .sort(function (a, b) { return String(b.decidedAt).localeCompare(String(a.decidedAt)); })
        .map(function (x) { return { id: x.id, actionType: x.actionType, title: x.title, status: x.status, decidedAt: x.decidedAt, createdAt: x.createdAt, feedback: x.feedback }; });
      var off = Math.max(0, Number(query.get("offset")) || 0);
      return ok({ cards: clone(decided.slice(off, off + 20)), has_more: decided.length > off + 20,
        todos: TODOS.map(function (t) { return { id: t.id, title: t.title, status: t.done ? "done" : "open" }; }) });
    }

    if (path === "/api/v1/followups") {
      return ok({ items: clone(TODOS),
        open_yours: TODOS.filter(function (t) { return !t.done; }).length, open_blocked: 0 });
    }
    if (path === "/api/v1/todos/reorder") {
      (body.ids || []).forEach(function (id, n) { TODOS.forEach(function (t) { if (t.id === id) t.sort_order = n; }); });
      return ok({ ok: true, ordered: (body.ids || []).length });
    }
    if ((m = path.match(/^\/api\/v1\/todos\/([^/]+)\/toggle$/))) {
      var t = TODOS.filter(function (x) { return x.id === decodeURIComponent(m[1]); })[0];
      if (!t) return bad(404, "not found");
      t.done = !t.done;
      return ok({ ok: true, status: t.done ? "done" : "open" });
    }
    if (/^\/api\/v1\/todos\/[^/]+\/promote$/.test(path)) return bad(400, "Jira is not connected in the demo.");

    if ((m = path.match(/^\/api\/v1\/briefings\/([^/]+)$/))) {
      return BRIEFS[m[1]] ? ok(briefRow(m[1])) : bad(404, "not found");
    }
    if ((m = path.match(/^\/api\/v1\/briefings\/([^/]+)\/rating$/))) { RATING[m[1]] = body.rating || null; return ok({ ok: true, saved: true }); }
    if (/^\/api\/v1\/briefings\/[^/]+\/(note|read)$/.test(path)) return ok({ ok: true, saved: true });
    if ((m = path.match(/^\/api\/v1\/meetings\/([^/]+)\/brief$/))) {
      var mt = MEETINGS.filter(function (x) { return x.id === decodeURIComponent(m[1]); })[0];
      if (!mt) return bad(404, "not found");
      if (!mt.brief) { if (mt.id !== "m_design") return ok({ detail: "skipped: that meeting has already ended" }); mt.brief = "br_design"; }
      return ok({ ok: true, briefing_id: mt.brief, detail: "brief ready" });
    }

    if (path === "/api/v1/transcripts" && method === "POST") return bad(400, NOT_HERE);
    if ((m = path.match(/^\/api\/v1\/transcripts\/([^/]+)$/))) {
      var tr = TRANSCRIPTS[decodeURIComponent(m[1])];
      if (!tr) return bad(404, "not found");
      return ok({ id: tr.id, title: tr.title, content_md: tr.content_md, source: "demo", ingested_at: iso(tr.at + 15 * MIN) });
    }

    if (path === "/api/v1/connections") {
      return ok({
        connections: [
          { id: "google", status: "connected", last_item_at: iso(-12 * MIN) },
          { id: "slack", status: "connected", last_item_at: iso(-40 * MIN), channels: [] },
          { id: "jira", status: "disconnected", last_item_at: null },
          { id: "linear", status: "connected", last_item_at: iso(-30 * MIN) },
          { id: "telegram", status: "disconnected", last_item_at: null },
          { id: "anthropic", status: "connected", last_item_at: null },
        ],
        llm_mode: "api", anthropic_key_present: true, google_client_configured: true, slack_client_configured: true,
        telegram_configured: false, budget: { spend_today: 0, soft: 0.75, hard: 1.5 },
      });
    }
    if (/^\/api\/v1\/connections\//.test(path)) return bad(400, NOT_HERE);
    if (path === "/api/v1/memories") return ok({ memories: clone(MEMORIES) });
    if ((m = path.match(/^\/api\/v1\/memories\/([^/]+)$/)) && method === "DELETE") {
      MEMORIES = MEMORIES.filter(function (x) { return String(x.id) !== m[1]; });
      return ok({ ok: true });
    }
    if (path === "/api/v1/jobs") return ok({ runs: [] });
    if (/^\/api\/v1\/jobs\//.test(path)) return ok({ ok: true, detail: "Jobs do not run in the demo." });
    if (path === "/api/v1/telegram/link") return ok({ configured: false });
    if (path === "/api/v1/stats") return ok({ by_type: {}, decided_total: CARDS.filter(function (x) { return x.status !== "proposed"; }).length });
    if (path === "/api/v1/onboarding/progress") return ok({ done: true, total: 0, readable: 0, read: 0, unreadable: 0, meetings: [] });
    return ok({ ok: true, changed: false, saved: false });
  };

  var realFetch = w.fetch ? w.fetch.bind(w) : null;
  w.fetch = function (input, init) {
    var raw = typeof input === "string" ? input : (input && input.url) || "";
    var u;
    try { u = new URL(raw, w.location.href); } catch (e) { return realFetch(input, init); }
    if (!/^\/(api\/|healthz$|auth\/)/.test(u.pathname)) return realFetch(input, init);
    var body = {};
    try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (e) { body = {}; }
    var out = route(String((init && init.method) || "GET").toUpperCase(), u.pathname, u.searchParams, body || {});
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve(new Response(JSON.stringify(out.json), { status: out.status, headers: { "content-type": "application/json" } }));
      }, 90);
    });
  };

  /* ---------------- saying that it is a demo ---------------- */
  // Connect, reconnect and sign out lead to pages that do not exist here, so they are answered in
  // place rather than followed. Capture phase, so the app's own handler never runs.
  // Its own small notice, because the app keeps its toast private inside a closure.
  var noteTimer = null;
  var note = function () {
    var n = w.document.getElementById("demoNote");
    if (!n) {
      n = w.document.createElement("div");
      n.id = "demoNote";
      n.setAttribute("role", "status");
      n.setAttribute("style", "position:fixed;left:50%;transform:translateX(-50%);bottom:104px;z-index:9999;max-width:calc(100% - 48px);" +
        "padding:11px 16px;border-radius:14px;background:#10182B;color:#fff;font:500 13.5px/1.35 system-ui,sans-serif;text-align:center;" +
        "box-shadow:0 10px 30px rgba(16,24,43,.28)");
      w.document.body.appendChild(n);
    }
    n.textContent = "This is the demo week. Nothing is connected, read or sent here.";
    n.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { n.hidden = true; }, 2800);
  };
  if (w.document && w.document.addEventListener) {
    w.document.addEventListener("click", function (e) {
      var b = e.target && e.target.closest ? e.target.closest("#vSetup button, #vSetup a") : null;
      if (!b) return;
      if (/^(connect|reconnect|sign out|disconnect|link )/i.test((b.textContent || "").trim())) {
        e.preventDefault(); e.stopImmediatePropagation(); note();
      }
    }, true);
    // An in-flow bar ABOVE the header, never a floating pill: the header carries the greeting and
    // the live state, and a label that covers them is a worse lie than no label.
    // One line even at 320px wide: the text is short, and if a wide font still runs out of room,
    // the label gives way with an ellipsis while the source link stays whole.
    var bar = function () {
      var head = w.document.querySelector("header");
      if (!head || w.document.getElementById("demoBar")) return;
      var d = w.document;
      var tag = d.createElement("div");
      tag.id = "demoBar";
      tag.setAttribute("style", "flex:none;display:flex;justify-content:center;align-items:center;gap:5px;padding:5px 10px;" +
        "background:#10182B;color:#fff;font:500 11.5px/1.3 system-ui,sans-serif;letter-spacing:.02em;flex-wrap:wrap;text-align:center");
      var label = d.createElement("span");
      label.textContent = "Haii turns what you promise in meetings into cards. A fictional week, nothing is sent.";
      label.setAttribute("style", "min-width:0");
      var sep = d.createElement("span");
      sep.textContent = "·";
      sep.setAttribute("aria-hidden", "true");
      sep.setAttribute("style", "flex:none");
      var src = d.createElement("a");
      src.href = "https://github.com/ardaasaroglu/haii";
      src.target = "_blank";
      src.rel = "noopener";
      src.textContent = "Source on GitHub";
      src.setAttribute("style", "flex:none;color:inherit;text-decoration:underline;text-underline-offset:2px");
      tag.appendChild(label);
      tag.appendChild(sep);
      tag.appendChild(src);
      head.parentNode.insertBefore(tag, head);
    };
    bar();
    w.document.addEventListener("DOMContentLoaded", bar);
  }

  // For demo.test.ts, which checks every quote against these transcripts and every receipt's wording.
  w.__HAII_DEMO = { transcripts: TRANSCRIPTS, cards: CARDS, todos: TODOS, receipts: RECEIPT, route: route };
})();
