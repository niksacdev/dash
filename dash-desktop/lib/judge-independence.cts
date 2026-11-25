import {defaultDecisionEndpoint} from "./decision-model.cjs";
import type {Candidate,ModelCandidate} from "./runtime-types.cjs";
import type {GraderSpec} from "./grader-types.cjs";

export interface JudgeComparison {candidates:readonly Candidate[];inventory:readonly ModelCandidate[]}
export const servedJudgeConflict="The decision service returned a candidate checkpoint as the judge. This case is unscored. Choose an independent judge and review the saved answers.";

interface ModelIdentity {id?:string;provider:string;model:string;nativeKey?:unknown;nativePublisher?:unknown;quantization?:string|null;revision?:string|null;endpoint?:string}

function checkpoint(name:string):string|null {
  // Collapse only known packaging and official namespace variants of recognizable
  // checkpoints. Preserve capacity, modality, tuning, and unknown publisher namespaces.
  const hub=/\bmodels--([a-z0-9_.-]+)--([a-z0-9_.-]+)\/snapshots\/[0-9a-f]{7,64}(?:\/|$)/i.exec(name);
  if(hub)name=hub[1]+"/"+hub[2];
  if(name.startsWith("/") || name.includes("\\"))return null;
  const parts=name.toLowerCase().split("/");
  if(parts.length>2 || parts.some(p=>!p || !/^[a-z0-9:_.-]+$/.test(p)))return null;
  const publisher=parts.length===2?parts[0]:"";
  const leaf=(parts.at(-1) ?? "").replace(/:latest$/,"")
    .replace(/(?:[-.:_](?:gguf|mlx|q[2-8](?:_k(?:_[sml])?|_[01])?|iq[1-4](?:_[a-z0-9]+)?|(?:[248]|16)bit|f16|bf16))+$/,"")
    .replace(/^((?:gemma|llama|qwen|lfm)-?\d+(?:\.\d+)?):(\d+(?:\.\d+)?b)(?=$|[-:])/,"$1-$2")
    .replace(/^(gemma|llama|qwen|lfm)-(\d)/,"$1$2");
  const family=/^(lfm|d1|gemma|qwen|llama|mistral|deepseek)/.exec(leaf)?.[1];
  const publishers:Record<string,string[]>={lfm:["liquid","liquidai"],d1:["liquid","liquidai"],gemma:["google"],qwen:["qwen"],llama:["meta","meta-llama"],mistral:["mistralai"],deepseek:["deepseek","deepseek-ai"]};
  if(family && /\d/.test(leaf) && (!publisher || publishers[family]?.includes(publisher) || ["mlx-community","lmstudio-community","bartowski"].includes(publisher)))
    return "checkpoint:"+leaf;
  return parts.length===2 ? "published:"+name.toLowerCase() : null;
}

