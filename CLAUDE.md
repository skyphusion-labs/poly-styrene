# poly-styrene

Poly Styrene is a Discord bot for technical help in a cybersecurity channel. It answers security
engineering and threat intelligence questions, and when a question calls for an exploit, payload or
command it gives them, marked for defense, detection or authorized testing. Named after Marianne
Joan Elliott-Said of X-Ray Spex.

One Cloudflare Worker is the entire server side. There is no Discord gateway process, no bot
container, and nothing that holds a socket. Read `README.md` for the product surface; this file is
the operator contract.

## Architecture

Slash commands arrive as HTTP interactions on `POST /discord`. That is the only inbound path that
does work.

- **`src/index.ts`** is the only module Wrangler loads. It exports the `fetch` handler, the
  `scheduled` handler for the catalog cron, and re-exports `AskWorkflow`.
- **`src/server.ts`** routes three paths and nothing else: `/discord`, `/health`, and a plain-text
  root.
- **`src/discord.ts`** verifies the Ed25519 signature, then routes by interaction type: 1 ping,
  2 command, 3 component, 4 autocomplete. It must answer within Discord's **3 second deadline**.
- **`src/workflow.ts`** is `AskWorkflow`, the Cloudflare Workflow that does the actual inference.

**The 3 second deadline is the reason the design is split.** Inference does not fit in it, so
`/ask` validates, starts a Workflow, and returns interaction response `type: 5` (deferred). The
Workflow posts the answer later through the Discord REST API using the interaction token. Every
piece of latency therefore lives in `workflow.ts`, and `discord.ts` must stay fast: no inference,
no GPU call, no unbounded loop on that path.

**The interaction id is the Workflow id, and that is the idempotency key.**
`env.ASK.create({ id: interactionId, params })`. Discord retries an interaction it thinks it lost,
so a retry collides on the id, `create` throws "already exists", and `commandAsk` catches that one
message and returns `type: 5` anyway. A retried interaction therefore re-acknowledges without
starting a second inference. Do not generate a fresh Workflow id for an ask, and do not widen that
catch to swallow other create failures.

### The two inference paths

| Path | Where | Cost at rest | Notes |
| --- | --- | --- | --- |
| Cloudflare Workers AI | `env.AI.run` through AI Gateway `poly-styrene` | nothing | always on, per token |
| One Ollama model | RunPod serverless, `POST /run` then poll `/status/{id}` | $0/hour GPU | scales to zero, cold start of minutes |

`src/infer.ts` builds and reads the Workers AI call. `src/runpod.ts` builds the Ollama chat body and
interprets a RunPod status payload. `src/catalog.ts` is the model catalog and the id parser.
`src/text.ts` holds the Discord chunking, base64 and select-value helpers. `src/db.ts` is the pin
table. `src/refresh.ts` is the cron catalog refresh.

**`src/prompt.ts` `SYSTEM_PROMPT` goes to BOTH paths**, `infer.ts` for Workers AI and `runpod.ts`
for Ollama. It is not specific to the abliterated model. A change to it changes every answer the bot
gives on either path.

## State

**The only durable state is one D1 table, `pins`** (`migrations/0001_pins.sql`), keyed
`(guild_id, channel_id, user_id)` and holding the pinned provider, model id, task and an
`updated_at`. That is the whole schema.

**No prompt and no answer is persisted by this Worker.** Not to D1, not to KV, not to a log line.

**One caveat, because the sentence above is easy to over-read.** `AskParams.prompt` is a Workflow
event payload, and a Workflow engine retains its payload so the instance can resume, so the prompt
does transit and is held by Workflows for the life of the instance. What is absent is any table, key
or log line of ours that holds it. Note also what is NOT in that payload: `AskParams` carries no
user id, so even the retained payload does not say who asked. Keep it that way; adding an invoker to
it would quietly create the attribution the posture section below says does not exist.

