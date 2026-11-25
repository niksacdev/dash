"use strict";

/** A static, zero-based measurement. A missing or invalid receipt has no position. */
function comparisonTrack(label: string, value: number | null | undefined, max: number, display: string, lane: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(max) ||
      max <= 0 || value < 0 || value > max) return "";
  const colors = ["red", "cyan", "gold"] as const;
  return raceCourse(label, {
    state: "finished", kind: "measurement", reading: {value, max},
    valueText: display, color: colors[lane % colors.length]
  });
}

function baselineComparison(pairs:{current:UiScore;baseline:UiScore}[], current:string, baseline:string) {
  const rows = ([["pass","Passed cases"],["falseAccept","False accepts"]] as const).map(([key,label])=>{
    const measured=pairs.filter(pair=>typeof pair.current[key]==="boolean" && typeof pair.baseline[key]==="boolean");
    if (!measured.length) return [label,"Unmeasured","Unmeasured","No paired measurements"];
    const counts=([["current",current],["baseline",baseline]] as const).map(([side,name],lane)=>{
      const count=measured.filter(pair=>pair[side][key]).length;
      const display=count+" / "+measured.length;
      return {count,cell:esc(display)+comparisonTrack(name+" · "+side+" · "+label,count,measured.length,display,lane)};
    });
    const change=counts[0].count-counts[1].count;
    return [label,counts[0].cell,counts[1].cell,(change>0?"+":"")+change];
  });
  return table(["Measure","Current · "+current,"Baseline · "+baseline,"Change in count"],rows);
}
