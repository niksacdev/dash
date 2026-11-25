interface UiReportCandidate {
  id: string;
  label: string;
}

interface UiReportScore {
  candidateId: string;
  score: number | null;
}

interface UiDecisionPolicy {
  provider: "local" | "openrouter";
  requestedModel: string;
  fallbackModel?: string;
  protocol?: "systemone" | "mlx-vlm";
  failAt: number;
  passAt: number;
}

interface UiReportCaseScore extends UiReportScore {
  completeness?: UiCompletenessReceipt;
  pass: boolean | null;
  reason: string;
  opikMetric?: {metricKey:string;nativeScore:number;direction:"higher-is-risk"|"higher-is-better"};
  decision?: UiDecisionPolicy & {status:"passed"|"failed"|"review"|"unscored";actualModel?:string;dispatchedModel?:string;fallbackReason?:string;probabilityYes?:number};
}

interface UiReportMetric {
  id: string;
  label: string;
  method: "deterministic" | "llm-judge" | "opik-judge" | "opik-metric" | "decision-model";
  judge?: string | null;
  threshold: number;
  decisionPolicy?: UiDecisionPolicy;
  comparisonIssue?: string;
  informational?: boolean;
  lineage?: {scope:"general"|"industry"|"customer";familyId:string;parentRevisionId?:string};
  pairedCases: number;
  totalCases: number;
  values: (UiReportScore & { passes: number; scoredCases: number; availableCases?: number })[];
  caseScores?: { caseId: string; values: UiReportCaseScore[] }[];
}

interface UiReportStage {
  name: string;
  status: "skipped" | "running" | "verified" | "fallback";
  model?: string;
}

interface UiReport {
  cacheIssue?: string;
  verdict: "winner" | "tie" | "mixed" | "ungraded" | "incomplete" | "single" | "unsafe";
  winnerId: string | null;
  summary: string;
  decisionRule: string;
  analyzer?: { name: string };
  reporter?: { name: string };
  candidates: UiReportCandidate[];
  metrics: UiReportMetric[];
  observedOutcomes?: {
    label: string;
    values: { candidateId: string; count: number; total: number; caseIds?:string[] }[];
  }[];
  assistance?: {
    analyzer: UiReportStage;
    reporter: UiReportStage;
    reason?: string;
    citations: {
      metricId: string;
      caseId: string;
      observation: "first_higher" | "second_higher" | "equal" | "missing" | "single";
      values: UiReportScore[];
    }[];
  };
}

interface UiGuardrail {
  status: string;
  candidateId?: string;
  caseId?: string;
  message?: string;
  inputTokens?: number | null;
  contextTokens?: number | null;
  requestedInputCap?: number | null;
  requestedOutputCap?: number | null;
  maxOutputTokens?: number | null;
  outputReserve?: number | null;
  source?: string;
  reasoningPolicy?: string;
  inputOptimization?: { status: string; charactersSaved: number };
}

interface UiPerformance {
  id: string;
  title: string;
  created: string;
  status: string;
  fixture: boolean;
  mode: string;
  packKind?: string;
  datasetId?: string | null;
  version?: string | null;
  split?: string | null;
  perCandidate: number;
  candidates: UiCandidateMetrics[];
  history: {
    id: string;
    created: string;
    scores: { candidate: string; scored: number; passed: number | null }[];
  }[];
}

interface UiCandidateMetrics {
  id: string;
  model: string;
  provider: string;
  recorded: number;
  errors: number;
  scored: number;
  passed: number;
  review: number;
  timed: number;
  p50: number | null;
  p95: number | null;
  input: number | null;
  inputCount: number;
  output: number | null;
  outputCount: number;
  watts: number | null;
  powerCount: number;
  energy?:number|null;
  energyCount?:number;
}

interface UiSyncedExperiment {
  id: string;
  candidate: string;
  traces: number;
  scores: number;
}

interface UiOpikReceipt {
  promptVersion?: { id: string; name: string; version: string | null; commit: string | null } | null;
  caseCount: number;
  datasetName: string;
  version?: string | null;
  versionId: string;
  experiments: UiSyncedExperiment[];
}

type UiOpikStatus =
  | { configured: false; error?: string }
  | ({
      configured: true;
      active: boolean;
      workspace: string;
      project: string;
      apiUrl: string;
      hasDashboard: boolean;
    } & (
      | { state: "synced"; receipt: UiOpikReceipt }
      | { state: "ready" | "syncing"; receipt: null }
      | { state: "partial"; receipt: { error: string } | null }
    ));

type UiGuideResult =
  | { status: "ready"; kind: "check" | "question"; text: string; model: string }
  | { status: "offline" | "busy" | "unavailable" | "canceled" };

interface UiImportDraft {
  token: string;
  name: string;
  pack: string;
  version: string;
  split: string;
  count: number;
}

interface UiDatasetMetadata {
  industry?: string;
  family: string;
  category: string;
  tags: string[];
  source: string;
  changeNote: string;
  parentId: string | null;
}

interface UiCommitImport extends UiDatasetMetadata {
  industry: string;
}
