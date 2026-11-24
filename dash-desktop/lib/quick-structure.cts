import { isRecord, type ChatTurn } from "./runtime-types.cjs";

const primitives = ["string", "number", "integer", "boolean"] as const;
type Primitive = typeof primitives[number];
type Field = {type: Primitive | [Primitive, "null"]};
export type QuickOutputSchema = {
  type:"object";
  properties:Record<string, Field>;
  required:string[];
  additionalProperties:false;
};
export interface QuickTaskInput {task:string;inputs:Record<string,string>}
export interface StructuredOutputCheck {valid:boolean;message:string}

const maxFields = 12;
const validName = (name:unknown):name is string => typeof name === "string" &&
  /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(name) && !Object.hasOwn(Object.prototype,name) && name !== "prototype";
const isPrimitive = (value:unknown):value is Primitive => primitives.some(t=>t===value);
const exactKeys = (record:Record<string,unknown>, keys:string[]) =>
  Object.keys(record).length === keys.length && keys.every(key=>Object.hasOwn(record,key));

export const plannerFieldsSchema = {
  type:"array", minItems:1, maxItems:maxFields, items:{
    type:"object", properties:{name:{type:"string"},type:{type:"string",enum:primitives},nullable:{type:"boolean"}},
    required:["name","type","nullable"],additionalProperties:false,
  },
};

export function schemaFromFields(raw:unknown):QuickOutputSchema {
  if (!Array.isArray(raw) || !raw.length || raw.length > maxFields)
    throw Error("Choose between 1 and 12 output fields.");
  const entries:[string,Field][] = [];
  for (const field of raw) {
    if (!isRecord(field) || !exactKeys(field,["name","type","nullable"]) || !validName(field.name) ||
        !isPrimitive(field.type) || typeof field.nullable !== "boolean" || entries.some(([name])=>name===field.name))
      throw Error("Each output field needs a unique identifier, a supported scalar type and a nullable flag.");
    entries.push([field.name, {type:field.nullable ? [field.type,"null"] : field.type}]);
  }
  return {type:"object", properties:Object.fromEntries(entries), required:entries.map(([name])=>name), additionalProperties:false};
}

export function decodeQuickOutputSchema(raw:unknown):QuickOutputSchema {
  if (!isRecord(raw) || !exactKeys(raw,["type","properties","required","additionalProperties"]) || raw.type !== "object" ||
      raw.additionalProperties !== false || !isRecord(raw.properties) || !Array.isArray(raw.required))
    throw Error("Use a closed JSON object with properties, required fields and additionalProperties set to false.");
  const names=Object.keys(raw.properties);
  const required:unknown[]=raw.required;
  if (!names.length || names.length>maxFields || names.length !== required.length || names.some(name=>!required.includes(name)))
    throw Error("List every output field once in required. Use 1–12 fields.");
  return schemaFromFields(Object.entries(raw.properties).map(([name,field])=>{
    if (!isRecord(field) || !exactKeys(field,["type"]))
      throw Error("Each output property must specify its type only.");
    const nullable=Array.isArray(field.type);
    if (nullable && (!Array.isArray(field.type) || field.type.length !== 2 || field.type[1] !== "null"))
      throw Error('For a nullable field, use its type followed by "null".');
    return {name,type:Array.isArray(field.type) ? field.type[0] : field.type,nullable};
  }));
}

export const plannerInputsSchema = {
  type:"array",maxItems:8,items:{
    type:"object",properties:{name:{type:"string"},value:{type:"string",maxLength:2000}},
    required:["name","value"],additionalProperties:false,
  },
};

export function inputsFromTask(raw:unknown,objective:string):Record<string,string> {
  if (!Array.isArray(raw) || raw.length>8) throw Error("Propose at most eight source inputs.");
  const entries:[string,string][]=[];
  for (const field of raw) {
    // Keep the full task even when a small planner guesses a value or paraphrases evidence.
    if (!isRecord(field) || !validName(field.name) || typeof field.value!=="string" ||
        !field.value.trim() || field.value.length>2000 || !objective.includes(field.value) ||
        entries.some(([name])=>name===field.name)) continue;
    entries.push([field.name,field.value]);
  }
  return Object.fromEntries(entries);
}

export function decodeQuickTaskInput(raw:unknown,task:string):QuickTaskInput {
  if (!isRecord(raw) || !exactKeys(raw,["task","inputs"]) || raw.task!==task || !isRecord(raw.inputs))
    throw Error("The JSON input must contain the approved task text and a named inputs object.");
  const entries=Object.entries(raw.inputs);
  if (entries.length>8 || entries.some(([name,value])=>!validName(name) || typeof value!=="string" ||
      !value.trim() || value.length>2000 || !task.includes(value)))
    throw Error("Use up to eight named source values copied exactly from the approved task.");
  return {task,inputs:Object.fromEntries(entries.map(([name,value])=>[name,String(value)]))};
}

export function quickStructuredMessages(input:QuickTaskInput,schema:QuickOutputSchema):ChatTurn[] {
  return [
    {role:"system",content:"Complete the task in the JSON input. Return a single JSON object conforming to this schema.\n"+JSON.stringify(schema)},
    {role:"user",content:JSON.stringify(input)},
  ];
}

export function checkStructuredOutput(text:string,schema:QuickOutputSchema):StructuredOutputCheck {
  let value:unknown;
  try {value=JSON.parse(text);} catch {return {valid:false,message:"The response is not valid JSON."};}
  if (!isRecord(value)) return {valid:false,message:"The response must be a JSON object."};
  for (const name of schema.required) {
    if (!Object.hasOwn(value,name)) return {valid:false,message:"Missing required field: "+name+"."};
    const type=schema.properties[name].type, expected=Array.isArray(type) ? type[0] : type;
    const observed=value[name];
    const matches=expected==="integer" ? Number.isInteger(observed) :
      expected==="number" ? Number.isFinite(observed) : typeof observed===expected;
    if (!(Array.isArray(type) && observed===null) && !matches) return {valid:false,message:"Unexpected value type for "+name+"."};
  }
  if (Object.keys(value).length!==schema.required.length) return {valid:false,message:"The response includes an undeclared field."};
  return {valid:true,message:"All required fields match the approved JSON schema."};
}
