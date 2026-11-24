import {parentPort,workerData} from "node:worker_threads";
import {z} from "zod";
import {createLoopbackClient} from "./lmstudio-client.cjs";

const request=z.strictObject({
  key:z.string().min(1).max(300),port:z.number().int().min(1).max(65535),expiresAt:z.number().int(),
});
async function load() {
  const {key,port,expiresAt}=request.parse(workerData);
  const client=await createLoopbackClient(port);
  // Authenticate with a read. No mutation is queued on a connecting socket.
  const loaded=await client.llm.listLoaded();
  for(const handle of loaded){
    if(handle.modelKey!==key)continue;
    const info=await handle.getModelInfo();
    if(info.deviceIdentifier===null)return {modelKey:info.modelKey,identifier:info.identifier};
  }
  const remaining=expiresAt-Date.now();
  if(remaining<=0)throw Error("LM Studio load deadline expired.");
  const handle=await client.llm.load(key,{
    deviceIdentifier:null,identifier:key,signal:AbortSignal.timeout(remaining),verbose:false,
  });
  return {modelKey:handle.modelKey,identifier:handle.identifier};
}
if(!parentPort)throw Error("Expected an isolated LM Studio load worker.");
const reply=parentPort;
void load().then(handle=>reply.postMessage(handle),()=>reply.postMessage(null));
// The owning thread always terminates the worker and all its sockets before reconciliation.
