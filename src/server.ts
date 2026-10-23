import { handleDiscord, type WaitCtx } from "./discord";
import type { Env } from "./env";

export async function handleRequest(request: Request, env: Env, ctx: WaitCtx): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/discord") return handleDiscord(request, env, ctx);
  if (url.pathname === "/health") {
    return Response.json({
      ok: true,
      name: "poly-styrene",
      gateway: env.GATEWAY_ID,
      ollama: Boolean(env.RUNPOD_ENDPOINT_ID),
    });
  }
  return new Response("Poly Styrene. Discord interactions live at /discord.", {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
