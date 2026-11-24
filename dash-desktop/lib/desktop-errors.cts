type Operation = Exclude<keyof DashBridge, "onPlanningStage"> | "startup";

function hasCode(error:unknown):error is Error & {code:string; errcode?:unknown} {
  return error instanceof Error && "code" in error && typeof error.code==="string";
}

// Keep OS paths, SQLite statements and parser excerpts out of desktop error messages.
export function desktopFailure(operation:Operation, error:unknown):string {
  if (hasCode(error)) {
    if (error.code==="ERR_SQLITE_ERROR") {
      const primary=typeof error.errcode==="number" ? error.errcode & 0xff : null;
      if (primary===5 || primary===6) return "The workspace database is busy. Let other workspace operations finish and check Run history before retrying.";
      if (primary===13) return "The workspace drive is full. Free disk space, then check Run history for the last saved result.";
      if (primary===3 || primary===8 || primary===14) return "DASH cannot access the workspace database. Check that your profile folder is available and writable, then reopen DASH.";
      if (primary===11 || primary===26) return "DASH cannot read the workspace database. Keep the profile in place and restore a known-good backup before running more evaluations.";
      return "A workspace database operation failed. Check disk space and folder permissions, then inspect the last saved state before repeating the action.";
    }
    if (operation==="startup" && ["MODULE_NOT_FOUND","ERR_MODULE_NOT_FOUND","ENOENT","ERR_FILE_NOT_FOUND"].includes(error.code))
      return "A required DASH file is missing. Make the checkout available on this device, restore the installed dependencies and rebuild DASH before reopening it.";
    if (operation==="import" && error.code==="ENOENT") return "The selected dataset file is no longer available. Choose the JSONL file again.";
    if (operation==="export" && ["ENOENT","EACCES","EPERM","EROFS"].includes(error.code))
      return "DASH could not save the export in the selected folder. Choose an available folder where you can create files.";
    if (["EACCES","EPERM","EROFS"].includes(error.code)) return "DASH could not access a local file. Check the folder permissions and whether the drive is writable.";
    if (["EINTR","EIO","ETIMEDOUT"].includes(error.code) && (operation==="startup" || operation==="import" || operation==="export"))
      return "Local file access was interrupted. Make the folder available on this device, then try again.";
    if (error.code==="ENOSPC" || error.code==="EDQUOT") return "There is insufficient space to save this operation. Free disk space or choose another destination.";
    if (operation==="import") return "DASH could not read the selected dataset. Check that it is a readable local JSONL file, then choose it again.";
    if (operation==="export") return "DASH could not finish writing the export. Check the destination folder before exporting again.";
    if (operation==="startup") return "Check that the DASH build, dependencies and workspace folder are readable, then reopen DASH.";
  }
  if (operation==="startup") return "Check that the DASH build and workspace profile are available. Launch DASH again after correcting the problem.";
  if (error instanceof SyntaxError) return "DASH could not read the required JSON. Check the selected input or stored record before continuing.";
  if (error instanceof Error && error.name==="ZodError") return "The supplied fields or saved record do not match the format this DASH action requires. Review the selection and its version.";
  if (error instanceof Error && error.message.trim()) return error.message;
  return "The DASH action could not finish. Check the current workspace state before trying it again.";
}
