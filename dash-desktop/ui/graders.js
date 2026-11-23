"use strict";
const graderTypes={contains:"Contains required text",exact:"Exact answer",field:"JSON field matches reference",trajectory:"Agent actions in order",judge:"Local LLM rubric",opik:"Opik G-Eval"};
const graderHints={contains:"Text the output must contain",exact:"Expected answer",field:'{"outputField":"team","referenceField":"team"}',trajectory:"One required tool or action name per line",judge:"Describe what earns full, partial and zero credit.",opik:"Describe the task, evaluation criteria and what distinguishes a good answer."};
const formField=(label,input)=>'<label class="field"><span>'+esc(label)+'</span>'+input+'</label>';
const chosenGraders=new Set();
function selectedGraderIds(){return [...chosenGraders];}
function graderPicker(){
  const list=state.graders||[];
  return '<details class="card grader-picker"><summary>Additional graders · '+chosenGraders.size+' selected</summary>'+
    (list.map(g=>'<label class="choice"><input type="checkbox" name="custom-grader" value="'+esc(g.id)+'" '+(chosenGraders.has(g.id)?"checked":"")+'>'+esc(g.name+" v"+g.version+" · "+g.category)+'</label>').join("")||
    '<p>Create a rule or a judge rubric to score these responses.</p>')+link("Open grader library →","graders","link")+'</details>';
}
function scoreRows(rows){
  return rows.length?table(["Grader","Candidate / case","Score","Decision","Rationale"],rows.map(r=>[
    esc(r.name+" v"+r.version)+(r.judge?'<small class="block">'+esc(r.judge)+'</small>':''),
    esc([r.candidate,r.caseId].filter(Boolean).join(" / ")||"Provided output"),
    r.value==null?"—":esc(metricNumber(r.value)),r.pass==null?"Unscored":r.pass?"Passed":"Review",esc(r.reason)])):"";
}
let gradeFilter="",graderDraft=null;
function judgeOptions(id){return opt("","Choose a local model",id)+models().map(m=>opt(m.id,m.model+" · "+m.provider,id)).join("");}
function gradeCreate(){
  const g=graderDraft || {name:"",category:"",industry:"Cross-industry",criteria:"",type:"contains",threshold:1};
  return '<details class="panel" '+(graderDraft?'open':'')+'><summary>Create or revise a grader</summary><form id="grade-create" class="spacer"><div class="cols">'+
    formField("Grader name",'<input name="name" required maxlength="100" value="'+esc(g.name)+'">')+
    formField("Category",'<input name="category" required maxlength="100" value="'+esc(g.category)+'" placeholder="e.g. Factual accuracy">')+'</div><div class="cols">'+
    formField("Industry",'<select name="industry">'+industryOptions(g.industry)+'</select>')+
    formField("Method",'<select name="type" id="grade-type">'+Object.entries(graderTypes).map(([k,v])=>k==="opik"&&!state.opikReady?'<option disabled>Opik G-Eval · SDK unavailable</option>':opt(k,v,g.type)).join("")+'</select>')+'</div>'+
    formField("Rule or rubric",'<textarea name="criteria" required maxlength="6000" placeholder="'+esc(graderHints[g.type])+'">'+esc(g.criteria)+'</textarea>')+
    '<div class="cols">'+formField("Pass threshold (0–1)",'<input name="threshold" type="number" min="0.001" max="1" step="any" required value="'+esc(g.threshold)+'">')+
    '<div id="judge-choice" '+(["judge","opik"].includes(g.type)?"":"hidden")+'>'+formField("Judge model",'<select name="judgeId">'+judgeOptions(g.judge?.id)+'</select>')+'</div></div>'+
    '<button class="yellow">Save grader version</button></form></details>';
}
function gradeSelect(){return '<select name="grader" required>'+opt("","Choose a grader","")+(state.graders||[]).map(g=>opt(g.id,g.name+" v"+g.version+" · "+g.category,"")).join("")+'</select>';}
async function gradersPage(){
  const list=state.graders||[], samples=await api.graderSamples();
  return heading("Workspace","Graders","Define how to judge an inference response or an agent’s work. Reuse a saved version across runs.")+
    gradeCreate()+bar("Grader library")+'<section class="panel">'+formField("Filter by category, industry or name",'<input type="search" id="grade-filter" value="'+esc(gradeFilter)+'">')+
    list.map(g=>'<div class="listrow grader-row" data-filter="'+esc([g.category,g.industry,g.name].join(" ").toLowerCase())+'" '+([g.category,g.industry,g.name].join(" ").toLowerCase().includes(gradeFilter.toLowerCase())?"":"hidden")+'><div><strong>'+
      esc(g.name+" · v"+g.version)+'</strong><small>'+esc([g.category,g.industry,graderTypes[g.type]].join(" · "))+'</small><p>'+esc(g.criteria)+'</p></div><button data-revise="'+esc(g.id)+'">Revise</button></div>').join("")+
    (list.length?'':'<p>No custom graders yet. Create a rule or an Opik judge above.</p>')+'</section>'+
    bar("Grade an output")+'<form id="grade-sample" class="panel">'+formField("Grader",gradeSelect())+
    '<div class="cols">'+formField("Task or input",'<textarea name="input" required></textarea>')+formField("Model or agent output",'<textarea name="output" required></textarea>')+'</div>'+
    '<details><summary>Reference and agent trajectory</summary>'+formField("Reference (JSON or text)",'<textarea name="reference"></textarea>')+
    formField("Agent steps in order (JSON array)",'<textarea name="trajectory" placeholder=\'[{"tool":"search"},{"tool":"summarize"}]\'></textarea>')+'</details>'+
    '<button class="yellow spacer" '+(list.length?"":"disabled")+'>Run grader</button></form>'+
    (samples.length?bar("Recent evaluations")+'<div class="panel">'+scoreRows(samples)+'</div>':"");
}
function caseGrading(run,r,index){
  const rows=(run.assessments||[]).filter(a=>a.caseId===r.caseId && a.candidate===r.candidateId);
  return bar("Grader evaluations")+'<div class="panel">'+scoreRows(rows)+(!r.error?'<form id="grade-case" data-id="'+esc(run.manifest.id)+'" data-index="'+index+'">'+
    formField("Apply a saved grader",gradeSelect())+'<button '+(state.graders?.length?"":"disabled")+'>Grade this output</button></form>':'')+'</div>';
}
document.addEventListener("change",e=>{
  if(e.target.name==="custom-grader"){
    if(e.target.checked)chosenGraders.add(e.target.value);else chosenGraders.delete(e.target.value);
    e.target.closest("details").querySelector("summary").textContent="Additional graders · "+chosenGraders.size+" selected";
  }
  if(e.target.id==="grade-type"){
    const f=e.target.form;f.criteria.placeholder=graderHints[e.target.value];f.querySelector("#judge-choice").hidden=!["opik","judge"].includes(e.target.value);
  }
});
document.addEventListener("input",e=>{if(e.target.id==="grade-filter"){gradeFilter=e.target.value;document.querySelectorAll(".grader-row").forEach(r=>r.hidden=!r.dataset.filter.includes(gradeFilter.toLowerCase()));}});
document.addEventListener("click",e=>{const el=e.target.closest("[data-revise]");if(el){graderDraft=state.graders.find(g=>g.id===el.dataset.revise);render().then(()=>document.querySelector("#grade-create input")?.focus());}});
document.addEventListener("submit",async e=>{
  if(!["grade-case","grade-sample","grade-create"].includes(e.target.id))return;
  e.preventDefault();const f=e.target,values=Object.fromEntries(new FormData(f)),b=f.querySelector("button");b.disabled=true;
  const title=b.textContent;
  try{
    if(f.id==="grade-create"){await api.saveGrader(values);graderDraft=null;message("Grader version saved.");}
    else {
      b.textContent="Grading…";
      let request={grader:values.grader};
      if(f.id==="grade-case"){request.run=f.dataset.id;request.index=Number(f.dataset.index);}
      else {
        let reference=values.reference || null;
        try{reference=JSON.parse(reference);}catch{}
        request.evidence={input:values.input,output:values.output,reference,trajectory:JSON.parse(values.trajectory.trim()||"[]")};
      }
      const result=await api.assess(request);message(result.pass==null?"Unscored · "+result.reason:"Evaluation saved.");
    }
    await render();
  }catch(error){message(error.message);}finally{b.disabled=false;b.textContent=title;}
});
