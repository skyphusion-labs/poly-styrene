# Poly Styrene

Poly Styrene is a Discord bot for technical help in a cybersecurity channel. It is named after Marianne Joan Elliott-Said, singer of X-Ray Spex.

Ask it about protocols, configuration, debugging, detection, patching, code, and how a mechanism behaves. When a question is about an attack, it names the impact and the defense, and when a question calls for an exploit, payload, or command, it gives the steps, payloads, and commands it asks for, clearly marked for defense, detection, or authorized testing.

Two inference paths:

- **Cloudflare Workers AI**, always on, through the AI Gateway `poly-styrene`. This bills per token on Cloudflare and costs nothing while idle. The default model is `@cf/zai-org/glm-4.7-flash`.
- **One Ollama model** on a RunPod serverless endpoint, using [Sven Brnn's runpod-worker-ollama](https://github.com/SvenBrnn/runpod-worker-ollama) (`svenbrnn/runpod-ollama`, CC BY 4.0, pinned by digest, see below). The model is `huihui_ai/foundation-sec-abliterated` (Foundation-Sec-8B with refusals removed, 4.9GB). The worker count minimum is 0, so the GPU costs **$0/hour** at rest and **$0.58/hour** while a worker is running (16GB serverless pool). A 20GB standard network volume in EU-RO-1 keeps the weights and costs **$1.40/month**. The 20GB container disk is about **$2/month** even while the worker is scaled to zero. A cold start can take a few minutes. `/models` does not start the GPU.

The picker lists every Workers AI model the account search API returns (the live catalog is a few hundred). A typed catalog id such as `author/model` is accepted too, and it bills through the same gateway. Cloudflare does not publish a list API for the full third-party catalog, so those ids are typed, not browsed. Ollama is the one model named above, not the whole Ollama library.

## Commands

| Command | What it does |
| --- | --- |
| `/models` | Filter and page the catalog. The menu pins a model for you in this channel. |
| `/model` | Show your pin, pin a name, or `clear` back to the default. |
| `/ask` | Ask your pinned model. `model` overrides it for this ask. `file` is for image and audio models. `source_lang` and `target_lang` are for translation. |
| `/lab` | Run code in a disposable sandbox with no network. Role gated, and off by default. |

Pins are per person, per channel. Answers are public. Lists and errors are only visible to you. There is a 3 second pause between asks.

Workers AI and typed catalog models bill on Cloudflare. Ollama bills RunPod per GPU-second while the worker is up.

## The lab

`/lab` runs `sh`, `python` or `node` in a Cloudflare Container and posts the output back. It exists
for the work the chat path cannot do: compiling something, reading a binary, checking what a script
actually does.

What bounds it:

- **Role gated, and closed by default.** `LAB_ROLE_IDS` is a comma separated list of Discord role
  ids. **An empty value denies everyone**, which is how it ships. The Ed25519 signature proves a
  request came from Discord; the role is what says who may spend money.
- **No network.** The container starts with `enableInternet: false`, so nothing resolves DNS and
  nothing reaches a third party. Everything the sandbox has is baked into
  `containers/lab/Dockerfile` at build time, and the base image is pinned by digest.
- **No credential.** The container holds none of ours. There is deliberately no outbound handler,
  because one would run in the Workers runtime with access to every binding this Worker has.
- **One sandbox per person**, named from the authenticated invoker, on the `basic` instance class
  (1/4 vCPU, 1 GiB, 4 GB disk), capped at `max_instances: 2` for the whole Worker.
- **Two time bounds.** A run is killed at 2 minutes by destroying the container, because `exec()`
  has no timeout and killing a process does not kill its children. Separately the container carries
  a 5 minute inactivity timeout, which is the platform stopping it if this Worker or the Workflow
  dies. Work inside a container does not count as activity, so a runaway cannot keep itself alive.
- **20 runs per person per day**, counted from the journal. An abandoned open session still counts.

What is recorded: one row per run in `lab_sessions` holding who ran it, where, which instance, when
it started and stopped, and how it ended. **Not the code and not the output.** Rows are pruned after
30 days on the existing cron. Note that the submitted code does transit the Workflow payload, which
the Workflow engine retains for the instance, exactly as an `/ask` prompt already does.

### Before opening the lab to anyone

Two steps, in this order, and the second is not optional:

1. `npx wrangler d1 migrations apply poly-styrene` for `0002_lab_sessions.sql`.
2. **Confirm egress is actually dead from inside a deployed container**, by running something that
   tries to resolve a name and reach a host and watching it fail. `enableInternet: false` is passed
   on the `default` scheduling policy, where the Cloudflare docs make start options optional, and
   every rendered example of that flag uses the other policy. The flag is not verified on this path.
   Until it is, leave `LAB_ROLE_IDS` empty.

Deploying the container needs the Docker daemon running, because Wrangler builds and pushes the
image. `--containers-rollout=none` deploys the Worker without touching the container.

## Connect Discord

The Worker can be deployed before a Discord application exists. `POST /discord` returns 503 until `DISCORD_PUBLIC_KEY` is set.

1. Create an application at <https://discord.com/developers/applications>.
2. Copy the Application ID and the Public Key from General Information.
3. On the Bot tab, reset the token and copy it. That token is only for registering commands. It is not a Worker secret.
4. Put the public key on the Worker: `npx wrangler secret put DISCORD_PUBLIC_KEY`.
5. Set the Interactions Endpoint URL to `https://<worker>.workers.dev/discord`.
6. Invite the bot. Permissions are View Channels, Send Messages, Embed Links, Attach Files, and Read Message History (`117760`):

```
https://discord.com/api/oauth2/authorize?client_id=APPLICATION_ID&permissions=117760&scope=bot%20applications.commands
```

7. Register commands. Global commands can take about an hour. Set `DISCORD_GUILD_ID` to register to one server immediately.

```
DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=... npm run register
```

Do not print the bot token. Do not commit it.

## Develop

```
npm ci
npm run typecheck
npm test
```

`src/env.ts` is hand-authored. Do not commit `worker-configuration.d.ts`.

## License

GNU AGPL-3.0-only. See `LICENSE`.

The Ollama worker image is not part of this repo. It is CC BY 4.0, Copyright Sven Brnn, <https://github.com/SvenBrnn/runpod-worker-ollama>.

## The GPU image is pinned by digest

The RunPod endpoint must run the image by **digest**, not by a tag:

```
svenbrnn/runpod-ollama@sha256:b8024d800783633fb9a2740eacb880bd9ad88bd7cfe70bb31e4f541b938a5536
```

That digest was read from `registry-1.docker.io` on 2026-10-23. It is an OCI
image index, so it holds for whatever architecture the worker runs on, and it is
the same digest the `0.40.8` tag resolved to. Upstream publishes version tags, so
`0.40.8` is a better reference than `latest` if a digest is impractical.

**Why it matters.** A tag is mutable in a registry we do not control. Running
`latest` means the code that receives every prompt sent to the Ollama model can
change with no commit here, nothing going red, and no record of what ran on any
given day. This is the one place in the system where code we do not control
executes with the prompt in hand: the Workers AI path runs on a Cloudflare
binding, and the Worker itself is this repo.

**Applying it is a RunPod-side change.** The endpoint configuration lives on
RunPod, not in `wrangler.jsonc`, so this file is the record and the endpoint has
to be updated to match. Update both together, and update the digest here when
the image is deliberately moved forward.