KV `CATALOG` holds two ephemeral things and no history: the refreshed model catalog, and a
per-user ask cooldown at `cool:<userId>` with a 60 second TTL enforcing a 3 second gap between asks.

Pins are per person per channel. Lists and errors are ephemeral (`flags: 64`). **Answers are
public**: the deferral is a bare `type: 5` with no flags, so the reply lands in the channel.

## Vocabulary

- **card** is a `ModelCard`: `{ id, provider, task, price }`. `provider` is `cloudflare` or `ollama`.
- **pin** is a user's chosen card for one channel, in D1.
- **place** is `{ userId, guildId, channelId }`, derived from the interaction. In a DM both ids are
  the literal string `dm`.
- **task** is the Workers AI task name, for example `Text Generation`, and `taskKind` narrows it to
  the behaviour family (`asr`, `vision`, `translation`, text).
- **deferral** is interaction response `type: 5`. **publish** is the later REST post that carries
  the answer.

## Contracts

- `src/env.ts` is the hand-authored `Env`. Do not commit `worker-configuration.d.ts`. Do not run
  `wrangler types` into the tree.
- **Call a binding method ON its binding. Never hoist it into a local first.** A binding is a host
  object with internal state on `this`, so `const run = env.AI.run; run(...)` detaches the receiver
  and the binding assigns to a private field on `undefined`. That shipped, and every `/ask` on the
  Workers AI path threw `Cannot set properties of undefined (setting '#options')` from
  `cloudflare-internal:ai-api` until poly-styrene#9. If a cast is needed to type an option, **put it
  on the object, not on the method**: `(ai as unknown as { run: GatewayRun }).run(...)`. A stub whose
  method is an arrow function cannot catch this, because a detached arrow behaves exactly like a
  bound one, so any test for it needs a stub that touches `this`.
- Secrets stay out of `wrangler.jsonc`: `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`,
  `RUNPOD_API_KEY`, `CATALOG_TOKEN`. Presence-check with `${var:+SET}` only, never `${var:-...}`.
- `CATALOG_TOKEN` is a **Workers AI Read** token. **It is not the account token.** The catalog
  refresh calls the model search API because no binding lists models. The cron does not start the
  GPU.
- Tests are node vitest. They must not call `env.AI.run` or RunPod. **Do not import `src/workflow.ts`
  or `src/index.ts` from a test: both import `cloudflare:workers`**, which does not exist in the node
  pool, so the import alone fails the file.
- `OLLAMA_MODEL` and `RUNPOD_ENDPOINT_ID` are optional on `Env`. The code already treats them as
  absent-able and the GPU path refuses when either is missing; keep the type matching the code.
- Model output must never be able to ping the server. Discord REST sends
  `allowed_mentions: { parse: [] }` on both the JSON and the multipart branch of
  `src/discord_rest.ts`. A new send path needs it too.
- The GPU path resolves exactly one model, the configured `OLLAMA_MODEL`. A typed id must not be
  able to pin an arbitrary Ollama model.
- A file attached to a model that cannot read files is refused, not silently ignored. Only `asr` and
  `vision` accept an attachment.
- The Ollama container is Sven Brnn's `svenbrnn/runpod-ollama`, CC BY 4.0,
  <https://github.com/SvenBrnn/runpod-worker-ollama>. It is not vendored. Credit it when the image
  is named.
- Minimal runtime dependencies. Everything here is served by the platform bindings and `fetch`; a
  new runtime dep needs a reason that the bindings cannot meet.
- No em dashes or en dashes in source, docs, or commits.

## The lab

`/lab` runs `sh`, `python` or `node` in a Cloudflare Container and posts the output back. It is a
second, separate backend from the two inference paths and shares nothing with them but the
deferral pattern and the Discord REST client.

