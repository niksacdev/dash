import {isRecord} from "./runtime-types.cjs";

// Only DASH-authored text belongs in a diagnostic. Runtime exception messages and
// HTTP response bodies can include the full rendered prompt, credentials, or local paths.
export function reportsTemplateFailure(error:unknown):boolean {
  const message=typeof error==="string" ? error : isRecord(error) && typeof error.message==="string" ? error.message : "";
  return /\b(?:chat template|prompt template|jinja2?|template (?:could not render|rendering|error)|roles? must alternate)\b/i.test(message.slice(0,4096));
}
export const templateAdvice="Check the model's chat template and supported message roles in its runtime.";
export function httpGuidance(status:number):string {
  switch (status) {
    case 400: case 415: case 422: return "Check the request format and the model's supported inputs.";
    case 401: return "Check the credentials configured for this endpoint.";
    case 403: return "Check permission to use the endpoint and selected model.";
    case 404: return "Verify the endpoint and selected model ID.";
    case 408: case 504: return "The provider timed out. Check its activity before starting another request.";
    case 413: return "Shorten the input or select a model with sufficient context.";
    case 429: return "Check the provider's rate limits or quota before trying again.";
    default: return status>=500 ? "Check provider availability and activity before starting another request." : "Check the endpoint configuration.";
  }
}

// Older compatible endpoints persisted only an HTTP status. Derive the UI hint
// from that code without changing the historical receipt or accepting provider text.
export function operatorProviderMessage(message:string):string {
  const match=/^Model endpoint returned HTTP ([1-5]\d\d)$/.exec(message);
  return match ? message+". "+httpGuidance(Number(match[1])) : message;
}
