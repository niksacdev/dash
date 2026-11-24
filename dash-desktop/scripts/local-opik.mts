import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const revision = "cbc0c11195a51951ad472dde4bb82cab47b21ab6"; // upstream release 2.2.144
const files: Record<string, string> = {
  "docker-compose.yaml": "031915a58859acffcb19d243fc98781b138577af7c2229da9374ec693b7c603b",
  "nginx_default_local.conf": "6e5b5866f6e06634c81efc5d76437e546732700c123cfb275a9cbb87f4cba50a",
  "clickhouse_config/additional_config.xml": "c229be6125c3a3f9b939eac7deccc4c789d4700e71cf851548780e99387c31d0",
  "clickhouse_config/users.d/distributed_insert_queue.xml": "bd60bcc6e29a11e98473d62a931fdefcb2a57ad300baf46f03ddcc914262ada1",
  "clickhouse_config/users.d/enable_time_type.xml": "58c26efa56f0dc70969a5cd70d56a8c9c4889787a7e719dbb53126b1b73521fb",
};
const minio = "cloudpirates/image-minio@sha256:8dc02a7e509336c8bbb67962086d691bdcde20a2c9327ed68e5081a681f6dbfc";
const images = {
  mysql: "mysql@sha256:ac80b6e09e5b12b4f9d5cd4f6425e43464247aa4ba4f6169da5daf59e5877f7d",
  redis: "redis@sha256:c8bb255c3559b3e458766db810aa7b3c7af1235b204cfdb304e79ff388fe1a5a",
  clickhouse: "clickhouse/clickhouse-server@sha256:1d45e52080e6ed136a6377863046a0e53d69fb0418d799f12e23184ed6460c55",
  "clickhouse-init": "alpine@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412",
  zookeeper: "zookeeper@sha256:dfa9ba46d14bd52bcb3c1dac3ba91f179cf4cebf7ee576e1c2df09c68fc1d30d",
  "minio-init": minio, minio, mc: minio,
  backend: "ghcr.io/comet-ml/opik/opik-backend@sha256:7821de5b07b849617dac3bd0cd3f6f577ec324a3d9ef86cc9e089a223924831e",
  frontend: "ghcr.io/comet-ml/opik/opik-frontend@sha256:8f70709a95b604560092fe4fe4a8cf9a3b5fd86c721afe5a6461bb32201ecc57",
};
const volumes = ["mysql", "redis-data", "clickhouse", "clickhouse-config", "clickhouse-server", "zookeeper", "minio-data"];
const project = "dash-opik-local";
const owner = "io.dash.local-opik";
const port = 51734;
const origin = "http://127.0.0.1:" + port;
const cache = join(homedir(), ".dash", "opik-local");
const upstream = join(cache, revision);
const override = join(cache, "dash.compose.yaml");

export function composeOverride(): string {
  const label = `labels: {"${owner}": "1"}`;
  const services = Object.entries(images).map(([name, image]) => {
    const extra: Record<string, string> = {
      "clickhouse-init": '    command: ["sh", "-c", "cp -R /clickhouse_config_files/. /config && chown -R 1000:1000 /config && chmod -R a+rX /config"]',
      frontend: `    ports: !override ["127.0.0.1:${port}:5173"]`,
      backend: "    ports: !reset []\n    environment:\n      OPIK_USAGE_REPORT_ENABLED: 'false'\n      TOGGLE_WELCOME_WIZARD_ENABLED: 'false'",
    };
    return `  ${name}:\n    image: ${image}\n    pull_policy: missing\n    ${label}\n${extra[name] ?? ""}`;
  });
  return "services:\n" + services.join("\n") + "\nnetworks:\n  default:\n    " + label +
    "\nvolumes:\n" + volumes.map(name => "  " + name + ":\n    " + label).join("\n") + "\n";
}

function atomicWrite(file: string, data: string | Uint8Array, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  writeFileSync(temp, data, { mode, flag: "wx" });
  renameSync(temp, file);
}
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
// These five public upstream files are bind-mounted into containers. The private
// cache directory protects them on the host while 0644 allows container UIDs to read them.
export async function cachePublicFile(file: string, expected: string, download: () => Promise<Uint8Array>): Promise<void> {
  if (existsSync(file) && hash(readFileSync(file)) === expected) {
    chmodSync(file, 0o644);
    return;
  }
  const bytes = await download();
  if (hash(bytes) !== expected) throw Error("Pinned Opik configuration checksum mismatch for " + file);
  atomicWrite(file, bytes, 0o644);
}

