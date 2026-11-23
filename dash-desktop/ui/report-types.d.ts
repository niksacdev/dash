interface UiReportCandidate {
  id: string;
  label: string;
}

interface UiReportScore {
  candidateId: string;
  score: number | null;
}

interface UiReportCaseScore extends UiReportScore {
  pass: boolean | null;
  reason: string;
}

interface UiReportMetric {
  id: string;
  label: string;
  method: "deterministic" | "llm-judge" | "opik-judge";
  judge?: string | null;
  threshold: number;
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
  verdict: "winner" | "tie" | "mixed" | "ungraded" | "incomplete" | "single";
  winnerId: string | null;
  summary: string;
  decisionRule: string;
  analyzer?: { name: string };
  reporter?: { name: string };
  candidates: UiReportCandidate[];
  metrics: UiReportMetric[];
  observedOutcomes?: {
    label: string;
    values: { candidateId: string; count: number; total: number }[];
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
