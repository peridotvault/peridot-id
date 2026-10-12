// graphify OpenCode plugin (V2, dependency-free)
// Injects a knowledge graph reminder as system context when the graph exists.
import { existsSync } from "fs";
import { join } from "path";

const REMINDER =
  "[graphify] knowledge graph at graphify-out/. For focused questions, run graphify query with your question (scoped subgraph, usually much smaller than GRAPH_REPORT.md) instead of grepping raw files. Read GRAPH_REPORT.md only for broad architecture context.";

export default {
  id: "graphify",
  async setup(ctx) {
    const dir = ctx.location.directory;
    let reminded = false;
    await ctx.session.hook("context", (event) => {
      if (reminded) return;
      try {
        if (!existsSync(join(dir, "graphify-out", "graph.json"))) return;
      } catch {
        return;
      }
      event.system.push({ type: "text", text: REMINDER });
      reminded = true;
    });
  },
};