**The irreversible decision is the scheduling policy, and it is `default`.** `scheduling_policy` is
deliberately OMITTED from `wrangler.jsonc`, which selects it. `max_instances` is the only
concurrency ceiling that survives our own code being wrong, Cloudflare has no spend cap, and
`max_instances` is **not supported** under the `durable_object` policy. **The policy is immutable
once the application exists**, so changing it means replacing every running instance. Both
`@cloudflare/sandbox` and `@cloudflare/computer`'s container backend require `durable_object`, which
is why neither is used for execution; see poly-styrene#6 and #21 for the reasoning and for what
`computer` does and does not give us.

**Containment is `enableInternet: false` and nothing else.** No outbound handler, deliberately: one
runs in the Workers runtime with access to `env`, so a loose handler hands the sandbox our `DB`,
`CATALOG` and `AI` bindings. The container holds no credential of ours and needs none.
**Measured, not assumed:** poly-styrene#8 confirmed the flag is honoured on the `default` policy,
with bracketing controls executing real code either side of four network probes that all failed.
A contained container and one whose egress silently works look identical from the Worker side, so
if that flag is ever changed, re-run that probe rather than reasoning about it.

**The probe lives on the branch `probe/container-egress`, which is DELIBERATELY NOT MERGED and must
not be pruned.** It is not on `main`, so the sentence above is otherwise an instruction nobody can
follow. It drives the real `LabContainer` with the real `labStartOptions()` and the real image,
which is what makes its answer transfer to `/lab` rather than being a fact about some other
container, and it brackets the four network probes with a control that executes real code at each
end. Read poly-styrene#8 for the full method, including the two-delete teardown and the
`provisioning` readiness gate, both of which cost an attempt to learn.

**Teardown is a platform property, not our diligence, and three things would defeat it.** Cloudflare
stops the instance shortly after the Durable Object goes inactive, and **code running inside an
instance does not count as activity**, so a runaway cannot keep itself alive and a dead Workflow
leaks nothing. Do not add any of these: a Durable Object alarm that checks on the work, a long
inactivity timeout, or a pending `monitor()` call, which under this compatibility date holds the
object in memory for up to fifteen minutes. Each one converts a platform guarantee into our own
correctness.

**The run bound is destroying the container, never `kill()`.** `exec()` has no timeout, `kill()`
does not reach the process's children, `output()` waits for those children, and calling `kill()` or
aborting after a process has exited **raises an uncaught internal error in the Durable Object**. So
this code never calls it. A runaway is stopped by taking the instance away.

**Gating is in code here, unlike `/ask`.** `LAB_ROLE_IDS` is a comma separated list of Discord role
ids and **an empty value denies everyone**, which is how it ships. That is not caution about
containment, which is measured; it is that who may spend money on a billed microVM is Conrad's
decision. `labGate` is closed by default in every direction: no configured roles, no guild, or no
matching role all refuse.

**Everything decidable lives in `src/lab.ts` and `src/lab_journal.ts`**, including both ends of the
Worker-to-sandbox wire format, because `src/lab_container.ts` and `src/lab_workflow.ts` import
`cloudflare:workers` and no vitest file can import them. Keep those two thin. `test/lab.test.ts`
also reads `wrangler.jsonc` and fails if the instance class or the instance cap drifts from the
constants, since those constants only MIRROR config under this policy.

**The journal is metadata only**: `lab_sessions` records who ran a sandbox, where, which instance,
when it started and stopped, and how it ended. **Not the code and not the output.**
`test/lab_journal.test.ts` reads the migration and fails on any column that could hold either. The
quota counts an abandoned open session, so walking away buys no free slot, and `countLabRuns`
reports `-1` rather than `0` on an unreadable count because `labQuota` refuses a negative and would
have ALLOWED a zero.

**Deploying the container needs the Docker daemon**, because the image is a Dockerfile path and
Wrangler builds it. **And a deploy reports the WORKER in about a second while the container
application is still `provisioning`**; curling immediately races it, which cost two probe attempts.
Poll `wrangler containers list` until the state is no longer `provisioning`. Teardown is TWO
deletes: `wrangler delete --name <worker>` leaves the container application behind while printing
success, so delete the application by exact ID as well and then list again to confirm.