async function replyBytes(response:Response,maxBytes:number):Promise<Buffer> {
  if (!response.body) throw Error("The service returned an empty response.");
  if (Number(response.headers.get("content-length"))>maxBytes) {
    await response.body.cancel().catch(()=>{});
    throw Error("The service response exceeded the permitted size.");
  }
  const chunks:Uint8Array[]=[];
  let size=0;
  for await(const chunk of response.body) {
    size+=chunk.byteLength;
    if (size>maxBytes) throw Error("The service response exceeded the permitted size.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks,size);
}

async function prepare(): Promise<void> {
  for (const [name, expected] of Object.entries(files)) {
    await cachePublicFile(join(upstream, name), expected, async () => {
      const response = await fetch(`https://raw.githubusercontent.com/comet-ml/opik/${revision}/deployment/docker-compose/${name}`,
        { redirect: "error", signal: AbortSignal.timeout(30000) });
      if (!response.ok) {
        await response.body?.cancel().catch(()=>{});
        throw Error("Could not download upstream "+name+" (HTTP "+response.status+").");
      }
      return replyBytes(response,1_048_576);
    });
  }
  chmodSync(join(upstream, "clickhouse_config"), 0o755);
  chmodSync(join(upstream, "clickhouse_config", "users.d"), 0o755);
  atomicWrite(override, composeOverride());
}

export function localEndpoint(endpoint: string): boolean {
  return /^unix:\/\/\/[^\0]+$/.test(endpoint) || /^npipe:\/\/\/\/\.\/pipe\/[^/]+$/.test(endpoint);
}

// Preserve the selected Docker connection and credential helper, but do not interpolate
// ambient provider credentials, Compose overrides or telemetry destinations into services.
const cliEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  /^(PATH|HOME|USER|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|SystemRoot|TMP|TEMP|TMPDIR|LANG|XDG_RUNTIME_DIR|XDG_CONFIG_HOME|DOCKER_CONFIG|DOCKER_CONTEXT|DOCKER_HOST|DOCKER_TLS_VERIFY|DOCKER_CERT_PATH|SSH_AUTH_SOCK|HTTP_PROXY|NO_PROXY|HTTPS_PROXY)$/i.test(k)));
Object.assign(cliEnv, { COMPOSE_DISABLE_ENV_FILE: "1", OPIK_VERSION: "2.2.144", COMPOSE_PARALLEL_LIMIT: "3" });

function launchError(error:unknown):Error {
  const code=typeof error==="object" && error!==null && "code" in error ? error.code : undefined;
  if(code==="ENOENT") return Error("Docker CLI was not found. Install Docker with the Compose plugin and reopen the terminal.");
  if(code==="ETIMEDOUT") return Error("The Docker command timed out. Check the local engine and run npm run opik:status before retrying.");
  return Error("Docker could not complete the command. Check the selected local Docker context and engine.");
}
function docker(...args: string[]): string {
  try {
    return execFileSync("docker", args, { env: cliEnv, encoding: "utf8", timeout: 30000,
      stdio: ["ignore","pipe","pipe"] }).trim();
  } catch(error) {throw launchError(error);}
}
function action(args: string[], timeout: number): void {
  const result = spawnSync("docker", args, { env: cliEnv, stdio: "inherit", timeout });
  if (result.error) throw launchError(result.error);
  if (result.status !== 0) throw Error("Docker failed. Run npm run opik:status to inspect the local stack.");
}
function engine(start: boolean): void {
  if (process.env.DOCKER_HOST && !localEndpoint(process.env.DOCKER_HOST))
    throw Error("Choose a local Docker socket. DASH will not change this remote Docker host.");
  const context = docker("context", "show");
  const endpoint = docker("context", "inspect", context, "--format", '{{(index .Endpoints "docker").Host}}');
  if (!localEndpoint(endpoint)) throw Error("Choose a local Docker context before managing this stack: " + context);
  try { docker("info", "--format", "{{.ServerVersion}}"); }
  catch {
    if (!start || !["darwin", "win32"].includes(process.platform) || !["default","desktop-linux","desktop-windows"].includes(context))
      throw Error("Docker is unavailable on the selected local context " + context + ". Start Docker and retry.");
    action(["desktop", "start", "--timeout", "150"], 165000);
    docker("info", "--format", "{{.ServerVersion}}");
  }
}

