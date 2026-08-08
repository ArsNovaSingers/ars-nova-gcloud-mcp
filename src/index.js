import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./tools.js";
import { audit } from "./exec.js";

const PORT = process.env.PORT || 8080;
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const DISABLED = process.env.MCP_DISABLED === "1";

if (!AUTH_TOKEN) {
  console.error(
    "FATAL: MCP_AUTH_TOKEN is not set. Refusing to start an unauthenticated gcloud endpoint."
  );
  process.exit(1);
}

function createServer() {
  const server = new Server(
    { name: "ars-nova-gcloud-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [
          { type: "text", text: `Unknown tool: ${req.params.name}` },
        ],
        isError: true,
      };
    }
    if (DISABLED) {
      return {
        content: [
          {
            type: "text",
            text:
              "This server is DISABLED (MCP_DISABLED=1). No commands will run. " +
              "Re-enable with: gcloud run services update ars-nova-gcloud-mcp --region us-central1 --update-env-vars MCP_DISABLED=0",
          },
        ],
        isError: true,
      };
    }
    try {
      const text = await tool.handler(req.params.arguments || {});
      return { content: [{ type: "text", text }] };
    } catch (err) {
      audit("tool_exception", { tool: tool.name, error: err.message });
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

const app = express();
app.use(express.json({ limit: "25mb" }));

// Health check / friendly root.
app.get("/", (_req, res) => {
  res.status(200).send(
    `ars-nova-gcloud-mcp is running.${DISABLED ? " [DISABLED]" : ""} MCP endpoint: POST /mcp`
  );
});

// Claude probes these during the Add-connector flow. A 401 tells it to fall
// back to the query-param/no-OAuth path instead of starting an OAuth dance.
app.all(/^\/\.well-known\/.*/, (_req, res) => res.status(401).end());

function authorized(req) {
  const q = req.query.key;
  if (typeof q === "string" && q === AUTH_TOKEN) return true;
  const h = req.get("authorization") || "";
  if (h.startsWith("Bearer ") && h.slice(7) === AUTH_TOKEN) return true;
  return false;
}

app.post("/mcp", async (req, res) => {
  if (!authorized(req)) {
    audit("auth_rejected", { ip: req.ip, path: req.path });
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
  }

  // Stateless mode: a fresh Server + transport per request. Matches the
  // pattern already proven to work with Claude custom connectors.
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    audit("transport_error", { error: err.message });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET/DELETE on /mcp are not supported in stateless mode.
app.get("/mcp", (_req, res) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)" },
    id: null,
  })
);

app.listen(PORT, () => {
  audit("server_start", {
    port: PORT,
    disabled: DISABLED,
    toolCount: TOOLS.length,
  });
});
