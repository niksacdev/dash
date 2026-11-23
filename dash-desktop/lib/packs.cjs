const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function field(obj, key) {
  return key
    .split(".")
    .reduce(
      (v, k) =>
        v && typeof v === "object" && Object.hasOwn(v, k) ? v[k] : undefined,
      obj,
    );
}
function decimal(value) {
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
function equal(pack, key, actual, expected) {
  if (pack.decimalFields.includes(key) && expected !== null) {
    const target = decimal(expected);
    return target !== undefined && decimal(actual) === target;
  }
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    return (
      !!actual &&
      typeof actual === "object" &&
      Object.keys(expected).every((k) =>
        equal(pack, key + "." + k, actual[k], expected[k]),
      )
    );
  }
  return isDeepStrictEqual(actual, expected);
}
// JSON.parse retains only the last value for each key. Inspect valid JSON tokens
// before discarding duplicates so an ambiguous record cannot pass the grader.
function duplicateKey(text) {
  const objects = [];
  const tokens = /("(?:\\.|[^"\\])*")\s*(:)?|[{}]/g;
  for (const match of text.matchAll(tokens)) {
    if (match[0] === "{") objects.push(new Set());
    else if (match[0] === "}") objects.pop();
    else if (match[2]) {
      const key = JSON.parse(match[1]);
      const keys = objects.at(-1);
      if (keys.has(key)) return key;
      keys.add(key);
    }
  }
  return null;
}
function grade(pack, row, text) {
  const reasons = [];
  let output;
  try {
    output = JSON.parse(text);
    const duplicate = duplicateKey(text);
    if (duplicate !== null) reasons.push("Duplicate output key: " + duplicate);
  } catch {
    reasons.push("Response is invalid JSON");
  }
  if (!output || typeof output !== "object" || Array.isArray(output))
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
          !row.input[pack.sourceText].includes(quote))
      )
        reasons.push("Unsupported quote in " + key);
    }
  }
  const proposedAccept = output?.[pack.decisionField] === pack.accept;
  const pass = reasons.length === 0;
  return {
    pass,
    reasons,
    ready: pass && proposedAccept,
    falseAccept: !pass && proposedAccept,
    review: !(pass && proposedAccept),
  };
}
function parseDataset(text, pack) {
  if (Buffer.byteLength(text) > 2_000_000)
    throw Error("Maximum dataset size is 2 MB.");
  const seen = new Set();
  const rows = [];
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (duplicateKey(line) !== null) throw Error("Duplicate JSON key");
      if (
        !row ||
        !/^[\w.-]{1,100}$/.test(
          typeof row.case_id === "string" ? row.case_id : "",
        ) ||
        seen.has(row.case_id)
      )
        throw Error("Missing, invalid or duplicate case ID");
      require("./evaluation-cases.cjs").validateCase(row, pack);
      if (pack.kind !== "reference") {
        if (
          !row.input ||
          typeof row.input !== "object" ||
          Array.isArray(row.input) ||
          !row.gold ||
          typeof row.gold !== "object" ||
          Array.isArray(row.gold)
        )
          throw Error("Expected input and gold objects");
        if (pack.sourceText && typeof row.input[pack.sourceText] !== "string")
          throw Error("Missing source text");
        for (const check of pack.checks)
          if (!check.optional && field(row, check.ref) === undefined)
            throw Error("Missing " + check.ref);
        if (![pack.accept, pack.review].includes(row.gold[pack.decisionField]))
          throw Error("Invalid gold decision");
      }
      if (
        !["development", "holdout"].includes(row.split) ||
        typeof row.dataset_version !== "string" ||
        !row.dataset_version.trim()
      )
        throw Error("Expected split and dataset_version");
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
      throw Error("Line " + (i + 1) + ": " + e.message);
    }
  }
  if (!rows.length) throw Error("The dataset has no cases.");
  return rows;
}
function loadPacks() {
  const root = path.join(__dirname, "../packs");
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((f) => f.isDirectory())
    .map((f) => {
      const read = (name) =>
        fs.readFileSync(path.join(root, f.name, name), "utf8");
      const { casesFile = "cases.jsonl", ...pack } = JSON.parse(read("pack.json"));
      const rows = parseDataset(read(casesFile), pack);
      return { pack, rows, replay: JSON.parse(read("replay.json")) };
    });
}
module.exports = { loadPacks, parseDataset, grade, hash };
