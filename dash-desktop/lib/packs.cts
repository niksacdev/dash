import * as fs from "node:fs";
import * as path from "node:path";
import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {validateCase} from "./evaluation-cases.cjs";
import {isRecord,isCaseRow,isScenarioPack,objectValue,stringValue,errorMessage,jsonText} from "./run-types.cjs";
import type {ScoredPack,ScenarioPack,DatasetCase,CaseRow} from "./run-types.cjs";

export const hash = (value:unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function field(obj:unknown, key:string):unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (v, k) =>
        isRecord(v) && Object.hasOwn(v, k) ? v[k] : undefined,
      obj,
    );
}
function decimal(value:unknown) {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value))
    return undefined;
  let [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  whole = whole.replace(/^0+(?=\d)/, "");
  fraction = fraction.replace(/0+$/, "");
  return (
    (value.startsWith("-") && (whole !== "0" || fraction) ? "-" : "") +
    whole +
    (fraction ? "." + fraction : "")
  );
}
function equal(pack:ScoredPack, key:string, actual:unknown, expected:unknown):boolean {
  if (pack.decimalFields.includes(key) && expected !== null) {
    const target = decimal(expected);
    return target !== undefined && decimal(actual) === target;
  }
  if (isRecord(expected)) {
    return (
      isRecord(actual) &&
      Object.keys(expected).every((k) =>
        equal(pack, key + "." + k, actual[k], expected[k]),
      )
    );
  }
  return isDeepStrictEqual(actual, expected);
}
// JSON.parse retains only the last value for each key. Inspect valid JSON tokens
// before discarding duplicates so an ambiguous record cannot pass the grader.
function duplicateKey(text:string) {
  const objects:Set<string>[] = [];
  const tokens = /("(?:\\.|[^"\\])*")\s*(:)?|[{}]/g;
  for (const match of text.matchAll(tokens)) {
    if (match[0] === "{") objects.push(new Set());
    else if (match[0] === "}") objects.pop();
    else if (match[2]) {
      const key = JSON.parse(match[1]);
      const keys = objects.at(-1);
      if(!keys) throw Error("Invalid JSON object");
      if (keys.has(key)) return key;
      keys.add(key);
    }
  }
  return null;
}
export function grade(pack:ScoredPack, row:CaseRow, text:string) {
  const reasons = [];
  let output:unknown;
  try {
    output = JSON.parse(text);
    const duplicate = duplicateKey(text);
    if (duplicate !== null) reasons.push("Duplicate output key: " + duplicate);
  } catch {
    reasons.push("Response is invalid JSON");
  }
  if (!isRecord(output))
    reasons.push("Expected a JSON object");
  else {
    for (const check of pack.checks) {
      const target = field(row, check.ref);
      if (
        target === undefined &&
        check.optional &&
        !Object.hasOwn(output, check.key)
      )
        continue;
      if (!equal(pack, check.key, field(output, check.key), target))
        reasons.push("Mismatch in " + check.key);
    }
    for (const key of pack.quotes) {
      const quote = field(output, key);
      if (
        quote != null &&
        (typeof quote !== "string" ||
          !quote.length ||
          !(pack.sourceText && isRecord(row.input) && String(row.input[pack.sourceText] ?? "").includes(quote)))
      )
        reasons.push("Unsupported quote in " + key);
    }
  }
  const proposedAccept = isRecord(output) && output[pack.decisionField] === pack.accept;
  const pass = reasons.length === 0;
  return {
    pass,
    reasons,
    ready: pass && proposedAccept,
    falseAccept: !pass && proposedAccept,
    review: !(pass && proposedAccept),
  };
}
export function parseDataset(text:string, pack:ScenarioPack):DatasetCase[] {
  if (Buffer.byteLength(text) > 2_000_000)
    throw Error("Maximum dataset size is 2 MB.");
  const seen = new Set();
  const rows:DatasetCase[] = [];
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const row = objectValue(jsonText(line),"case");
      if (duplicateKey(line) !== null) throw Error("Duplicate JSON key");
      if (
        !row ||
        !/^[\w.-]{1,100}$/.test(
          typeof row.case_id === "string" ? row.case_id : "",
        ) ||
        seen.has(row.case_id)
      )
        throw Error("Missing, invalid or duplicate case ID");
      validateCase(row, pack);
      if (pack.kind !== "reference") {
        if (
          !isRecord(row.input) || !isRecord(row.gold)
        )
          throw Error("Expected input and gold objects");
        if (pack.sourceText && typeof row.input[pack.sourceText] !== "string")
          throw Error("Missing source text");
        for (const check of pack.checks)
          if (!check.optional && field(row, check.ref) === undefined)
            throw Error("Missing " + check.ref);
        if (![pack.accept, pack.review].includes(String(row.gold[pack.decisionField])))
          throw Error("Invalid gold decision");
      }
      if (!isCaseRow(row) || !row.dataset_version.trim()) throw Error("Expected split and dataset_version");
      if (
        rows.length &&
        (rows[0].split !== row.split ||
          rows[0].dataset_version !== row.dataset_version)
      )
        throw Error("Mixed dataset versions or splits");
      if (rows.length >= 200) throw Error("Limit is 200 cases");
      rows.push(row);
      seen.add(row.case_id);
    } catch (e) {
      throw Error("Line " + (i + 1) + ": " + errorMessage(e));
    }
  }
  if (!rows.length) throw Error("The dataset has no cases.");
  return rows;
}
export function loadPacks() {
  const root = path.join(__dirname, "../packs");
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((f) => f.isDirectory())
    .map((f) => {
      const read = (name:string) =>
        fs.readFileSync(path.join(root, f.name, name), "utf8");
      const { casesFile = "cases.jsonl", ...pack } = objectValue(jsonText(read("pack.json")), "scenario pack");
      if (!isScenarioPack(pack) || pack.kind === "reference") throw Error("Invalid domain scenario pack: " + f.name);
      const rows = parseDataset(read(stringValue(casesFile)), pack);
      return { pack, rows, replay: objectValue(jsonText(read("replay.json")),"fixture replay") };
    });
}
