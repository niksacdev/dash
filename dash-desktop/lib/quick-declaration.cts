import {isRecord} from "./runtime-types.cjs";
import {maxQuickOutputFields,plannerFieldsSchema,schemaFromFields,type IntervalEndpoint,type QuickOutputSchema} from "./quick-structure.cjs";

const identifier=/^[A-Za-z][A-Za-z0-9_]{0,47}$/;

// Recognize an explicit output declaration only in the leading task instruction. Text in
// records and examples can contain other field names and imperative instructions.
export function declaredOutputKeys(objective:string):string[]|null {
  const [first,second=""]=objective.trim().split(/(?<=[.!?])\s+|\n/,2);
  const verb=/^(?:please\s+)?(?:return|output|extract|produce|use)\s+/i;
  if (!verb.test(first)) return null;
  const statement=first.replace(verb,"").split(/\b(?:source|example|record|excerpt)\s*:/i,1)[0];
  const clause=statement.match(/\b(?:using|with)\s+(?:(?:only|exactly|the|these)\s+)*(?:keys|fields)\s*:?\s+(.+)/i);
  const prefix=/^(?:(?:only|exactly|the|these|following|two|three|four|five|\d+)\s+)*(?:(?:output\s+)?(?:keys|fields)\s*:?\s+)?/i;
  const explicit=!!clause || /^(?:(?:the|these)\s+)?(?:only|exactly|(?:output\s+)?(?:fields|keys)\b)/i.test(statement) ||
    /^use\s+(?:only|exactly)\s+(?:those|these|.*\bwith those names\b)/i.test(second);
  if (!explicit) return null;
  const head=(clause?.[1] ?? statement.replace(prefix,"")).split(/\s+(?:for|from|in|where|with|as)\s+|[.!?;:]/i,1)[0].trim();
  // A coordinated list of literal identifiers is required. Never turn a prose noun phrase into a key.
  const parts=head.split(/\s*,\s*(?:and\s+)?|\s+and\s+/i);
  const names=parts.map(part=>part.trim().replace(/^(`|"|')([A-Za-z][A-Za-z0-9_]*)\1$/,"$2"));
  if (!names.every(name=>identifier.test(name)) || new Set(names).size!==names.length) return null;
  const literalNames=parts.every((part,i)=>part.trim()!==names[i] || /_|[a-z][A-Z]/.test(names[i]));
  if (!literalNames && !clause && !/\b(?:keys|fields)\b/i.test(statement) && !/\b(?:keys|fields)\b/i.test(second)) return null;
  if (names.length>12) throw Error("The supported structured Quick schema allows up to twelve output fields.");
  if (names.some(name=>Object.hasOwn(Object.prototype,name) || name==="prototype")) throw Error("Choose supported, distinct JSON field names.");
  return names;
}

export function declaredPlannerFields(keys:string[]) {
  const spec={type:"object",properties:{type:plannerFieldsSchema.items.properties.type,nullable:{type:"boolean"}},
    required:["type","nullable"],additionalProperties:false};
  return {type:"object",properties:Object.fromEntries(keys.map(key=>[key,spec])),required:keys,additionalProperties:false};
}

export function proposedOutputSchema(raw:unknown,keys:string[]|null) {
  if (!keys) return schemaFromFields(raw);
  if (!isRecord(raw) || Object.keys(raw).length!==keys.length || !keys.every(key=>Object.hasOwn(raw,key)))
    throw Error("Use exactly the declared fields: "+keys.join(", ")+". Keep the original key spelling.");
  return schemaFromFields(keys.map(name=>{
    const field=raw[name];
    if (!isRecord(field)) throw Error("Specify the type and nullability of "+name+".");
    return {name,type:field.type,nullable:field.nullable};
  }));
}

// An interval in the source can support many different tasks. Require wording that asks
// the candidate to report the interval itself before changing any proposed field.
function asksForInterval(instruction:string,subjects?:readonly string[]):boolean {
  const request=/\b(?:report|state|give|provide|include|cite|extract|identify|capture|return|record|specify|list|show|contains?)\s+((?:[\w-]+\s+){0,6}?)(?:ranges?|intervals?|bounds|endpoints|limits|(?:min(?:imum)?|lower)\s+(?:and|&)\s+(?:max(?:imum)?|upper))\b(?!\s+(?:width|span|size|midpoint|average|count|maximum|minimum|threshold)\b)/gi;
  for (const match of instruction.matchAll(request)) {
    if (/\b(?:not|never)\s*$/i.test(instruction.slice(Math.max(0,match.index-12),match.index))) continue;
    const modifiers=match[1].replace(/\b(?:lower\s+(?:and|&)\s+upper|min(?:imum)?\s+(?:and|&)\s+max(?:imum)?)\b/gi,"");
    if (/\b(?:one|upper|lower|min(?:imum)?|max(?:imum)?|width|span|size|midpoint|average|count|of|within|outside|whether|against|from|using|above|below)\b/i.test(modifiers)) continue;
    if (!subjects) return true;
    const after=instruction.slice(match.index+match[0].length).match(/^\s+(?:for|of)\s+(?:the\s+)?([\w-]+)/i);
    const named=(match[0]+" "+(after?.[1] ?? "")).toLowerCase().split(/[\W_]+/);
    if (subjects.some(word=>named.includes(word))) return true;
  }
  return false;
}

function fieldWords(name:string):string[] {
  return name.replace(/([a-z])([A-Z])/g,"$1_$2").toLowerCase().split("_");
}
function namesNumericInterval(name:string):boolean {
  const words=fieldWords(name);
  const lower=words.some(word=>["lower","min","minimum"].includes(word));
  const upper=words.some(word=>["upper","max","maximum"].includes(word));
  if (words.some(word=>["width","span","size","midpoint","mean","average","count","threshold","within","outside"].includes(word))) return false;
  if (lower || upper) return lower && upper;
  return words.some(word=>["range","interval","bounds","endpoints","limits"].includes(word));
}

export function alignIntervalProposal(proposed:QuickOutputSchema,declared:boolean,objective:string,measures:readonly string[]) {
  const intervals=new Map<string,IntervalEndpoint>();
  const task=objective.split(/\b(?:source|excerpt|example|record)\s*:/i,1)[0];
  const singleBound=/\b(?:cite|state|report|give|return|provide|extract|include|identify|specify|show)\s+(?:(?:just|only|the|applicable|permitted|specified|drawing)\s+)*(?:(?:upper|lower|minimum|maximum)\s+(?:bound|limit|value|threshold)\b|(?:one[- ]sided\s+)?threshold\b|(?:range|interval)\s+(?:width|span|midpoint)\b)/i;
  // A stale measure must not expand an operator's explicit one-sided task.
  const requirements=[task,...measures];
  if (!asksForInterval(task) && (singleBound.test(task) || !measures.some(line=>asksForInterval(line)))) return {schema:proposed,intervals};
  const candidates=proposed.required.filter(name=>{
    const property=proposed.properties[name].type;
    const type=Array.isArray(property) ? property[0] : property;
    return (type==="number" || type==="integer") && namesNumericInterval(name);
  });
  const fields=[];
  let room=maxQuickOutputFields-proposed.required.length;
  for (const [name,property] of Object.entries(proposed.properties)) {
    const type=Array.isArray(property.type) ? property.type[0] : property.type;
    const nullable=Array.isArray(property.type);
    // A request for the pressure range cannot also establish a temperature interval.
    const subjects=candidates.length>1 ? fieldWords(name).filter(word=>!/^(?:range|interval|bounds|endpoints|limits|min|max|lower|upper|minimum|maximum|and)$/.test(word)) : undefined;
    if (!candidates.includes(name) || (subjects && !requirements.some(line=>asksForInterval(line,subjects)))) {
      fields.push({name,type,nullable});
      continue;
    }
    const lower=name+"_lower",upper=name+"_upper";
    if (declared || room===0 || lower.length>48 || Object.hasOwn(proposed.properties,lower) || Object.hasOwn(proposed.properties,upper)) {
      fields.push({name,type:"string",nullable});
      intervals.set(name,"text");
    } else {
      fields.push({name:lower,type,nullable},{name:upper,type,nullable});
      intervals.set(lower,"lower");
      intervals.set(upper,"upper");
      room--;
    }
  }
  return {schema:intervals.size ? schemaFromFields(fields) : proposed,intervals};
}
