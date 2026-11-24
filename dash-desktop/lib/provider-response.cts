import {isRecord} from "./runtime-types.cjs";

export function parseProviderObject(text:string):Record<string,unknown> {
  let value:unknown;
  try { value=JSON.parse(text); }
  catch { throw Error("Provider returned malformed JSON."); }
  if (!isRecord(value)) throw Error("Provider returned an invalid JSON object.");
  return value;
}

export async function readProviderJson(response:Response, limit:number):Promise<Record<string,unknown>> {
  if (!response.body) throw Error("Provider returned an empty response body.");
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body.cancel().catch(()=>{});
    throw Error("Provider response exceeds the permitted size.");
  }
  let bytes = 0;
  const chunks:Uint8Array[] = [];
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw Error("Provider response exceeds the permitted size.");
    chunks.push(chunk);
  }
  return parseProviderObject(Buffer.concat(chunks,bytes).toString("utf8"));
}
