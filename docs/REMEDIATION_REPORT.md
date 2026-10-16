# Remediation Report — What Needs To Be Fixed

**Companion to:** [DIFFERENTIATION_PLAN_VERIFICATION.md](DIFFERENTIATION_PLAN_VERIFICATION.md) (the evidence behind each item)
**Principle:** every fix below is stated as *location → wrong behaviour → exact change → how to prove it's fixed*.
**Current state:** 185/185 tests pass, build is clean, and the anti-oversell core is sound. Everything here is about the **new** differentiation work and the submission surface, not the checkout engine.

---

## Tier 0 — Blocking (the deliverable is broken / data is at risk)

### FIX-1 · `demo:judge` crashes on its own in-memory bootstrap

**Where:** `server/scripts/judge-run.mjs:35-36`

```js
const uri = replSet.getUri();
await connectDb(uri);          // ← throws: "MONGODB_URI has no database name"
```

**Why:** `MongoMemoryReplSet.getUri()` returns a base URI with no database path. `connectDb` has an explicit
guard (`server/src/db/connect.js:12-25`) that rejects exactly that. Reproduced: `JUDGE_EXIT=1`.

**Change** — this exact fix already exists one directory away in `server/tests/helpers/globalSetup.js:26-30`:

```js
const baseUri = replSet.getUri();
const url = new URL(baseUri);
url.pathname = '/judge';
await connectDb(url.toString());
```

**Prove it:** `MONGODB_URI="mongodb://127.0.0.1:59999/x?replicaSet=rs0" npm run demo:judge` must now reach
all five sections and exit `0`. Today it exits `1` on step 1.
**Effort:** ~5 min.

### FIX-2 · The judge's chaos step cannot fail, so it proves nothing

**Where:** `server/scripts/judge-run.mjs:198-204`

```js
try {
  await checkout({ ..., chaosFault: 'crash_after_charge' });
  throw new Error('Expected chaos failure did not trigger');   // thrown INSIDE try…
} catch (err) {
  process.stdout.write(`  Simulated crash caught: "${err.message}"\n`);  // …caught here
}
```

**Why it matters:** if the injection is a no-op, `checkout` returns, the script throws its own error, the same
`catch` swallows it, it prints `Simulated crash caught: Expected chaos failure did not trigger`, and the run
continues to a green `ALL DEMO & VERIFICATION CHECKS PASSED`. **A verification step that always reports success
is worse than no step.**

**Change:**

```js
let faultFired = false;
try {
  await checkout({ ..., chaosFault: 'crash_after_charge' });
} catch (err) {
  if (err?.code !== 'CHAOS_FAULT') throw err;   // a real bug, not our injected fault
  faultFired = true;
  process.stdout.write(`  Simulated crash caught: ${err.message}\n`);
}
if (!faultFired) throw new Error('Chaos fault did not fire — the injection seam is broken');
```

`chaos.service.js` already sets `err.code = 'CHAOS_FAULT'`, so the discriminator exists.

**Prove it:** temporarily pass a bogus step name (e.g. `crash_before_chargeX`); the script must now exit non-zero
instead of reporting PASS.
**Effort:** ~10 min.

### FIX-3 · The judge (and bench) reset deletes every order, claim and attempt

**Where:** `server/scripts/judge-run.mjs:43-45` (and the same pattern at `server/scripts/bench.mjs` `resetWorld`)

```js
Order.deleteMany({}),            // ← all orders
IdempotencyKey.deleteMany({}),   // ← all claims
PaymentAttempt.deleteMany({}),   // ← all attempts
```

**Why it matters:** `loadEnv.js` preferentially loads the repo-root `.env` (which exists) and real env vars win
over it, so a normal `npm run demo:judge` connects to the **configured** database and wipes the seeded demo
dataset — including the 487 payment attempts and orders `README.md` invites reviewers to inspect. This is also
why `npm run bench` was not run during verification.

**Change — pick one, ideally (c) plus (b):**

- **(a) Scope it.** Collect the judge buyer ids, then delete `Order` by `customerId`, and `IdempotencyKey`/`PaymentAttempt` by the resulting `orderId`s. Only judge-owned rows go.
- **(b) Refuse to run destructively.** Require the resolved database name to match `/_(demo|bench|judge|test)$/` or require an explicit `--yes-destroy` flag, and **print the database name** it is about to clear.
- **(c) Never honour `MONGODB_URI` for the judge script.** Always use its own in-memory replica set. This is also the plan's stated design and it makes the run deterministic.

**Prove it:** seed a scratch database containing a sentinel order, point `MONGODB_URI` at it, run the judge script,
and confirm the sentinel survives.
**Effort:** ~30 min.

---

## Tier 1 — High (a reviewer will notice)

