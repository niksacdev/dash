const industries = ["Automotive","Manufacturing","Financial Services","Healthcare","Retail","Technology","Energy","Cross-industry"];
function industryOptions(chosen: string, all=false) {
  const saved=(state?.datasets||[]).map(d=>d.metadata?.industry).filter((value): value is string => !!value);
  return [...new Set([...(all?["All industries"]:[]),...industries,...saved,...(chosen?[chosen]:[])])].map(x=>opt(x,x,chosen)).join("");
}
