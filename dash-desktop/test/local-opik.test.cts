import { test } from "node:test";
import assert = require("node:assert/strict");
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
const manager = import("../scripts/local-opik.mjs");

test("local setup accepts local Docker sockets and rejects remote engines", async () => {
  const { localEndpoint } = await manager;
  assert.equal(localEndpoint("unix:///var/run/docker.sock"), true);
  assert.equal(localEndpoint("npipe:////./pipe/docker_engine"), true);
  for (const endpoint of ["ssh://example.org", "tcp://example.org:2375", "tcp://localhost:2376",
    "npipe:////some-pc/pipe/docker_engine", "unix://example.org/socket", ""]) {
    assert.equal(localEndpoint(endpoint), false, endpoint);
  }
});

test("the setup CLI explains a missing Docker executable before creating a local stack",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"dash-cli-dependency-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const env={...process.env,PATH:root,HOME:root,USERPROFILE:root,DOCKER_HOST:"",DOCKER_CONTEXT:""};
  const result=spawnSync(process.execPath,[path.resolve(__dirname,"../scripts/local-opik.mjs"),"start"],
    {env,cwd:root,encoding:"utf8",timeout:10_000});
  assert.equal(result.status,1);
  assert.match(result.stderr,/Docker CLI was not found.*Compose/);
  assert.deepEqual(fs.readdirSync(root),[]);
});

test("only the loopback frontend is exposed, images are pinned, and usage reporting is disabled", async () => {
  const { composeOverride } = await manager;
  const local = composeOverride();
  assert.match(local, /ports: !override \["127\.0\.0\.1:51734:5173"\]/);
  assert.match(local, /ports: !reset \[\]/);
  assert.match(local, /OPIK_USAGE_REPORT_ENABLED: 'false'/);
  const images = [...local.matchAll(/^    image: (.+)$/gm)].map(match => match[1]);
  assert.equal(images.length, 10);
  assert.ok(images.every(image => /@sha256:[a-f0-9]{64}$/.test(image)));
  assert.doesNotMatch(local, /python-backend|demo-data-generator/);
});

test("the readiness check requires both the frontend and an Opik project page and refuses redirects", async () => {
  const { healthy } = await manager;
  function gateway(body: string, mime: string, frontend = "healthy\n"): typeof fetch {
    return async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.equal(url.origin, "http://127.0.0.1:51734");
      assert.equal(options?.redirect, "error");
      return url.pathname === "/health" ? new Response(frontend) :
        new Response(body, {headers: {"Content-Type": mime}});
    };
  }
  assert.equal(await healthy(gateway('{"total":0,"content":[]}',"application/json")), true);
  assert.equal(await healthy(gateway("<html>Dashboard</html>","text/html")), false);
  assert.equal(await healthy(gateway('{"ok":true}',"application/json")), false);
  assert.equal(await healthy(gateway('{"total":0,"content":[]}',"application/json","hello")), false);
  assert.equal(await healthy(async () => {throw Error("offline");}), false);
});

test("readiness releases failed and oversized response streams",async()=>{
  const {healthy}=await manager;
  for(const failure of ["gateway","mime","oversize"]){
    let released=false,requests=0;
    const answer:typeof fetch=async()=>{
      requests++;
      if(requests===1 && failure==="mime") return new Response("healthy");
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller){controller.enqueue(new Uint8Array(2048));},
        cancel(){released=true;},
      }),{status:failure==="gateway"?503:200,headers:{"content-type":"text/html"}});
    };
    assert.equal(await healthy(answer),false);
    assert.equal(released,true,failure+" response must release its reader");
  }
});

test("verified public files are readable inside containers, repaired offline and kept on download failure", async t => {
  const { cachePublicFile } = await manager;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dash-opik-config-"));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const file = path.join(root,"probe.xml"), good = Buffer.from("<config/>");
  const digest = createHash("sha256").update(good).digest("hex");
  await cachePublicFile(file,digest,async()=>good);
  const offline = () => assert.fail("Cached bytes should have been reused.");
  if (process.platform !== "win32") fs.chmodSync(file,0o600);
  await cachePublicFile(file,digest,offline);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777,0o644);
  await assert.rejects(cachePublicFile(file,"0".repeat(64),async()=>Buffer.from("wrong")),/checksum mismatch/);
  assert.deepEqual(fs.readFileSync(file),good);
});
