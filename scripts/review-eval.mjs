#!/usr/bin/env node
/**
 * Print the reviewer eval catalog, or score a predictions JSON file.
 *
 *   node --experimental-strip-types scripts/review-eval.mjs
 *   node --experimental-strip-types scripts/review-eval.mjs path/to/preds.json
 *
 * preds.json: { "<id>": { "integrityYaml": "...", "taskYaml": "..." } }
 */
import { readFileSync } from "node:fs";
import {
  REVIEW_EVAL_CASES,
  formatEvalCatalog,
  predictionFromYaml,
  scoreEvalSet,
} from "../src/lib/reviewEval.ts";

const path = process.argv[2];
if (!path) {
  console.log(formatEvalCatalog());
  process.exit(0);
}

const raw = JSON.parse(readFileSync(path, "utf8"));
const predictions = {};
for (const entry of REVIEW_EVAL_CASES) {
  const row = raw[entry.id];
  if (!row) continue;
  predictions[entry.id] = predictionFromYaml(
    String(row.integrityYaml ?? row.integrity ?? ""),
    String(row.taskYaml ?? row.task ?? ""),
  );
}
const report = scoreEvalSet(predictions);
for (const [bucket, score] of Object.entries(report.buckets)) {
  console.log(
    `${bucket.padEnd(8)} n=${score.n} catch=${(score.catchRate * 100).toFixed(0)}% fp=${(score.falsePositiveRate * 100).toFixed(0)}% noise=${score.softNoise}`,
  );
}
const misses = report.cases.filter((row) => !row.caught || row.falsePositive);
for (const row of misses) {
  const tag = row.falsePositive ? "FP" : "MISS";
  console.log(`${tag.padEnd(4)} ${row.id}`);
}
