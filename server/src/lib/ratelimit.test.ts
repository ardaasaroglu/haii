import { allow, __clearLimits } from "./ratelimit";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "ok" : "FAIL"} · ${name}`);
  if (!ok) failures++;
}

const OPTS = { name: "t", limit: 3, windowMs: 1000 };
const T0 = 1_000_000;

console.log("\n--- the allowance ---");
__clearLimits();
check("first is allowed", allow("u1", OPTS, T0));
check("second is allowed", allow("u1", OPTS, T0));
check("third is allowed", allow("u1", OPTS, T0));
check("fourth is refused", !allow("u1", OPTS, T0));

console.log("\n--- one user cannot spend another's ---");
// The whole point: a loop on one account must not take the product down for everybody, which is
// exactly what leaning on the shared budget cap instead would have done.
check("a different user is unaffected", allow("u2", OPTS, T0));

console.log("\n--- the window slides ---");
__clearLimits();
allow("u1", OPTS, T0);
allow("u1", OPTS, T0 + 400);
allow("u1", OPTS, T0 + 800);
check("still refused inside the window", !allow("u1", OPTS, T0 + 900));
// A FIXED window would let the whole allowance be spent at the end of one bucket and again at the
// start of the next, which is double the intended rate at the worst possible moment.
check("the oldest call ageing out frees exactly one slot", allow("u1", OPTS, T0 + 1100));
check("and only one", !allow("u1", OPTS, T0 + 1150));

console.log("\n--- limiters are independent ---");
__clearLimits();
allow("u1", OPTS, T0); allow("u1", OPTS, T0); allow("u1", OPTS, T0);
check("a different limiter has its own allowance", allow("u1", { ...OPTS, name: "other" }, T0));

console.log(`\n${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
