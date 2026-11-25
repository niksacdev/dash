/** Carries only an operator-facing diagnostic constructed by DASH. */
export class ProviderFailure extends Error {}
/** No prediction was submitted. An explicitly configured alternative may be used. */
export class ProviderPreflightError extends ProviderFailure {}
/** An explicit provider rejection with a known outcome. Other dispatch errors may follow an accepted request. */
export class ProviderRejectedError extends ProviderFailure {}

export type LocalProvider = "lmstudio" | "ollama";
export type EndpointSection = "Frontier Labs" | "Fine-tuned" | "Hosted";
export interface ChatTurn { role: "system" | "user" | "assistant"; content: string }
export type OutputSchema = Record<string, unknown>;

interface CandidateIdentity {
  id: string;
  model: string;
  revision?: string | null;
  loaded?: boolean | null;
  contextTokens?: number | null;
  maxContextTokens?: number | null;
  maxOutputTokens?: number | null;
  parameterSize?: string | null;
  quantization?: string | null;
  reasoningOff?: boolean;
  nativeChat?: boolean;
}
export interface LocalCandidate extends CandidateIdentity {
  nativeKey?:string;
  provider: LocalProvider;
  kind: "model";
}
export interface CompatibleCandidate extends CandidateIdentity {
  provider: "compatible";
  kind: "model";
  section: EndpointSection;
  endpoint: string;
  keyRequired: boolean;
  needsKey?: boolean;
}
export interface FixtureCandidate extends CandidateIdentity {
  provider: "fixture";
  kind: "fixture";
}
export type ModelCandidate = LocalCandidate | CompatibleCandidate;
export type Candidate = ModelCandidate | FixtureCandidate;

export interface RuntimeInstance {
  model: string;
  id: string;
  type: string | null;
  context: number | null;
  quantization: string | null;
}
interface ServerStatus {
  provider: LocalProvider;
  title: string;
  address: string;
  checkedAt: string;
  models: LocalCandidate[];
  instances: RuntimeInstance[] | null;
}
export type RuntimeInventory = ServerStatus & ({online:true; error?:never} | {online:false; error:string});

export interface TokenReceipt {
  readonly tokens: number;
  readonly source: string;
  readonly contextTokens?: number;
}
export interface TokenCheck {
  candidate: Candidate;
  messages: ChatTurn[];
  cap?: number | null;
  signal?: AbortSignal;
  measureContext?: boolean;
  disableThinking?: boolean;
}
export type CheckInputBudget = (request: TokenCheck) => Promise<TokenReceipt | null>;
export type PlanningProgress =
  | {phase:"processing-prompt";percent:number;inputTokens?:number}
  | {phase:"generating";approximateOutputTokens:number|null};
export interface InvokeOptions {
  onPlanningProgress?: (progress:PlanningProgress) => void;
  onCandidateUsage?: (usage:CandidateUsage) => void;
  strictSchema?:boolean;
  signal: AbortSignal;
  structured?: OutputSchema | null;
  onText?: (text: string) => void;
  apiKey?: string;
  inputBudget?: TokenReceipt | null;
  planning?: boolean;
  judging?: boolean;
  maxTokens?: number;
}
export interface InferenceTelemetry {
  latency_ms: number;
  first_token_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  provider_first_token_ms?: number | null;
  reasoning_tokens?: number | null;
  tokens_per_second?: number | null;
  load_ms?: number | null;
  model_instance_id?: string | null;
  load_ns?: number | null;
  prompt_ns?: number | null;
  generation_ns?: number | null;
  runtime_stop_reason?: string;
  reasoning_control?: string;
  reasoning_content_present?: boolean;
}
export interface InferenceResult {
  output: string;
  finishReason: string | null;
  reportedFinishReason?: string | null;
  telemetry: InferenceTelemetry;
}
// Callers that depend on a verified budget reject this result. The case recorder
// can still retain a confirmed answer. Keep its content out of error serialization.
export class ConfirmedInputMismatch extends Error {
  readonly #response: InferenceResult;
  constructor(response: InferenceResult, expectedTokens: number) {
    super(`LM Studio reported ${response.telemetry.input_tokens ?? "unknown"} input tokens after verifying ${expectedTokens}. The run cannot be scored. Check the model's runtime and template.`);
    this.#response = response;
  }
  get response(): InferenceResult { return this.#response; }
}
export type ModelLoadReceipt = {status:"already-loaded"|"loaded";instanceId:string}|{status:"unconfirmed"};
export interface RuntimeAdapters {
  loadLocalModel?(nativeKey:string):Promise<ModelLoadReceipt>;
  discover(): Promise<RuntimeInventory[]>;
  invoke(candidate: ModelCandidate, messages: ChatTurn[], options: InvokeOptions): Promise<InferenceResult>;
  reportStage?(candidate: ModelCandidate, messages: ChatTurn[], options: InvokeOptions): Promise<InferenceResult>;
  checkInputBudget?: CheckInputBudget;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}


export function isCandidate(value: unknown): value is Candidate {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.model !== "string") return false;
  if (value.loaded != null && typeof value.loaded !== "boolean") return false;
  for (const field of ["reasoningOff", "nativeChat"]) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") return false;
  }
  for (const field of ["revision", "parameterSize", "quantization"]) {
    if (value[field] != null && typeof value[field] !== "string") return false;
  }
  for (const field of ["contextTokens", "maxContextTokens", "maxOutputTokens"]) {
    if (value[field] != null && !isPositiveInteger(value[field])) return false;
  }
  if (value.provider === "fixture") return value.kind === "fixture";
  if (value.kind !== "model") return false;
  if (value.provider === "lmstudio" || value.provider === "ollama") return true;
  return value.provider === "compatible" && typeof value.endpoint === "string" && typeof value.keyRequired === "boolean" &&
    (value.needsKey === undefined || typeof value.needsKey === "boolean") &&
    (value.section === "Frontier Labs" || value.section === "Fine-tuned" || value.section === "Hosted");
}

export function isModelCandidate(value: unknown): value is ModelCandidate {
  return isCandidate(value) && value.provider !== "fixture";
}
