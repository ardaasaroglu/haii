/** Per-user timezone helpers. The server itself runs UTC (never set TZ on the
 *  cloud service); every user-facing "today" derives from users.tz, an IANA zone the PWA
 *  auto-reports from the device on boot. The column's 'local' default is the pre-capture
 *  sentinel and, like any invalid value, falls back to UTC here.
 *  Intl-only, no dependencies. Offsets are snapped to whole minutes; day bounds refine the
 *  offset at the start edge, so the only imprecision is the hour a DST jump inserts/removes
 *  inside one day, which is fine for meeting strips and digest windows. */

export function isValidTz(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64 || tz === "local") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** users.tz -> effective zone: valid IANA value or the UTC fallback. */
export function userTz(raw: string | null | undefined): string {
  return isValidTz(raw) ? raw : "UTC";
}

/** Which zone a calendar card's wall-clock payload must be resolved in at execution.
 *
 *  A card carries `date` + `time` with no offset, and it lives 7 days. Resolving that against the
 *  user's CURRENT zone means a card proposed as "Thu 14:00" in one time zone and approved after a
 *  flight to another books 14:00 in the new zone: as many hours out as the two zones are apart,
 *  silently, with the card reading identically before and after. The zone stamped at proposal is the commitment; the live zone is display.
 *
 *  Falls back to the user's current zone only when there is no stamp, which is every card
 *  proposed before `context.scheduling.tz` existed. That fallback is not a fix, it is exactly the
 *  old behaviour, kept so old cards stay executable rather than throwing. */
export function cardResolutionTz(stampedTz: unknown, currentUserTz: string | null | undefined): string {
  return isValidTz(stampedTz) ? stampedTz : userTz(currentUserTz);
}

function tzOffsetMs(tz: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const asUTC = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour % 24, // Intl can emit "24" at midnight
    +parts.minute,
    +parts.second,
  );
  return Math.round((asUTC - at.getTime()) / 60_000) * 60_000;
}

/** Wall-clock (y, mo [1-12], d, h, mi) interpreted in `tz` -> the absolute UTC instant. Two-step
 *  offset refinement (as in dayBoundsInTz) keeps a DST edge from shifting the result by an hour.
 *  Used by the slot finder to turn a candidate local start time into a comparable instant. */
export function zonedTimeToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number): Date {
  const asUTC = Date.UTC(y, mo - 1, d, h, mi);
  const guess = new Date(asUTC - tzOffsetMs(tz, new Date(asUTC)));
  return new Date(asUTC - tzOffsetMs(tz, guess));
}

/** "YYYY-MM-DD" of `at` in the user's zone (digest day key, feed digest lookup). */
export function dayKeyInTz(tz: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Absolute instants of the user's local day around `at` (feed day strip, digest meetings). */
export function dayBoundsInTz(tz: string, at: Date = new Date()): { start: Date; end: Date } {
  const local = new Date(at.getTime() + tzOffsetMs(tz, at));
  const midnightUtcOfLocalDate = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  // refine with the offset at the (guessed) start edge so a DST change between now and
  // midnight doesn't shift the boundary
  const guess = new Date(midnightUtcOfLocalDate - tzOffsetMs(tz, at));
  const start = new Date(midnightUtcOfLocalDate - tzOffsetMs(tz, guess));
  const end = new Date(start.getTime() + 24 * 3600_000 - 1);
  return { start, end };
}

/** Minutes since the user's local midnight (digest 07:30 window gate). */
export function localMinutesInTz(tz: string, at: Date = new Date()): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return ((+p.hour) % 24) * 60 + +p.minute;
}

/** MACHINE time. "HH:MM", 24h, always, whatever the user's locale.
 *
 *  Do NOT make this locale-aware. Two call sites depend on the 24h shape and both break loudly or
 *  silently if it changes: findOpenSlot (lib/schedule.ts) writes it into a card's `time` payload,
 *  which executor.ts validates with /^\d{1,2}:\d{2}$/ and would reject as "2:00 PM"; and
 *  localIsoInTz (jobs/executor.ts) builds the `dateTime` string sent to the Google Calendar API.
 *
 *  For anything a human reads, use hhmmForUser. */
export function hhmmInTz(tz: string, at: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
}

/** Is this a locale tag Intl can actually use? Same shape as isValidTz, and for the same reason:
 *  users.locale is whatever a browser reported, so it is untrusted input. */
export function isValidLocale(locale: unknown): locale is string {
  if (typeof locale !== "string" || !locale || locale.length > 35) return false;
  try {
    new Intl.DateTimeFormat(locale);
    return true;
  } catch {
    return false;
  }
}

/** HUMAN time. The same instant, written the way this user writes times.
 *
 *  "14:00" is correct for most of Europe and wrong for US users, who read
 *  2:00 PM. The zone decides WHICH instant, the locale decides how it is spelled, and they are
 *  independent: an American living in Europe wants 2:00 PM, in the local zone's time.
 *
 *  Falls back to en-GB (24h) when the locale is missing or unusable, which is the behaviour every
 *  one of these call sites had before. */
export function hhmmForUser(tz: string, locale: string | null | undefined, at: Date): string {
  const loc = isValidLocale(locale) ? locale : "en-GB";
  return new Intl.DateTimeFormat(loc, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(at);
}

/** "YYYY-MM-DD HH:MM" in the user's zone (prompt context, generated titles). */
export function dateTimeInTz(tz: string, at: Date): string {
  return `${dayKeyInTz(tz, at)} ${hhmmInTz(tz, at)}`;
}