function composeArgs(): string[] {
  return ["compose", "--project-name", project, "--project-directory", upstream,
    "-f", join(upstream, "docker-compose.yaml"), "-f", override, "--profile", "opik"];
}

// Refuse an existing project or reserved resource with another owner before mutating it.
function checkOwnership(): void {
  for (const [kind, name, extra] of [["container","Names",["--all"]],["network","Name",[]],["volume","Name",[]]] as const) {
    const reserved = new Set(kind === "container" ? Object.keys(images).map(name => project + "-" + name + "-1") :
      kind === "network" ? [project + "_default"] : volumes.map(name => project + "_" + name));
    const rows = docker(kind,"ls",...extra,"--format",`{{.${name}}}|{{.Label "com.docker.compose.project"}}|{{.Label "${owner}"}}`);
    for (const line of rows.split("\n")) {
      const [resource, composition, label] = line.split("|");
      if ((composition === project || reserved.has(resource)) &&
          (composition !== project || label !== "1"))
        throw Error("The local Opik name is already in use by another Docker resource: " + resource);
    }
  }
}
function frontendPublished(): boolean {
  const binding = docker("ps", "--filter","label=com.docker.compose.project="+project,
    "--filter","label=com.docker.compose.service=frontend","--filter","label="+owner+"=1","--format","{{.Ports}}");
  return binding.includes(`127.0.0.1:${port}->5173/tcp`);
}
async function checkPort(): Promise<void> {
  if (frontendPublished()) return;
  await new Promise<void>((done, fail) => {
    const probe = createServer();
    probe.once("error", () => fail(Error("Local port " + port + " is occupied or inaccessible. Its existing listener was left running.")));
    probe.listen(port,"127.0.0.1",() => probe.close(err => err ? fail(err) : done()));
  });
}
export async function healthy(request: typeof fetch = fetch): Promise<boolean> {
  try {
    const options = { redirect: "error" as const, signal: AbortSignal.timeout(4000) };
    const nginx = await request(origin + "/health", options);
    if (!nginx.ok) {
      await nginx.body?.cancel().catch(()=>{});
      return false;
    }
    if ((await replyBytes(nginx,1024)).toString("utf8").trim() !== "healthy") return false;
    const api = await request(origin + "/api/v1/private/projects?size=1", options);
    if (!api.ok || !api.headers.get("content-type")?.includes("application/json")) {
      await api.body?.cancel().catch(()=>{});
      return false;
    }
    const page:unknown=JSON.parse((await replyBytes(api,1_048_576)).toString("utf8"));
    return !!page && typeof page === "object" && "content" in page && Array.isArray(page.content) &&
      "total" in page && typeof page.total === "number";
  } catch { return false; }
}
async function main(command: string | undefined): Promise<void> {
  if (command !== "start" && command !== "stop" && command !== "status")
    throw Error("Usage: npm run setup:local | opik:start | opik:status | opik:stop");
  engine(command === "start");
  checkOwnership();
  if (command !== "start" && !existsSync(override)) {
    console.log("Local Opik has not been set up. Run npm run setup:local.");
    if (command === "status") process.exitCode = 1;
    return;
  }
  if (command === "status") {
    action([...composeArgs(), "ps", "--all"],30000);
    const ready = frontendPublished() && await healthy();
    console.log(ready ? "Local dashboard and API ready at " + origin : "Local dashboard and API unavailable. Resume with npm run opik:start.");
    if (!ready) process.exitCode = 1;
    return;
  }
  if (command === "stop") {
    action([...composeArgs(), "stop", ...Object.keys(images)],180000);
    console.log("DASH’s Opik services stopped. Named volumes retain your experiments.");
    return;
  }
  await checkPort();
  console.log("Preparing pinned Opik 2.2.144. First start downloads public images and initializes local databases.");
  await prepare();
  action([...composeArgs(), "up", "-d", "--no-build", "--pull", "missing", "frontend", "mc"],1200000);
  for (let i=0; i<60; i++) {
    if (frontendPublished() && await healthy()) {
      atomicWrite(join(cache,"connection.json"), JSON.stringify({version:1, port})+"\n");
      console.log("Local dashboard and API ready at " + origin + ". Open DASH with npm start.");
      return;
    }
    await delay(2000);
  }
  throw Error("The local frontend/API did not become ready. Inspect npm run opik:status and retry npm run opik:start.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