## Checks

**`/ask` logs `ask_io_ms` with a split per await**, because the handler has a hard 3 second
Discord deadline and **no test in this repo can fail a deadline**: every test drives `commandAsk`
against in-memory fakes that answer instantly. Read that line before theorising about latency.

**Every split in it is I/O TIME, not wall-clock, and the names say so on purpose.** Workers freezes
the clock except across an I/O boundary, so a zero split means that step did no I/O and compute is
invisible to this instrument by construction. The sum is `io_total` rather than `total` because it
will NOT match a `wrangler tail` `wallTime` and must not be compared to it. **Do not add a timer
around local work expecting a number**: it will correctly read 0, and the next reader will file a
bug against a correct result. If CPU time is ever the question, `wrangler tail` reports `cpuTime`
and that is the right instrument.

**The Workflow create is NOT on the response path, and that is the point rather than a detail.**
It was the only unbounded call left on a path with a hard deadline. Measured on script `84fbf3a8`:
`create` 702 ms of a 998 ms `io_total`, so it dominated the remaining budget and nothing bounds its
tail. It now runs in `ctx.waitUntil` via `startAsk`, **and a failure there is reported through
`publishAnswer`** on the interaction token, the same route `reportFailure` uses, so the user gets a
visible error a second late instead of a deferral that never resolves. A Discord retry colliding on
`already exists` is silent, because the user already has their deferral.

**Create latency is still logged, separately, as `ask_create_ms`.** Moving work off a measured path
must not make it unobservable, or the fix hides the thing it was aimed at. `ask_io_ms` is the
response-path budget and no longer carries a `create` split; a test asserts both of those.

**Testing it needs a fake whose `create` genuinely defers.** `memoryAsk.create` has no `await` in
its body, so it completes SYNCHRONOUSLY and every assertion about `created` passes whether the
create is awaited or deferred. A zero-delay timer gate does not work either, because `handleDiscord`
awaits `crypto.subtle.verify` and that yields far enough for the timer to fire first. The working
shape is an explicitly released gate with a timeout backstop, so a regression fails cleanly rather
than hanging. This is the same stub-shape blindness that hid the AI binding receiver bug.

**The response path is held to two sequential round trips, and that is a budget, not an accident.**
The catalog is read only when an override has to be resolved against it, the pin and the cooldown
are read in one `Promise.all`, and the cooldown write goes to `ctx.waitUntil` because nobody reads
its result before the deferral returns. `test/ask_io.test.ts` asserts those stay removed, since a
removed round trip is invisible to any assertion about the response.

`npm run typecheck` then `npm test`, both green, before a deploy. `tsc` is not part of the vitest
run, so a type error passes the suite silently. `npm run coverage` for the v8 report. CI jobs are
named `ci` and `coverage` and run on `ubuntu-latest`.

## What a fake has to be able to do

**A fake must exhibit the property your assertion depends on. If it cannot behave wrongly, your test
cannot see the rule being broken.** This repo produced two defects from that one root in a single
afternoon, both passing a suite that looked thorough, so it is written here rather than left to be
found a third time.

**Ask what property the defect would violate, then check the fake has it.** Not whether the fake
returns the right shape. Whether it is capable of being wrong.

**Instance one, a receiver.** `test/infer.test.ts` called `runCloudflare` with a stub whose `run` was
an **arrow function that never touched `this`**. `infer.ts` reported 100% function coverage and the
assertions were the ones you would want. But a detached arrow behaves identically to a bound one, so
the stub could not tell a call on the binding from a call that had lost it, and every `/ask` on the
Workers AI path threw `Cannot set properties of undefined (setting '#options')` in production. The
guard now uses a class with a **private field**, the smallest thing that distinguishes them.

**Instance two, an await.** `memoryAsk.create` in `test/fakes.ts` is declared `async` and has **no
`await` in its body**, so it runs to completion **synchronously**. Moving the Workflow create off the
response path into `ctx.waitUntil` therefore changed nothing any test could observe: **all 150 tests
stayed green.** `async` in a signature does not make a fake deferred. If you are asserting about
ordering or timing, the fake has to actually defer.