function keys(identity:ModelIdentity):Set<string>{
  const result=new Set<string>();
  const names=new Set([identity.model]);
  if(typeof identity.nativeKey==="string")names.add(identity.nativeKey);
  const local=identity.provider==="lmstudio" || identity.provider==="ollama";
  if(local && identity.id?.startsWith(identity.provider+"/")) names.add(identity.id.slice(identity.provider.length+1));
  // MLX-VLM exposes an absolute folder. Only bridge an LM Studio layout to a chat
  // registration when the publisher, checkpoint and any packaging suffix agree.
  if(identity.provider==="local" && !identity.model.split("/").some(part=>part==="." || part==="..")){
    const file=/^\/(?:[^/]+\/)*\.lmstudio\/models\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/?$/i.exec(identity.model);
    if(file)result.add("lm-file:"+file[1].toLowerCase()+"/"+file[2].toLowerCase());
  }
  if(identity.provider==="lmstudio" && typeof identity.nativeKey==="string"){
    const parts=identity.nativeKey.toLowerCase().split("/");
    const publisher=typeof identity.nativePublisher==="string"?identity.nativePublisher.toLowerCase():parts.length===2?parts[0]:null;
    const repo=parts.at(-1);
    if(publisher && repo && (parts.length===1 || (parts.length===2 && parts[0]===publisher))){
      const path="lm-file:"+publisher+"/"+repo;result.add(path);
      if(identity.quantization && /^[a-z0-9_]+$/i.test(identity.quantization))result.add(path+"-"+identity.quantization.toLowerCase());
    }
  }
  const revision=identity.revision?.toLowerCase().replace(/^sha256:/,"");
  if(revision && /^[a-f0-9]{64}$/.test(revision))result.add("sha256:"+revision);
  if(identity.id)result.add("id:"+identity.provider+":"+identity.id);
  let service=identity.provider;
  if(identity.endpoint){
    try{const url=new URL(identity.endpoint);
      const loopback=["localhost","localhost.","127.0.0.1","[::1]"].includes(url.hostname);
      const path=url.pathname.replace(/\/(?:v1\/?)?$/,"");
      // These are the HTTP listeners the native chat adapters actually call. Keep
      // TLS endpoints and reverse-proxy service paths independent of those listeners.
      const native=loopback && url.protocol==="http:" && !path;
      const lmStudio=native && url.port==="1234",ollama=native && url.port==="11434";
      if(identity.provider==="compatible" && lmStudio &&
        /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(identity.model))result.add("lm-file:"+identity.model.toLowerCase());
      const port=url.port || (url.protocol==="https:"?"443":"80");
      const origin=loopback ? "loopback|"+url.protocol+"|"+port : "origin|"+url.origin;
      service=lmStudio?"lmstudio":ollama?"ollama":origin+"|"+path;
    }catch{/* An invalid legacy endpoint supplies no route identity. */service="";}
  }
  for(const entry of names){
    const name=entry.trim();
    if(!name)continue;
    // Independent servers can both expose an opaque "production" deployment.
    if(service && service!=="compatible" && service!=="local" && service!=="openrouter")result.add("route:"+service+":"+name);
    // A user can name a loaded instance after a different model. Cross-runtime
    // checkpoint identity comes from the native registration when one is available.
    const registered=identity.provider==="lmstudio" && typeof identity.nativeKey==="string";
    if(!registered || name===identity.nativeKey){
      const repo=registered && !name.includes("/") && typeof identity.nativePublisher==="string" ? identity.nativePublisher+"/"+name : name;
      const publicName=checkpoint(repo);
      if(publicName)result.add(publicName);
    }
  }
  return result;
}
function graderIdentities(g:GraderSpec):ModelIdentity[]{
  if(g.judge)return [g.judge];
  if(g.type!=="decision")return [];
  return [g.decision.model,g.decision.fallbackModel].filter((name):name is string=>!!name).map(model=>({
    provider:g.decision.provider,endpoint:g.decision.provider==="local" ? g.decision.endpoint ?? defaultDecisionEndpoint : undefined,model,
  }));
}
export function judgeConflictMap(graders:readonly GraderSpec[],judges:readonly ModelCandidate[],candidates:readonly Candidate[]) {
  const byAlias=new Map<string,string[]>(), inventory=new Map(judges.map(judge=>[judge.id,judge]));
  const current=(model:ModelIdentity):ModelIdentity=>{
    const live=model.id && inventory.get(model.id);
    if(live && live.provider==="lmstudio" && live.provider===model.provider && live.model===model.model &&
      (!live.revision || !model.revision || live.revision===model.revision) && (!model.nativeKey || live.nativeKey===model.nativeKey))
      return {...live,...model,nativeKey:model.nativeKey ?? live.nativeKey,nativePublisher:model.nativePublisher ?? live.nativePublisher};
    return model;
  };
  const definitions=new Map<string,ModelIdentity>();
  for(const candidate of candidates){
    if(candidate.provider==="fixture")continue;
    const observed=current(candidate);definitions.set(candidate.id,observed);
    for(const alias of keys(observed)){
      const ids=byAlias.get(alias);
      if(ids)ids.push(candidate.id);else byAlias.set(alias,[candidate.id]);
    }
  }
  const overlap=(identities:ModelIdentity[])=>{
    const matched=new Set<string>();
    for(const identity of identities){
      const judge=current(identity);
      for(const alias of keys(judge)){
        for(const id of byAlias.get(alias) ?? []){
          const candidate=definitions.get(id);
          // A native registration can change across runs while its display/instance ID is reused.
          // Distinct known checkpoints cannot conflict on that weak route alias alone.
          if((alias.startsWith("route:") || alias.startsWith("id:")) && candidate?.nativeKey && judge.nativeKey &&
            candidate.nativeKey!==judge.nativeKey)continue;
          matched.add(id);
        }
      }
    }
    return [...matched];
  };
  const judgeCandidateConflicts:Record<string,string[]>={},modelCandidateConflicts:Record<string,string[]>={};
  for(const g of graders){const ids=overlap(graderIdentities(g));if(ids.length)judgeCandidateConflicts[g.id]=ids;}
  for(const m of judges){if(m.provider==="compatible")continue;const ids=overlap([m]);if(ids.length)modelCandidateConflicts[m.id]=ids;}
  return {judgeCandidateConflicts,modelCandidateConflicts};
}
// Validate the handle used for the *new* request separately from matching the
// immutable candidate that created a historical answer. An instance name can be reused.
export function judgeRegistrationIssue(grader:GraderSpec,models:readonly ModelCandidate[]):string|undefined {
  const pin=grader.judge;
  if(!pin)return undefined;
  const live=models.find(m=>m.provider===pin.provider && m.id===pin.id);
  if(!live || live.provider==="compatible")return grader.name+" needs its saved judge "+pin.model+". Reconnect its runtime and refresh models, or select a grader with an available judge.";
  const changed=grader.name+" cannot verify the saved judge against its current runtime registration. Refresh models and save a grader version with the intended checkpoint, or select another independent grader.";
  if(live.model!==pin.model || (pin.revision && live.revision!==pin.revision))return changed;
  if(live.provider!=="lmstudio")return undefined;
  if(pin.nativeKey!==undefined && pin.nativeKey!==live.nativeKey)return changed;
  if(pin.nativePublisher!==undefined && pin.nativePublisher!==live.nativePublisher)return changed;
  if(pin.quantization && pin.quantization.toLowerCase()!==live.quantization?.toLowerCase())return changed;
  if(!pin.nativeKey && live.nativeKey && !(pin.revision && pin.revision===live.revision)){
    const requested=[pin.model,pin.id.slice(pin.provider.length+1)];
    const repo=!live.nativeKey.includes("/") && live.nativePublisher ? live.nativePublisher+"/"+live.nativeKey : live.nativeKey;
    const known=checkpoint(repo);
    if(!requested.some(name=>name===live.nativeKey || name===repo || (known && checkpoint(name)===known)))return changed;
  }
  return undefined;
}
export function independentJudgeIssue(graders:readonly GraderSpec[],judges:readonly ModelCandidate[],candidates:readonly Candidate[]):string|undefined {
  for(const grader of graders){
    if(grader.judge && judges.some(m=>m.id===grader.judge?.id)){
      const registration=judgeRegistrationIssue(grader,judges);
      if(registration)return registration;
    }
  }
  const conflicts=judgeConflictMap(graders,judges,candidates).judgeCandidateConflicts;
  const grader=graders.find(g=>conflicts[g.id]?.length);
  if(grader)return grader.name+" uses a judge that is also a candidate in this comparison. Choose a grader with an independent model (including its fallback), use a deterministic grader, or change the candidates.";
  return undefined;
}
