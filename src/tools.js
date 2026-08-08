import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand, formatResult, audit } from "./exec.js";

const DEFAULT_PROJECT =
  process.env.GCLOUD_DEFAULT_PROJECT || "ars-nova-org-mcp";
const DEFAULT_REGION = process.env.GCLOUD_DEFAULT_REGION || "us-central1";

/** Reject path traversal / absolute paths in caller-supplied file paths. */
function safeRelPath(p) {
  if (typeof p !== "string" || !p.length) throw new Error("empty file path");
  if (path.isAbsolute(p)) throw new Error(`absolute path not allowed: ${p}`);
  const norm = path.normalize(p);
  if (norm.startsWith("..") || norm.includes(`..${path.sep}`))
    throw new Error(`path traversal not allowed: ${p}`);
  return norm;
}

/** Write {path, content} pairs into a fresh temp dir; return the dir. */
async function materialize(files) {
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-src-"));
  for (const f of files) {
    const rel = safeRelPath(f.path);
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, f.content ?? "", "utf8");
  }
  audit("materialized_source", { dir, fileCount: files.length });
  return dir;
}

function envPairs(envVars) {
  if (!envVars) return null;
  const pairs = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);
  return pairs.length ? pairs.join(",") : null;
}

export const TOOLS = [
  {
    name: "gcloud_run",
    description:
      "Run any gcloud command. Pass the command as an ARRAY of arguments, WITHOUT the leading 'gcloud'. " +
      'Example: ["run","services","list","--project","ars-nova-org-mcp"]. ' +
      "Runs as a project Owner service account in ars-nova-org-mcp with no shell interpretation. " +
      "Prompts are auto-disabled, so include flags like --quiet where a command would otherwise ask for confirmation. " +
      "Use --format=json or --format=value(...) to keep output small.",
    inputSchema: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description:
            "Argument array, excluding the word 'gcloud'. Each flag and value should generally be its own element.",
        },
        timeout_seconds: {
          type: "number",
          description: "Optional. Default 120, max 540.",
        },
      },
      required: ["args"],
    },
    handler: async ({ args, timeout_seconds }) => {
      if (!Array.isArray(args) || args.length === 0)
        throw new Error("args must be a non-empty array of strings");
      const res = await runCommand("gcloud", args.map(String), {
        timeoutMs: timeout_seconds ? timeout_seconds * 1000 : undefined,
      });
      return formatResult(res);
    },
  },

  {
    name: "gsutil_run",
    description:
      "Run a Cloud Storage command via 'gcloud storage'. Pass args WITHOUT the leading 'gcloud storage'. " +
      'Example: ["ls","gs://my-bucket"].',
    inputSchema: {
      type: "object",
      properties: {
        args: { type: "array", items: { type: "string" } },
        timeout_seconds: { type: "number" },
      },
      required: ["args"],
    },
    handler: async ({ args, timeout_seconds }) => {
      const res = await runCommand(
        "gcloud",
        ["storage", ...args.map(String)],
        { timeoutMs: timeout_seconds ? timeout_seconds * 1000 : undefined }
      );
      return formatResult(res);
    },
  },

  {
    name: "deploy_mcp_from_files",
    description:
      "Create or update a Cloud Run service from source files supplied inline. " +
      "Writes the files to a temp directory and runs 'gcloud run deploy --source'. " +
      "This is the primary way to stand up a NEW MCP server without any local checkout or console work. " +
      "Include a Dockerfile in the files for full control, or omit it to let Cloud Run's buildpacks infer the runtime.",
    inputSchema: {
      type: "object",
      properties: {
        service_name: {
          type: "string",
          description:
            "Cloud Run service name. Lowercase letters, digits and hyphens only.",
        },
        files: {
          type: "array",
          description:
            "Every file needed to build the service, as relative paths.",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description:
                  "Relative path, e.g. 'src/index.js' or 'Dockerfile'.",
              },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
        env_vars: {
          type: "object",
          description: "Optional runtime environment variables.",
          additionalProperties: { type: "string" },
        },
        allow_unauthenticated: {
          type: "boolean",
          description:
            "Default true. Needed for Claude custom connectors, which cannot send Google credentials.",
        },
        service_account: {
          type: "string",
          description:
            "Optional service account email for the NEW service to run as.",
        },
        region: { type: "string" },
        project: { type: "string" },
        memory: { type: "string", description: "e.g. '512Mi', '1Gi'." },
        timeout_seconds: {
          type: "number",
          description: "Deploy timeout. Default 540 (builds are slow).",
        },
      },
      required: ["service_name", "files"],
    },
    handler: async (a) => {
      if (!Array.isArray(a.files) || !a.files.length)
        throw new Error("files must be a non-empty array");
      const dir = await materialize(a.files);
      const args = [
        "run",
        "deploy",
        a.service_name,
        "--source",
        dir,
        "--region",
        a.region || DEFAULT_REGION,
        "--project",
        a.project || DEFAULT_PROJECT,
        "--port",
        "8080",
        "--quiet",
      ];
      if (a.allow_unauthenticated !== false) args.push("--allow-unauthenticated");
      if (a.service_account) args.push("--service-account", a.service_account);
      if (a.memory) args.push("--memory", a.memory);
      const envs = envPairs(a.env_vars);
      if (envs) args.push("--set-env-vars", envs);

      const res = await runCommand("gcloud", args, {
        timeoutMs: (a.timeout_seconds || 540) * 1000,
      });
      return formatResult(res);
    },
  },

  {
    name: "deploy_mcp_from_github",
    description:
      "Clone a PUBLIC GitHub repo and deploy it to Cloud Run from source. " +
      "Use subdir when the service lives in a subdirectory (e.g. 'mcp-server').",
    inputSchema: {
      type: "object",
      properties: {
        service_name: { type: "string" },
        repo_url: {
          type: "string",
          description: "Public HTTPS clone URL, e.g. https://github.com/org/repo.git",
        },
        branch: { type: "string", description: "Default: repo default branch." },
        subdir: {
          type: "string",
          description: "Optional subdirectory within the repo to deploy from.",
        },
        env_vars: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        allow_unauthenticated: { type: "boolean" },
        service_account: { type: "string" },
        region: { type: "string" },
        project: { type: "string" },
      },
      required: ["service_name", "repo_url"],
    },
    handler: async (a) => {
      const dir = await mkdtemp(path.join(tmpdir(), "mcp-git-"));
      const cloneArgs = ["clone", "--depth", "1"];
      if (a.branch) cloneArgs.push("--branch", a.branch);
      cloneArgs.push(a.repo_url, dir);

      const clone = await runCommand("git", cloneArgs, { timeoutMs: 120_000 });
      if (!clone.ok)
        return `git clone failed.\n\n${formatResult(clone)}`;

      const srcDir = a.subdir ? path.join(dir, safeRelPath(a.subdir)) : dir;
      const args = [
        "run",
        "deploy",
        a.service_name,
        "--source",
        srcDir,
        "--region",
        a.region || DEFAULT_REGION,
        "--project",
        a.project || DEFAULT_PROJECT,
        "--port",
        "8080",
        "--quiet",
      ];
      if (a.allow_unauthenticated !== false) args.push("--allow-unauthenticated");
      if (a.service_account) args.push("--service-account", a.service_account);
      const envs = envPairs(a.env_vars);
      if (envs) args.push("--set-env-vars", envs);

      const res = await runCommand("gcloud", args, { timeoutMs: 540_000 });
      return `git clone OK.\n\n${formatResult(res)}`;
    },
  },

  {
    name: "list_services",
    description: "List Cloud Run services with their URLs.",
    inputSchema: {
      type: "object",
      properties: {
        region: { type: "string" },
        project: { type: "string" },
      },
    },
    handler: async (a) => {
      const res = await runCommand("gcloud", [
        "run",
        "services",
        "list",
        "--region",
        a.region || DEFAULT_REGION,
        "--project",
        a.project || DEFAULT_PROJECT,
        "--format",
        "table(metadata.name,status.url,status.conditions[0].status)",
      ]);
      return formatResult(res);
    },
  },

  {
    name: "get_logs",
    description:
      "Read recent Cloud Logging entries for a Cloud Run service. Use this to debug a failed deploy or a 500.",
    inputSchema: {
      type: "object",
      properties: {
        service_name: { type: "string" },
        limit: { type: "number", description: "Default 50." },
        freshness: {
          type: "string",
          description: "How far back to look, e.g. '1h', '30m', '2d'. Default '1h'.",
        },
        project: { type: "string" },
      },
      required: ["service_name"],
    },
    handler: async (a) => {
      const res = await runCommand("gcloud", [
        "logging",
        "read",
        `resource.type=cloud_run_revision AND resource.labels.service_name=${a.service_name}`,
        "--limit",
        String(a.limit || 50),
        "--freshness",
        a.freshness || "1h",
        "--project",
        a.project || DEFAULT_PROJECT,
        "--format",
        "value(timestamp,severity,textPayload,jsonPayload.message)",
      ]);
      return formatResult(res);
    },
  },

  {
    name: "enable_api",
    description:
      "Enable one or more Google Cloud APIs, e.g. 'run.googleapis.com'.",
    inputSchema: {
      type: "object",
      properties: {
        apis: { type: "array", items: { type: "string" } },
        project: { type: "string" },
      },
      required: ["apis"],
    },
    handler: async (a) => {
      const res = await runCommand(
        "gcloud",
        [
          "services",
          "enable",
          ...a.apis.map(String),
          "--project",
          a.project || DEFAULT_PROJECT,
        ],
        { timeoutMs: 300_000 }
      );
      return formatResult(res);
    },
  },

  {
    name: "whoami",
    description:
      "Show the active gcloud identity, default project and region for this server. Use this first if anything behaves unexpectedly.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const res = await runCommand("gcloud", [
        "auth",
        "list",
        "--format",
        "value(account,status)",
      ]);
      return (
        `default_project: ${DEFAULT_PROJECT}\ndefault_region: ${DEFAULT_REGION}\n\n` +
        formatResult(res)
      );
    },
  },
];
