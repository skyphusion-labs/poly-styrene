import type { Env } from "./env";
import { retentionCutoff } from "./lab";
import { pruneLabSessions } from "./lab_journal";
import { refreshCatalog } from "./refresh";
import { handleRequest } from "./server";

export { AskWorkflow } from "./workflow";
export { LabWorkflow } from "./lab_workflow";
export { LabContainer } from "./lab_container";

const handler: ExportedHandler<Env> = {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  scheduled(controller, env, ctx) {
    console.log(JSON.stringify({ event: "catalog_cron", cron: controller.cron }));
    ctx.waitUntil(refreshCatalog(env));
    // The lab journal has a retention window rather than being kept forever.
    // It rides the existing cron because it needs no schedule of its own.
    ctx.waitUntil(pruneLabSessions(env.DB, retentionCutoff(Date.now())));
  },
};

export default handler;
