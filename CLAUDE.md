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

## Checks

**`/ask` logs `ask_timing` with a split per await**, because the handler has a hard 3 second
Discord deadline and **no test in this repo can fail a deadline**: every test drives `commandAsk`
against in-memory fakes that answer instantly. Workers freezes the clock except across I/O, so a
zero split means that step did none and the one non-zero split is where the budget went. Read that
line before theorising about latency.

`npm run typecheck` then `npm test`, both green, before a deploy. `tsc` is not part of the vitest
run, so a type error passes the suite silently. `npm run coverage` for the v8 report. CI jobs are
named `ci` and `coverage` and run on `ubuntu-latest`.

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

`npm run register` registers slash commands with the bot token, which is not a Worker secret. Global
commands can take about an hour; set `DISCORD_GUILD_ID` to register to one server immediately.
