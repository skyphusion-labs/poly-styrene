# poly-styrene

Poly Styrene is a Discord bot for technical help in a cybersecurity channel. The Worker is the Discord interactions endpoint. Cloudflare Workers AI, through the `poly-styrene` AI Gateway, is the always-on path. One serverless Ollama model on RunPod is the GPU path, and it scales to zero.

## Contracts

- `src/env.ts` is the hand-authored `Env`. Do not commit `worker-configuration.d.ts`. Do not run `wrangler types` into the tree.
- Secrets stay out of `wrangler.jsonc`: `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`, `RUNPOD_API_KEY`, `CATALOG_TOKEN`. Presence-check with `${var:+SET}` only.
- `CATALOG_TOKEN` is a Workers AI Read token. It is not the account token. The catalog refresh calls the model search API because no binding lists models. The cron does not start the GPU.
- Tests are node vitest. They must not call `env.AI.run` or RunPod. Do not import `src/workflow.ts` or `src/index.ts` from a test: that module imports `cloudflare:workers`.
- No em dashes or en dashes in source, docs, or commits.
- The Ollama container is Sven Brnn's `svenbrnn/runpod-ollama`, CC BY 4.0, https://github.com/SvenBrnn/runpod-worker-ollama. It is not vendored. Credit it when the image is named.

## Checks

`npm run typecheck` and `npm test` before a deploy. CI jobs are named `ci` and `coverage` and run on `ubuntu-latest`.
