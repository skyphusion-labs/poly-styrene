# Poly Styrene

This file is the guide for any coding agent and any contributor. Follow it.

## What this project is

Poly Styrene is a Discord bot for technical help in a cybersecurity channel. It answers security engineering questions. One Cloudflare Worker handles Discord. There is no gateway process. `/lab` is a separate Cloudflare Container. Read [README.md](README.md).

The version is in `package.json`. See the latest `v*` tag.

## Commands

Run these before a deploy:

```bash
npm run typecheck
npm test
npm run coverage
```

`tsc` does not run inside Vitest. A type error can pass the test suite. CI jobs are named `ci` and `coverage`. They run on `ubuntu-latest`. See `.github/workflows/ci.yml`.

`npm run register` registers slash commands. The bot token for that call is not a Worker secret. Set `DISCORD_GUILD_ID` to register on one server at once. A global command can take about an hour.

`npm run predeploy` compares a live bundle to a candidate. Run it before a production deploy. The workflow is [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

## Request path

`POST /discord` is the inbound path that does work. `src/index.ts` is the module Wrangler loads. `src/server.ts` routes `/discord`, `/health`, and a plain-text root. `src/discord.ts` checks the Ed25519 signature. It must answer within 3 seconds.

Inference does not fit in that window. `/ask` starts `AskWorkflow` and returns interaction type `5`. The Workflow posts the answer later through the Discord REST API.

The interaction id is the Workflow id. A Discord retry uses the same id. Catch only the already-exists error. Return type `5` for that error. Do not mint a new Workflow id for an ask.

## Inference

Workers AI uses `env.AI.run` through the AI Gateway named `poly-styrene`. The default model is `DEFAULT_MODEL` in source. Ollama uses RunPod serverless. The model id is `OLLAMA_MODEL`. That path scales to zero. A cold start can take minutes.

`SYSTEM_PROMPT` in `src/prompt.ts` goes to both paths. A change there changes every answer. Read the file before you edit the prompt. When a question needs a command, the prompt marks it for defense, detection, or authorized testing.

## State

D1 has two tables. `pins` stores the chosen model for one person in one channel. `lab_sessions` stores lab metadata. See `migrations/`.

This Worker does not store a prompt in a table. This Worker does not store an answer in a table. It does not write either one to a log line.

A Workflow keeps its event payload until the instance ends. `AskParams` includes the prompt for that reason. `AskParams` carries no user id. Keep the payload free of a user id.

KV `CATALOG` holds the model catalog. It also holds a short per-user cooldown. It holds no history. Pins are per person per channel. Lists and errors are ephemeral. Answers are public in the channel.

## Contracts

`src/env.ts` is the hand-authored `Env`. Do not commit `worker-configuration.d.ts`. Do not run `wrangler types` into the tree.

Call a binding method on the binding. Do not copy the method into a local first. A detached method loses its receiver. The Workers AI path then throws. See poly-styrene issue 9.

Keep secrets out of `wrangler.jsonc`. Check presence with `${var:+SET}` only. Do not print a secret with a default-value expansion.

`CATALOG_TOKEN` is a Workers AI read token. It is not the account token. The catalog refresh does not start the GPU.

Tests are node Vitest. Do not call `env.AI.run` from a test. Do not call RunPod from a test. Do not import `src/workflow.ts` from a test. Do not import `src/index.ts` from a test. Both files import `cloudflare:workers`.

Every Discord send sets `allowed_mentions` to an empty parse list. A new send path needs the same setting. Model output must not be able to ping the server.

The GPU path resolves `OLLAMA_MODEL` only. A typed id must not select another Ollama model. An Ollama ask refuses when the endpoint id is empty. It also refuses when the API key is empty.

A file on a model that cannot read files is refused. Only `asr` and `vision` accept an attachment.

The Ollama image is `svenbrnn/runpod-ollama`, under CC BY 4.0. Credit that image when you name it. The digest in the README is the record. Do not replace that digest with a mutable tag.

Runtime code uses platform bindings and `fetch`. A new runtime dependency needs a reason those cannot meet.

## Lab

`/lab` runs a shell, Python, or Node in a Cloudflare Container. It posts the output back. It uses the same deferral pattern as `/ask`. It does not use the inference backends.

Leave `scheduling_policy` unset in `wrangler.jsonc`. The unset value selects `default`. `max_instances` is the cap that still holds if application code is wrong. Do not change the policy on a live application. A policy change means a new application.

Containment is `enableInternet` set to false. Do not add an outbound handler. A handler runs where `env` is in scope. The container holds no credential of ours. If you change that flag, probe real egress before you trust it. A Worker-side success can hide open egress.

Cloudflare stops the instance after the Durable Object is idle. Code inside the instance does not count as activity. Do not add a Durable Object alarm for the lab. Do not add a long inactivity timeout. Do not leave a `monitor()` call pending. Stop a runaway by destroying the instance. Do not call `kill()`.

`LAB_ROLE_IDS` is a comma-separated list of Discord role ids. An empty value denies everyone. That empty value is how the repo ships. Filling the list is an operator decision.

Keep decidable lab logic in `src/lab.ts` and `src/lab_journal.ts`. Keep `src/lab_container.ts` thin. Keep `src/lab_workflow.ts` thin. Tests cannot import a file that imports `cloudflare:workers`.

`lab_sessions` stores who ran a sandbox, where, which instance, and how it ended. It does not store the code. It does not store the output.

A container deploy needs a local Docker daemon. Wrangler builds the image from the Dockerfile. The Worker can look ready while the application is still provisioning. Poll `wrangler containers list` until that state clears. Deleting the Worker leaves the container application. Delete that application by id too. List again and confirm both are gone.

## Checks

A fake must be able to show the broken rule. An arrow stub that ignores `this` cannot catch a lost receiver. An `async` fake with no `await` finishes at once. It cannot prove that work was deferred.

`src/workflow.ts` has no Vitest coverage. `src/index.ts` has none for the same reason. Keep both files thin. Put testable logic in the pure modules. A throwaway Worker under `wrangler dev` can run the Workflow. The AI binding calls the remote service. A logged-in Wrangler session bills a real inference.

Cancel an abandoned GPU job. Do not cancel a job that already finished. `pollPlan()` reads `RUNPOD_EXEC_TIMEOUT_SEC`. The poll budget must exceed the endpoint timeout. Confirm that recorded timeout on the live endpoint.

A Workflow step return over 1 MiB is dropped. Keep attachment bytes inside one step. `modelFromId` is the only id parser. It chooses which provider gets the prompt. Return `null` for an unknown id.

Deploy a committed ref. Behavior that exists only in the work tree is invisible to CI. Run `npm run predeploy` with the live bundle and the candidate. A token only the live bundle has is a failure. An added token is a report. Compare word-like tokens. Do not reduce the compare to quoted strings. See `test/predeploy.test.ts`.

Discord gives `/ask` a 3 second budget. No test here can fail that clock. Read the `ask_io_ms` log before you guess about latency. Those splits are I/O time. A zero split means that step did no I/O. Workflow create runs in `ctx.waitUntil`. A create failure is published on the interaction token. A retry that finds an existing Workflow stays silent.

## Deploy readiness

`POST /discord` returns 503 until `DISCORD_PUBLIC_KEY` is set. `GET /health` can succeed without that key. A 503 on `/discord` means the key is unset. A 401 means the signature check failed. The `ollama` field in `/health` only shows that an endpoint id is set.

## Posture

`/ask` does not check a guild, a role, or a user. The signature check proves Discord sent the body. Install limits live in the Discord application settings. This repo has no test for that setting. `/lab` keeps its role allowlist in this repo.

`/ask` logs may carry the event, the provider, the model, and the task. They omit the user, the guild, the channel, and the prompt. The missing prompt log is a design property. Do not add a prompt log without a product decision.

## Docs

Write Simplified Technical English. Use short sentences. Use one idea per sentence. Use the active present tense. Use plain words. Use the same word every time.

Do not use an em dash (U+2014). Do not use an en dash (U+2013). Use a comma, a semicolon, parentheses, or two hyphens (`--`).

State the limit next to the capability. Do not turn a measured result into a promise.

## Safety

Do not put a secret in a tracked file, a log, or an issue. Try the Worker with `wrangler dev` before a production publish.
