import type { LMStudioClient } from "@lmstudio/sdk";

export function createLoopbackClient(port=1234): Promise<LMStudioClient> {
  return import("@lmstudio/sdk").then(({ LMStudioClient }) => new LMStudioClient({
    baseUrl:"ws://127.0.0.1:"+port,
    // The SDK logger defaults to console and can receive the provider's raw errors.
    logger:{info(){},debug(){},warn(){console.warn("LM Studio SDK warning. Check Local runtimes.");},
      error(){console.error("LM Studio SDK error. Check Local runtimes and server activity.");}},
  }));
}
let client: Promise<LMStudioClient> | undefined;
export function lmClient(): Promise<LMStudioClient> {
  return client ??= createLoopbackClient();
}
