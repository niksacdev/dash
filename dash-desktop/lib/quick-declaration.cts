import {isRecord} from "./runtime-types.cjs";
import {plannerFieldsSchema,schemaFromFields} from "./quick-structure.cjs";

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
