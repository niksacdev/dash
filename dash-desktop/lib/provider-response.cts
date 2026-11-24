import {isRecord,ProviderFailure} from "./runtime-types.cjs";

export function parseProviderObject(text:string):Record<string,unknown> {
  let value:unknown;
  try { value=JSON.parse(text); }
  catch { throw new ProviderFailure("Provider returned malformed JSON."); }
  if (!isRecord(value)) throw new ProviderFailure("Provider returned an invalid JSON object.");
  return value;
}

// Stream readers can reject with provider-authored errors after fetch resolves.
export async function* providerChunks(body:ReadableStream<Uint8Array>, signal?:AbortSignal):AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of body) yield chunk;
  } catch {
    signal?.throwIfAborted();
    throw new ProviderFailure("Provider disconnected while sending its response. Check provider activity before starting another request.");
  }
}

export async function readProviderJson(response:Response, limit:number, signal?:AbortSignal):Promise<Record<string,unknown>> {
  if (!response.body) throw new ProviderFailure("Provider returned an empty response body.");
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body.cancel().catch(()=>{});
    throw new ProviderFailure("Provider response exceeds the permitted size.");
  }
  let bytes = 0;
  const chunks:Uint8Array[] = [];
  for await (const chunk of providerChunks(response.body,signal)) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw new ProviderFailure("Provider response exceeds the permitted size.");
    chunks.push(chunk);
  }
  return parseProviderObject(Buffer.concat(chunks,bytes).toString("utf8"));
}
