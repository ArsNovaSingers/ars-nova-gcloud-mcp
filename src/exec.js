import { spawn } from "node:child_process";

const MAX_OUTPUT = 200_000; // chars returned to the model, per stream
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 540_000;

/**
 * Structured audit line. Cloud Run captures stdout into Cloud Logging, so a
 * JSON object on one line becomes a queryable structured log entry.
 */
function audit(event, payload) {
  process.stdout.write(
    JSON.stringify({
      severity: "NOTICE",
      component: "ars-nova-gcloud-mcp",
      event,
      ts: new Date().toISOString(),
      ...payload,
    }) + "\n"
  );
}

function truncate(s) {
  if (s.length <= MAX_OUTPUT) return s;
  return (
    s.slice(0, MAX_OUTPUT) +
    `\n\n...[truncated ${s.length - MAX_OUTPUT} more characters]`
  );
}

/**
 * Run a binary with an ARGUMENT ARRAY (never a shell string).
 *
 * shell:false means the OS execs the binary directly with these exact argv
 * entries. No shell is involved, so quoting, $VARS, backticks, pipes and
 * semicolons inside an argument are inert data - they cannot become a second
 * command. This is the single most important safety property of this server
 * given it runs as a project Owner.
 */
export function runCommand(binary, args, opts = {}) {
  const timeoutMs = Math.min(
    opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS
  );
  const started = Date.now();

  audit("command_start", { binary, args, cwd: opts.cwd || null, timeoutMs });

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(binary, args, {
      shell: false,
      cwd: opts.cwd || undefined,
      env: {
        ...process.env,
        // Non-interactive: gcloud must never block waiting on a prompt.
        CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
        CLOUDSDK_METRICS_ENVIRONMENT: "ars-nova-gcloud-mcp",
      },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_OUTPUT * 2) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_OUTPUT * 2) stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      audit("command_error", { binary, args, error: err.message });
      resolve({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: `Failed to launch ${binary}: ${err.message}`,
        durationMs: Date.now() - started,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      audit("command_end", {
        binary,
        args,
        exitCode: code,
        timedOut,
        durationMs,
      });
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        timedOut,
        stdout: truncate(stdout),
        stderr: truncate(
          timedOut
            ? stderr + `\n\n[killed after ${timeoutMs}ms timeout]`
            : stderr
        ),
        durationMs,
      });
    });
  });
}

/** Format a command result as the text block an MCP tool returns. */
export function formatResult(res) {
  const parts = [];
  parts.push(
    `exit_code: ${res.exitCode}${res.timedOut ? " (TIMED OUT)" : ""}  duration: ${res.durationMs}ms`
  );
  if (res.stdout.trim()) parts.push(`--- stdout ---\n${res.stdout.trim()}`);
  if (res.stderr.trim()) parts.push(`--- stderr ---\n${res.stderr.trim()}`);
  if (!res.stdout.trim() && !res.stderr.trim())
    parts.push("(no output)");
  return parts.join("\n\n");
}

export { audit };
