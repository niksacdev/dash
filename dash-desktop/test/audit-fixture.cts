import {z} from "zod";
import type {ChatTurn} from "../lib/runtime-types.cjs";
export function auditReply(messages:ChatTurn[]) {
  const data=z.object({proposals:z.array(z.object({metric:z.string(),criterion:z.string()}))}).parse(JSON.parse(messages[1].content));
  return {audit:data.proposals.map(({metric,criterion})=>({metric:metric || "Agreement with reference · "+criterion,criterion,status:"needs-evidence",
    evidence:"Candidate response and a labeled case reference.",method:"Compare the answer against the expected case result.",
    reason:"The case labels and grader need confirmation before scoring."}))};
}
