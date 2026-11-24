import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("the desktop build carries the project and model-logo notices verbatim", () => {
  const dist = resolve(__dirname, "..");
  const project = resolve(dist, "../..");
  const logos = "ui/assets/model-logos/LICENSE.txt";
  for (const [source, bundled] of [
    ["LICENSE", "LICENSE"],
    ["NOTICE", "NOTICE"],
    ["dash-desktop/" + logos, logos],
  ]) {
    assert.deepEqual(readFileSync(resolve(dist, bundled)), readFileSync(resolve(project, source)), bundled);
  }
});
