import {join} from "node:path";
import {Worker} from "node:worker_threads";
import type {LLM} from "@lmstudio/sdk";
import {isRecord} from "./runtime-types.cjs";

export type LoadedHandle=Pick<LLM,"modelKey"|"identifier">;

export async function loadSdkModel(key:string,port=1234,timeoutMs=120000):Promise<LoadedHandle> {
  // A disposable thread bounds even a stalled SDK authentication or asyncDispose.
  // Another SDK operation must never reconnect this client's pending load.
  const worker=new Worker(join(__dirname,"lmstudio-load-worker.cjs"),{
    workerData:{key,port,expiresAt:Date.now()+timeoutMs}
  });
  let deadline:NodeJS.Timeout|undefined;
  try {
    return await new Promise<LoadedHandle>((resolve,reject)=>{
      const unconfirmed=()=>reject(Error("LM Studio load acknowledgement unavailable."));
      worker.once("error",unconfirmed);
      worker.once("exit",unconfirmed);
      worker.once("message",(reply:unknown)=>{
        if(isRecord(reply) && typeof reply.modelKey==="string" && typeof reply.identifier==="string"){
          resolve({modelKey:reply.modelKey,identifier:reply.identifier});
        }else unconfirmed();
      });
      // Allow the SDK to deliver cancellation at its deadline before forcing teardown.
      deadline=setTimeout(unconfirmed,timeoutMs+250);
    });
  } finally {
    clearTimeout(deadline);
    await worker.terminate();
  }
}
