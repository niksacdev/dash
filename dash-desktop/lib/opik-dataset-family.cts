import {createHash} from "node:crypto";
import type {NativeOpik,DatasetVersion} from "./opik-types.cjs";
import {statusCode} from "./opik-types.cjs";

type RemoteDataset=Awaited<ReturnType<NativeOpik["datasets"]["getDatasetById"]>>;
interface Family {
  provisionalId:string; identity:string; snapshot:string; title:string; pack:string; industry:string;
  source:string; datasetId:string|null; parentId:string|null; project:string; workspace:string; description:string;
}
const options={maxRetries:0,timeoutInSeconds:35};
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalized=(value:string)=>value.trim().toLowerCase();
async function optional<T>(read:()=>Promise<T>) {
  try {return await read();} catch(e){if(statusCode(e)===404)return undefined;throw e;}
}
async function projectId(api:NativeOpik,name:string) {
  for(let page=1;;page++){
    const found=await api.projects.findProjects({name,page,size:100},options);
    const rows=found.content || [];
    const exact=rows.find(p=>p.name===name);
    if(exact) return exact.id;
    if(rows.length<100 || page*100>=(found.total ?? Infinity))return undefined;
  }
}
async function versionsMatch(api:NativeOpik,id:string,match:(v:DatasetVersion)=>boolean) {
  for(let page=1;;page++){
    const found=await api.datasets.listDatasetVersions(id,{page,size:100},options),rows=found.content || [];
    if(rows.some(match))return true;
    if(rows.length<100 || page*100>=(found.total ?? Infinity))return false;
  }
}

// Opik enforces dataset names workspace-wide and can return another project's row on name lookup.
export async function resolveDatasetFamily(api:NativeOpik,f:Family,problem:(message:string)=>Error) {
  const familyTag="dash-family-"+f.identity, sourceTag="dash-origin-"+digest(normalized(f.source));
  const owner=await projectId(api,f.project);
  const registered=(d:RemoteDataset)=>{if(!d.id || !d.projectId)throw problem("Opik returned a dataset without its owner or ID.");return {id:d.id,projectId:d.projectId};};
  const local=await optional(()=>api.datasets.getDatasetById(f.provisionalId,{},options));
  if(local){
    if(!owner || local.projectId!==owner || !local.tags?.includes("DASH"))throw problem("The saved Opik dataset is no longer owned by the configured DASH project.");
    return registered(local);
  }
  const nativeMatch=async(d:RemoteDataset)=>{
    if(!d.id || !d.tags?.includes("DASH"))return false;
    const tagged=d.tags.includes(familyTag);
    if(tagged && f.source.trim() && d.tags.includes(sourceTag))return true;
    // A full marker with another origin may still descend from the same pinned snapshot.
    if(!tagged && d.tags.some(tag=>tag.startsWith("dash-family-")))return false;
    return versionsMatch(api,d.id,v=>{
      // Some supported Opik servers expose native snapshot tags but omit version metadata even on a detailed read.
      const legacyName=d.name.endsWith(" · "+f.identity.slice(0,16));
      if((tagged || legacyName) && v.tags?.includes("dash-"+f.snapshot))return true;
      const m=v.metadata;
      if(!m || typeof m.dash_snapshot!=="string" || !v.tags?.includes("dash-"+m.dash_snapshot))return false;
      if(!f.datasetId)return false;
      if(typeof m.family!=="string" || typeof m.industry!=="string" ||
          normalized(m.family)!==normalized(f.title) || normalized(m.industry)!==normalized(f.industry) || m.pack!==f.pack)return false;
      return (m.dash_snapshot===f.snapshot && m.dash_dataset_id===f.datasetId) || (!!f.parentId && m.dash_dataset_id===f.parentId) ||
        (!!f.source && typeof m.source==="string" && normalized(m.source)===normalized(f.source));
    });
  };
  if(owner){
    const matches:RemoteDataset[]=[];
    for(let page=1;;page++){
      const found=await api.datasets.findDatasets({projectId:owner,page,size:100},options),rows=found.content || [];
      for(const d of rows)if(d.projectId===owner && await nativeMatch(d))matches.push(d);
      if(rows.length<100 || page*100>=(found.total ?? Infinity))break;
    }
    if(matches.length>1)throw problem("Several datasets in the configured Opik project claim this DASH family. Resolve the conflicting family tags before syncing.");
    if(matches.length)return registered(matches[0]);
  }
  // Normalize the readable prefix so two first writers choose one name. Suffixes separate destinations and independent origins.
  const suffix=digest([f.workspace,f.project,f.identity,sourceTag]).slice(0,24);
  const name=("DASH "+normalized(f.title)).slice(0,95)+" · "+suffix;
  try{
    await api.datasets.createDataset({id:f.provisionalId,name,projectName:f.project,description:f.description,tags:["DASH",familyTag,sourceTag]},options);
  }catch(e){if(statusCode(e)!==409)throw e;}
  const confirmed=await api.datasets.getDatasetByIdentifier({datasetName:name,projectName:f.project},options);
  if(!confirmed.projectId || (await api.projects.getProjectById(confirmed.projectId,{},options)).name!==f.project ||
     confirmed.name!==name || !confirmed.tags?.includes(familyTag) || !confirmed.tags.includes(sourceTag) || !confirmed.tags.includes("DASH") ||
     (confirmed.id!==f.provisionalId && !(await nativeMatch(confirmed))))
    throw problem("The Opik dataset name is occupied by a different project or source. No cases were changed.");
  return registered(confirmed);
}