**Three mechanics worth knowing before writing the deferred fake:**

- **A zero-delay timer is not a reliable "later".** Gating a fake on `setTimeout(resolve, 0)` failed,
  because `handleDiscord` awaits `crypto.subtle.verify` and that yields far enough for the timer to
  fire first. The test then passes for no reason at all.
- **Release the gate explicitly from the test, and give it a timeout backstop.** A gate that never
  resolves turns a regression into a hang, and a timeout reports worse than a clean assertion.
- **Keep a shared fake simple.** `memoryAsk` is synchronous on purpose; the deferred version is local
  to the one file that asserts on deferral, rather than making every other test pay for asynchrony
  it does not care about.

**And the only reliable way to find this class of problem is to run the spec rather than read it.**
Both instances above, plus a third where a log line nothing asserted could be deleted without the
suite noticing, were found by breaking the thing on purpose and watching for red. **A guard that has
never been seen to fail is a guess about the future.**

## Traps

**`src/workflow.ts` has no automated test, and the harness structurally cannot give it one.** It
imports `cloudflare:workers`, which the node vitest pool does not provide, so the module cannot be
imported by a test at all. Measured on `0654a94`: 29 tests pass across 7 files, overall statement
coverage 80.31%, and `workflow.ts` is **0% of 174 lines, uncovered 8 to 167**. `index.ts` is 0% for
the same reason. So the GPU submit, the poll loop, the deferral publish and the failure report are
covered by **reading only**. Logic that can be tested belongs in `infer.ts`, `runpod.ts`, `text.ts`
or `discord_rest.ts`, which are pure and well covered; `workflow.ts` should stay a thin orchestrator
so that the untestable surface stays small.

**But untestable means untestable BY VITEST, not unexercisable.** The module can be driven by a
throwaway worker under `wrangler dev`, which is a real workerd: a `main` that re-exports
`AskWorkflow`, a `workflows` binding pointing at it, and one request that calls `create()` and polls
`status()`. That needs no credential and nothing deployed, and it is how the `#options` defect was
reproduced rather than theorised. Two things to know when you do it: `run()` catches its own
failures, so `status()` returns `complete` and the real stack is in the `wrangler dev` output
instead; and the AI binding always reaches remote, so a logged-in seat will be billed for a real
inference. Reach for that before concluding a change to this file cannot be checked.

**An abandoned GPU job is cancelled, and that is load bearing rather than tidy.** The poll loop
used to walk away from a live job with nothing ever calling `/cancel`, so it kept running and kept
billing with nobody reading the result. `cancelJob` now fires on both abandoning exits: budget
exhaustion cancels BEFORE telling the user, so what the message says about cost is true, and the
catch around the loop cancels on any other abandonment. A job that reached a terminal state on its
own is deliberately NOT cancelled; there is nothing to stop. Cancel reports an outcome rather than
throwing, because it runs on paths that are already failing and must not replace the original error
with its own.

**The poll budget is DERIVED from the endpoint timeout, never restated beside it.** That timeout
lives on RunPod, so it is recorded as `RUNPOD_EXEC_TIMEOUT_SEC` in `wrangler.jsonc` and
`pollPlan()` derives the count from it. **The budget must EXCEED the endpoint timeout**, so a job
the endpoint itself kills is observed as failed rather than abandoned as pending; the sign of that
inequality is the whole defect and it is asserted across several timeout values. The recorded
default is a belief, not a measurement: confirm it against the endpoint and set the var. If it is
too low the budget is merely longer than needed; if it is too high the loop still gives up early,
but cancel now fires, so the failure is bounded rather than silent.

