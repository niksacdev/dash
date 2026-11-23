import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const localOpikPort = 51734;
const loopback = `http://127.0.0.1:${localOpikPort}`;

/** The marker records a successful local setup. It cannot supply an arbitrary host or credentials. */
export function localOpikEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  marker = join(homedir(), ".dash", "opik-local", "connection.json"),
): NodeJS.ProcessEnv {
  if (env.DASH_OPIK_API_URL) return env;
  try {
    const metadata = statSync(marker);
    if (!metadata.isFile() || metadata.size > 1024) return env;
    const value: unknown = JSON.parse(readFileSync(marker, "utf8"));
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
        !("port" in value) || value.port !== localOpikPort) return env;
    return {
      DASH_OPIK_API_URL: loopback + "/api",
      DASH_OPIK_UI_URL: loopback,
      OPIK_WORKSPACE: "default",
      OPIK_PROJECT_NAME: "DASH",
    };
  } catch {
    return env;
  }
}