### FIX-4 · The advertised live URL returns 404

**Where:** `README.md:27,39` and `README.txt:27,39`

`README.md` now points at `https://order-processing-system.onrender.com`, which returns **HTTP 404** (DNS resolves
to Render's proxy; no app is served). `README.txt` is tracked and still carries **both original placeholders**.
`‹paste your deployed Render URL here›` says "not deployed"; a live-looking URL that 404s says "claimed deployed
and isn't."

**Change:** either deploy and verify `curl -sI .../healthz` returns `200`, or replace both files with an explicit
local-run statement (`NODE_ENV=production npm run build && npm start` → `http://localhost:4000`). Then **delete or
regenerate `README.txt`** — a second copy of the README is a second place for claims to drift.
**Prove it:** `curl -s -o /dev/null -w '%{http_code}' <url>/healthz` → `200`, or the URL no longer appears.
**Effort:** ~15 min (or ~2 min if reverting to local-only).

### FIX-5 · The fairness feature reports the wrong winners, and no statistic

**Where:** `server/src/routes/admin.routes.js:407,414,463` · `client/src/pages/admin/ConcurrencyLabPanel.jsx:372`

```js
settled.forEach((outcome, idx) => { ... confirmedBuyerIndices.push(idx + 1); });
```

`settled` is the result array of `buyerOrder`, which **has been shuffled** when `policy === 'lottery'`
(lines 359-363). So `idx + 1` is the winner's *position after shuffling*, and the UI renders it as `Buyer #{idx}` —
"Buyer #3" bears no relation to the third buyer. For `fifo` the result is always `1..N`, i.e. trivially "fair".

Separately: there is **no Gini coefficient and no win-spread statistic** (0 `gini` matches in source; `fairness`
appears only as prose labels), no **ADR-15**, and **no test** covering either policy.

**Change:**
1. Record **identity, not position**: assign each buyer a stable ordinal *before* shuffling and carry it through, e.g. settle as `{ buyer, ordinal, outcome }` pairs and push the ordinal. Cross-checkable against the orders table.
2. **Compute and return** `fairness: { gini, winsPerBuyer, spread }` and render it. With one unit per buyer, wins are 0/1 and Gini is meaningful over buyers.
3. **Make `fifo` contend concurrently.** Today it is a serial `await` loop (lines 369-378), which removes the contention it claims to allocate fairly and makes its `durationMs`/retry counts incomparable to `race`/`lottery`. Implement arrival-ordered admission that still executes concurrently.
4. Add **ADR-15** to `docs/DECISIONS.md` (currently ends at ADR-14) and add tests for the two policies.

**Prove it:** run the lab under each policy; assert the confirmed count is unchanged, that reported winner ordinals
match the orders actually created in the database, and that `gini` is computed. Add a `fifo` test asserting it
still oversells nothing.
**Effort:** ~2–3 h.

### FIX-6 · `rate_limited` is exported but can never increment

**Where:** declared at `server/src/lib/metrics.js:22`; nothing increments it (`middleware/rateLimit.js` does not import `metrics`).

**Change:** either increment it in the rate-limit middleware, or remove the label from the registry and drop the
claim from the docs. A metric that structurally cannot move implies coverage that does not exist — worse than no metric.
**Prove it:** fire more than `CHECKOUT_RATE_LIMIT_PER_MIN` requests and assert the counter moves; add that assertion to `smoke.test.js`.
**Effort:** ~10 min.

---

## Tier 2 — Medium (correctness / plan fidelity)

### FIX-7 · Refund writes are not atomic, and `?restock=true` is missing

**Where:** `server/src/routes/admin.routes.js:276-310`

Three independent writes: `getGateway().refund()` (287) → `PaymentAttempt.updateOne` (290) → `Order.updateOne` (298).
A crash between the last two leaves the **attempt `refunded` while the order still reads `refund_required`** — and
the admin UI keys off `refund_required` (`OrdersPanel.jsx:162`), so it keeps advertising a refund already paid out.

**Change:** keep the **external** gateway call outside any transaction (same reasoning as ADR-06 — transactions
retry, external side effects must not), then wrap the **database** writes in one `withTransaction`:
attempt → `refunded`; `order.payment.status` → `refunded`; push the history entry; optionally `restock()` when
`?restock=true`. Add a `refundQuerySchema` (`restock` coerced boolean, default false) — the route currently
validates `params` only, so the parameter is silently ignored today.
**Prove it:** assert both writes land or neither; assert `restock=true` returns units to `onHand`/`available` and
that `checkInvariants()` stays clean.
**Effort:** ~45 min.

### FIX-8 · The saga property test is far weaker than advertised

**Where:** `server/tests/property/saga.property.test.js:126-127,135`

- Invariants are checked **once at the end** (126-127), not after every prefix as the plan specified — so transient, self-healing violations, exactly the class this test exists to catch, pass.
- `numRuns: 5` (135) — effectively a smoke test. Conditional actions (`reconcile`, `fulfill`) rarely fire.
- The three trailing counter assertions restate I1/I2 and add nothing.

**Change:** call `checkInvariants()` **inside** the action loop after each action; raise `numRuns` to 50+; drop the
redundant counter assertions. Watch the 45 s timeout — consider creating fewer products so each run is cheaper.
**Prove it:** suite still green, and the test should fail if you deliberately break an invariant mid-sequence
(e.g. hand-roll a double `release`).
**Effort:** ~30 min.

### FIX-9 · 202 polling is uncapped and ignores `pollUrl`

**Where:** `client/src/hooks/useCheckout.js:53,75,107`

The plan specified `pollUrl`, interval 1.5 s, **max 10 attempts**. Actual: an uncapped `setInterval` against
`GET /api/orders/:id`, and `pollUrl` is stored and never read.

**Change:** add an attempt counter with a `maxAttempts` cap and a give-up state, prefer `result.pollUrl`, and
render a dedicated resolution card for `payment_failed` / `refund_required`.
**Effort:** ~20 min.

---

## Tier 3 — Low (plan artifacts not built)

| Item | Where | Note |
|---|---|---|
| `gateway_timeout` and `delay_settlement_past_lease` chaos fault points | `checkout.service.js`, `chaos.service.js` | Only 2 of the plan's 4 named injection points exist |
| "Simulate Chaos / Mid-Charge Crash" admin button | `client/` | Zero `chaos` references in the client; plan component 3 absent |
| `OrderTimeline.jsx` | inlined at `OrdersPanel.jsx:618` | Specified path does not exist; also no explicit "pricing calculated" step or refund/replay **branch-point** rendering |
| Currency + ADR-15 notes | `docs/DECISIONS.md` | Drift was fixed by standardising on **INR only**; no `CURRENCY` config key, no ADR entry documenting either decision |

None of these are defects in what exists — they are plan items that were never started. Each should be either
built or **explicitly dropped from the plan** so the docs and the code agree.

---

## Tier 4 — Hygiene

### FIX-10 · Nothing is committed
Every change sits in the working tree (32 modified files plus 6 untracked). If the submission is a fresh clone or
`git archive`, **none of this differentiation work exists**. Stage deliberately (not `git add -A`) and commit.
**Effort:** ~5 min.

### FIX-11 · Publish or re-derive the benchmark numbers
`README.md:193-225` quotes fast-fail figures (−34.6% drained, ~5% under a herd) that were **not re-derived** in this
work, because `bench.mjs` holds the same unscoped deletes as FIX-3. Fix FIX-3 first, then run `npm run bench` and
confirm or update the published table.

---

## Suggested order

```
Blocking  →  FIX-1  FIX-2  FIX-3          (the judge script becomes trustworthy; data becomes safe)
High      →  FIX-4  FIX-6  FIX-5          (submission surface, then the fairness claim)
Medium    →  FIX-7  FIX-8  FIX-9
Low       →  Tier 3 items (build or drop)
Hygiene   →  FIX-10  FIX-11
```

**Minimum viable set if time is short:** FIX-1, FIX-2, FIX-3, FIX-4, FIX-10. Those five turn the judge script from
"crashes, and would wipe your data, and can't fail its own chaos check" into a deliverable a reviewer can actually
run — and they get the work committed. FIX-5 is the highest-value item after that, because the fairness angle is
the most original idea in the plan and currently the least substantiated.

## Do not regress

While making the above changes, keep these intact — they are the parts that already earn credit:

- The conditional `$inc` reserve primitive and the `$jsonSchema` non-enumerative backstop (ADR-02/03).
- The chaos **integration tests** in `server/tests/integration/chaos.test.js` — the strongest new artifact.
- The `$or: [null, …]` type-bracketing fix in `expiry.service.js` and `invariants.js`.
- The paired A/B-then-B/A benchmark methodology and the README's account of correcting its own numbers.
- All 185 passing tests, and the production build with zero warnings.

## Verification checklist (run after the fixes)

```bash
npm test                                                  # expect 185+ passing, EXIT 0
npm run build                                             # expect EXIT 0, zero warnings
MONGODB_URI="mongodb://127.0.0.1:59999/x?replicaSet=rs0" \
  npm run demo:judge                                      # expect EXIT 0, all 5 sections
curl -s -o /dev/null -w '%{http_code}\n' <README url>/healthz   # expect 200, or remove the URL
grep -rn "deleteMany({})" server/scripts                  # expect no unscoped deletes
git status --porcelain                                    # expect clean
```
