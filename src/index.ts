import type { Env } from "./env";
import { refreshCatalog } from "./refresh";
import { handleRequest } from "./server";

export { AskWorkflow } from "./workflow";

const handler: ExportedHandler<Env> = {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  scheduled(controller, env, ctx) {
    console.log(JSON.stringify({ event: "catalog_cron", cron: controller.cron }));
    ctx.waitUntil(refreshCatalog(env));
  },
};

export default handler;
