import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import {operatorProviderMessage} from "../lib/provider-errors.cjs";
import {desktopFailure} from "../lib/desktop-errors.cjs";

test("startup and file operations explain recovery without exposing the local path",()=>{
  const osError=(code:string)=>Object.assign(Error("private-workspace-path"),{code});
  assert.match(desktopFailure("startup",osError("EINTR")),/file access was interrupted/);
  assert.match(desktopFailure("startup",osError("MODULE_NOT_FOUND")),/required DASH file/);
  assert.match(desktopFailure("import",osError("ENOENT")),/Choose the JSONL file again/);
  assert.match(desktopFailure("export",osError("EACCES")),/selected folder/);
  assert.match(desktopFailure("export",osError("ENOSPC")),/insufficient space/);
  for(const code of ["EIO","EPERM","ENOENT","ENOSPC","UNRECOGNIZED"])
    assert.doesNotMatch(desktopFailure("startup",osError(code)),/private-workspace-path/);
});

test("a real SQLite read-only error has workspace recovery guidance",()=>{
  const db=new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA query_only=ON");
    assert.throws(()=>db.exec("CREATE TABLE private_table(x)"),(error:unknown)=>{
      const message=desktopFailure("start",error);
      return /workspace database/.test(message) && !message.includes("private_table");
    });
  } finally { db.close(); }
});

test("parser excerpts stay private and a domain validation retains its specific next step",()=>{
  assert.doesNotMatch(desktopFailure("detail",new SyntaxError("bad JSON near private-sentinel")),/private-sentinel/);
  assert.doesNotMatch(desktopFailure("assess",Object.assign(Error("private-sentinel"),{name:"ZodError"})),/private-sentinel/);
  const explanation="Choose a completed response.";
  assert.equal(desktopFailure("assess",Error(explanation)),explanation);
  assert.match(desktopFailure("start",null),/workspace/);
});

test("known compatible HTTP receipts get specific guidance for display",()=>{
  assert.match(operatorProviderMessage("Model endpoint returned HTTP 403"),/permission/);
  assert.match(operatorProviderMessage("Model endpoint returned HTTP 429"),/quota/);
  assert.equal(operatorProviderMessage("Model disconnected"),"Model disconnected");
});