**A deploy is only reproducible if what you deploy is a committed ref, and this repo has been
bitten.** Behaviour that exists only in an uncommitted working tree is invisible to every normal
check: `git status` on the deploy tree is clean, the diff against `main` is clean, the suite is
green, and the deploy prints nothing unusual, because there is nothing for any of them to compare
against. On 2026-10-23 deploying `main` removed `allowed_mentions` from the live Worker for about
twenty minutes for exactly that reason. **Before deploying, diff what `main` LACKS against whatever
tree the current deployment came from, not the other way round**, and prefer committing to carrying
behaviour in an editor. Tracked as poly-styrene#15. The durable half of the fix is a test that fails
when the behaviour is absent, since vigilance is not a control; poly-styrene#14 adds one for the
protection that was lost.

**The Ollama image is pinned by DIGEST, and the repo is the record rather than the control.** The
digest is in `README.md`; the endpoint configuration lives on RunPod, so the two have to be changed
together and this repo cannot enforce what actually runs. What it does enforce is that its own
record does not drift back to a mutable tag, which is the thing that made the original state
invisible: nothing anywhere said which image had run. A tag in a registry we do not control means
the code that receives every prompt sent to the Ollama model can change with no commit here. This
is the one place in the system where code we do not control executes with the prompt in hand.

**A Workflow step return over 1 MiB is dropped.** This is why `runWorkers` downloads the attachment,
infers and publishes inside a single step rather than splitting the download out: file bytes never
cross a step boundary, and a separate download step would bill the model twice if the call then
failed. Do not refactor that step apart.

**The catalog is a few hundred live models and there is no list API for the third-party catalog.**
Typed ids are accepted but not browsable. A catalog of zero does not block a reply; `ensureCatalog`
refreshes behind `ctx.waitUntil`.

**`modelFromId` is the only id parser and it is a security surface**, because whatever it returns
decides which provider gets the prompt and which backend is billed. Keep it closed by default and
return `null` for anything not recognised.

## Posture, which is Conrad's call and not a code defect

Recorded here because a future session will otherwise rediscover it and guess.

- **Gating is at the INSTALL boundary, administered outside this repo.** Conrad restricts the bot
  to one specific server through the Discord application install settings. That is the deliberate
  configuration, decided 2026-10-23, not a gap waiting to be filled.
- **An install restriction and a role allowlist are not the same control, and the difference is the
  whole posture.** An install restriction bounds **which server** the bot can be added to. It does
  not bound **who inside** that server may invoke it. So any member of that one server who can type
  a slash command can ask the abliterated model anything, and the answer posts publicly in the
  channel. That is coherent for a small trusted server; it is not equivalent to per-user gating, and
  nothing here should be read as claiming it is. A role allowlist on `/ask` was considered and
  deliberately not built.
- **The Worker itself performs no authorization of any kind.** There is no guild, channel, role or
  user check anywhere in `src/discord.ts`. The Ed25519 signature authenticates that the request came
  from Discord; it says nothing about who sent it or from where. The only per-user limit is the 3
  second ask cooldown.
- **Because the gate lives outside the code, nothing in this repo can test it, and nothing will go
  red if the bot is later added to a second server.** Do not look for the check in `src/`; there is
  none, by decision. If the restriction is ever relaxed the control disappears silently, and the
  only remaining limits are the cooldown and whatever Discord channel permissions do.
- **`/lab` is the exception and keeps its own in-code role allowlist**, because it is a different
  surface with a billed microVM behind it and it was decided separately.
- **Answers are public in the channel**, including exploit steps.
- **Nothing can attribute an answer to a person.** Every log line carries at most `event`,
  `provider`, `model` and `task`. No log line carries a user, guild, channel or prompt. The `pins`
  table holds user ids, but it records only a model choice, never a question or an answer. There is
  no journal that could answer "who asked this" after the fact.
- The default GPU model is `huihui_ai/foundation-sec-abliterated`, Foundation-Sec-8B with refusals
  removed, and `SYSTEM_PROMPT` asks for exploit steps on **both** paths, so the Workers AI path is
  not a more conservative one.

