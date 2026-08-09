import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { audit } from "./exec.js";

/**
 * Fire-and-forget a long command.
 *
 * Claude's custom-connector layer aborts a tool call at 60 seconds, but a
 * Cloud Run source deploy takes 2-6 minutes. Rather than lose the result, we
 * detach the process and let the caller poll for status afterwards.
 *
 * IMPORTANT: this only survives the HTTP response if the Cloud Run service has
 * CPU always allocated (--no-cpu-throttling). With default request-scoped CPU
 * the child is frozen the instant we reply, and the deploy never finishes.
 */
export function spawnDetached(binary, args, label) {
  const logPath = path.join(tmpdir(), `${label}-${Date.now()}.log`);
  const fd = openSync(logPath, "a");

  audit("detached_start", { binary, args, logPath });

  const child = spawn(binary, args, {
    shell: false,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
    },
  });
  child.unref();

  return { pid: child.pid, logPath };
}
