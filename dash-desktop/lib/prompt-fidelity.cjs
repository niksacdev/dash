// DASH sends the operator's objective verbatim. A generated instruction that
// restates quantities or policy is useful only when its meaning is grounded.
function normalized(text) {
  return String(text).normalize("NFKC").replace(/[\u2010-\u2015]/g,"-").toLowerCase().replace(/\s+/g, " ").trim();
}
const scoring = /\b(?:grader|grading rubric|dataset[- ](?:wide|level)|(?:over|across) (?:all |the )?(?:cases|records|responses)|(?:pass|failure|error|referral|review|acceptance|detection|success) rates?|(?:false|true) (?:accepts?|positives?|negatives?|releases?)|missed (?:out[- ]of[- ]limit|nonconforming) (?:findings|items)|(?:metrics?|percentages?) (?:across|over|for all))\b/i;
const assumedRule = /\b(?:assum(?:e|ed|ing|ption)|infer(?:red)?|implied|presum(?:e|ed)|by default|standard practice|industry standard|typical(?:ly)?|customary|rule of thumb)\b/i;
const implicitDecision = /\b(?:decision rule\s*:|boundary convention|unless (?:stated|specified|noted) otherwise|(?:less|greater) than or equal|(?:usual|default|standard|normal) (?:tolerance|procedure|policy)|(?:is|means|deem(?:ed)?|treat(?:ed)? as) (?:out[- ]of[- ]spec|nonconforming|within spec|acceptable|a pass)|(?:part|lot|item) (?:passes|fails|is accepted|is released))\b|[≤≥]|[<>]=/i;
const quantitativeRule = /±|\+\s*\/\s*-|plus or minus|\b(?:margin|tolerance|threshold|guard band|uncertainty allowance|safety factor) (?:of|equal to|at|is|should be|defaults? to)\b/i;
const units = /(?:^|\s)(?:mm|cm|nm|µm|μm|kg|mg|kPa|MPa|psi|mV|kWh|rpm|°[CF]|millime(?:ter|tre)s?|microns?|inches|pounds|kilograms?)(?=\s|[.,;:)]|$)/gi;
const dependent = /\b(?:as (?:described|specified|calculated) (?:above|below)|the following rule|this assumption|that assumption|the assumed tolerance|apply this rule|use this tolerance)\b/i;

const unrequestedFields = ["uncertainty", "sampling plan", "drawing revision", "calibration", "tolerance", "safety factor"];
const externalAuthority = /\b(?:NIST|JPL|ISO|EDGAR|XBRL|SEC|ASTM|ASME)\b/g;
const protectedWarning = /^(?:do not|don't|never|avoid)\s+(?:assum|infer|invent|apply|use|calculat|comput|imput)/i;
function sentencesOf(text) {
  return text.replace(/^\s*(?:[-*]\s+|\d+[.)]\s+)/gm, "").split(/(?<=[.!?])\s+|[;\r\n]+/).map(s=>s.trim()).filter(Boolean);
}
function inspectionCheck(domain, objective, dataset) {
  const task = objective + " " + (dataset?.system || "");
  if (domain !== "Manufacturing" || !/\b(?:limit|tolerance|specification)\b/i.test(task) || !/\b(?:measur\w*|reading|dimension)\b/i.test(task)) return null;
  return {
    prompt:"Cite the supplied measurement and its stated limit to explain the proposed disposition.",
    criterion:"The proposed disposition is supported by the supplied measurement and its stated limit.",
    source:"DASH built-in manufacturing inspection check",
  };
}
function candidateGuidance(prompt, {objective, dataset, domain, expert = false}) {
  // Deliberately exclude expert proposals, previous runs and hidden case data.
  // User-entered budgets specify API limits and cannot become inspection limits.
  const sources = [objective, dataset?.system].filter(Boolean);
  if (dataset?.outputSchema) {
    // Scalar schema descriptions may contain genuine task instructions.
    const walk = value => {
      if (typeof value === "string") sources.push(value);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(dataset.outputSchema);
  }
  const verbatim = new Set(sources.flatMap(sentencesOf).map(s => normalized(s).replace(/[.!?]+$/, "")));
  const source = normalized(sources.join(" "));
  const sentences = sentencesOf(prompt);
  const kept = [], omissions = [];
  for (const raw of sentences) {
    const sentence = raw.trim();
    const body = normalized(sentence).replace(/[.!?]+$/, "");
    const supported = verbatim.has(body);
    const negativeWarning = protectedWarning.test(sentence) && !/\d|[,;]|\b(?:but|however|instead|unless|otherwise|and (?:then|assume|apply|use))\b/i.test(sentence);
    let problem = null;
    if (!supported && !negativeWarning) {
      if (!expert && /\b(?:expert brief|case titled|expert findings|planner suggestions?)\b|\)\s*,?\s*(?:requirements|metrics)\s*\(/i.test(body)) problem = "internal planner narration";
      else if (scoring.test(body) || (!expert && /\b(?:required rule or metric|metric to apply)\b/i.test(body))) problem = "cross-case grading instructions";
      else if (assumedRule.test(sentence) || quantitativeRule.test(sentence) || implicitDecision.test(sentence)) problem = "an assumed decision rule";
      else if (/\d/.test(sentence)) problem = "an unverified numerical instruction";
      else if (!expert && unrequestedFields.some(field=>body.includes(field) && !source.includes(field))) problem = "an unrequested decision input";
      else if ([...sentence.matchAll(externalAuthority)].some(m=>!source.includes(m[0].toLowerCase()))) problem = "an unrequested external authority";
      else if ([...sentence.matchAll(units)].some(m=>!source.includes(m[0].trim().toLowerCase()))) problem = "an unverified unit";
    }
    if (problem) omissions.push(problem);
    else kept.push(sentence);
  }
  let text = kept.join(" ");
  const supplement = !expert && omissions.length && inspectionCheck(domain, objective, dataset);
  if (supplement && !/\b(?:cite|compare|identify|extract|explain)\b/i.test(text)) {
    text = [supplement.prompt,text].filter(Boolean).join(" ");
    return { text, omitted:omissions.length, reasons:[...new Set(omissions)], supplementSource:supplement.source };
  }
  if (!text || (omissions.length && (dependent.test(text) || !/\b(?:use|read|extract|compare|identify|state|return|report|review|verify|cite|record|check|route|flag|base|preserve|provide|explain|determine|include|keep|decide|follow|assess|inspect)\b/i.test(text))))
    throw Error("the implementer added unsupported rules, quantities or cross-case scoring; write standalone per-case guidance using only stated facts");
  return { text, omitted:omissions.length, reasons:[...new Set(omissions)] };
}
module.exports = { candidateGuidance, inspectionCheck };