If gating, an audit trail or an ephemeral-answer mode is wanted, those are product decisions, not
cleanups. Do not add surveillance of prompts without an explicit decision: the absence of a prompt
log is a deliberate property of this design, not an oversight.

## Deploy readiness

`POST /discord` returns **503 `discord is not configured`** until `DISCORD_PUBLIC_KEY` is set as a
Worker secret. The Worker deploys and serves `/health` without it, so a green deploy and a reachable
health check do **not** mean the bot can process a single interaction. The 503 and a 401
`bad signature` are the two readings that tell the states apart: probe
`POST /discord` with no signature header, and a 503 means the key is unset while a 401 means it is
set and the signature simply did not verify.

`GET /health` reports `{ ok, name, gateway, ollama }`, where `ollama` is only
`Boolean(env.RUNPOD_ENDPOINT_ID)`. It proves the binding is configured, not that the GPU works.

### Before a deploy: compare against what is RUNNING, not against another local tree

**Run `npm run predeploy <deployed-bundle> <candidate-bundle>` and do not deploy if it refuses.**

**Why this and not a status check.** On 2026-10-23 deploying `main` removed `allowed_mentions:
{ parse: [] }` from the live Worker for about twenty minutes. Every local instrument said fine:
`git status` clean, the diff against `main` clean, the suite green, the deploy quiet. **They all
agreed because the content being lost had never been committed, so there was nothing for any of them
to compare against.** Another status check or another local diff inherits that blindness exactly.
The only thing that differed was **the artifact already running**, because it had been built from
the uncommitted tree.

**So it has to run BEFORE the deploy.** Afterwards the deployed bundle and the ref match by
construction and nothing can fire.

The sequence:

1. Build the candidate: `npx wrangler deploy --dry-run --outdir /tmp/candidate`
2. Fetch what is live:
   `curl -s -H "authorization: Bearer $CLOUDFLARE_API_TOKEN"
   "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/poly-styrene/content"
   -o /tmp/deployed.raw`
3. `npm run predeploy /tmp/deployed.raw /tmp/candidate/index.js`

**The response IS multipart, measured rather than hedged.** `GET .../content` on this Worker
returned `multipart/form-data`, 140,716 bytes in 2 parts, with the module in the part named
`index.js`. **The tool extracts it for you**, passes a bare module through untouched in case the API
ever stops wrapping, and fails loudly naming the parts it did find rather than comparing a boundary
header against a bundle. Pass a third argument if the part is ever named something else.

**One byte of that is a trap worth knowing about.** Multipart puts a `\r\n` before the next
boundary delimiter and that byte belongs to the format, not the content. Keeping it produced a
persistent one-byte difference against a locally built bundle, 47,343 against 47,344, on every run.
The extractor removes exactly ONE line ending, not all trailing whitespace, because a bundle may
legitimately end in a newline of its own. **It would not have changed a verdict either way**, since
a trailing newline moves no tokens, which is part of why tokens are the comparison surface rather
than bytes.

The download stays an operator step so its output can be eyeballed; everything the tool does to it
is covered by `test/predeploy.test.ts`.

**It compares TOKENS, and that was measured rather than chosen.** Against the real historical pair,
`ac5320a` which carries the fix against its parent `d20f2ee` which does not: a quoted-string
comparison found **zero** deployed-only entries and would not have fired, because `allowed_mentions`
is an object KEY and keys are unquoted. Word-like tokens found **exactly one**, `allowed_mentions`,
with no noise. Tokens are the surface that carries the signal and survives minification, which
mangles local identifiers but not property names. Do not "simplify" it to matching quoted strings;
a test pins that measurement.

**A loss refuses; an addition does not.** Adding behaviour is the normal case and is reported for
information. Only the deployed bundle holding something the candidate lacks is an error, and an
addition in the same deploy does not excuse a loss.

`npm run register` registers slash commands with the bot token, which is not a Worker secret. Global
commands can take about an hour; set `DISCORD_GUILD_ID` to register to one server immediately.
