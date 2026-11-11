import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { createSessionCosts } from "./server.mjs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const costs = createSessionCosts();
const servers = new Map();
const session = await joinSession({
  canvases: [createCanvas({
    id: "session-costs",
    displayName: "Session costs",
    description: "Lists Copilot sessions; pick one to see its cost, rate of change and recent calls.",
    open: async (ctx) => {
      let entry = servers.get(ctx.instanceId);
      if (!entry) {
        const scope = ctx.extensionId.split(":")[0];
        const name = basename(dirname(fileURLToPath(import.meta.url)));
        entry = await costs.start({
          requestUpgrade: ["user", "project", "session"].includes(scope) ? async (update) => {
            await session.send({
              prompt: `I clicked Upgrade in the Session costs canvas. Use the supported install_extension tool to upgrade this installation to ${update.version}: URL ${update.installUrl}, name ${JSON.stringify(name)}, scope ${scope}. Preserve that exact name and scope; do not install to another scope or replace files manually. The installer reloads extensions in this session. Release notes: ${update.notesUrl}.`,
            });
          } : undefined,
        });
        servers.set(ctx.instanceId, entry);
      }
      return { title: "Session costs", url: entry.url };
    },
    onClose: async (ctx) => {
      const entry = servers.get(ctx.instanceId);
      if (entry) { servers.delete(ctx.instanceId); await new Promise((resolve) => entry.server.close(() => resolve())); }
    },
  })],
});
