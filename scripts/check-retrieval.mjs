import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyQuestion, searchDocuments } from "../site/search-core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const indexPath = path.join(rootDir, "docs", "data", "search-index.json");
const indexData = JSON.parse(fs.readFileSync(indexPath, "utf8"));

const checks = [
  {
    query: "how do I file a complaint",
    expectFirst: "book-of-discipline",
    requireIncluded: ["book-of-discipline"]
  },
  {
    query: "what are elders",
    expectFirst: "form-of-government",
    requireIncluded: ["form-of-government"]
  },
  {
    query: "what do we believe about the civil government",
    expectFirst: "confession-of-faith",
    requireIncluded: ["confession-of-faith"]
  },
  {
    query: "how will God judge the world",
    expectFirst: "confession-of-faith",
    requireIncluded: ["confession-of-faith"]
  },
  {
    query: "why did Jesus have to die?",
    expectFirst: "confession-of-faith",
    requireIncluded: ["confession-of-faith"]
  }
];

let failures = 0;

for (const check of checks) {
  const classification = classifyQuestion(check.query);
  const results = searchDocuments(check.query, indexData.chunks, "all", classification);
  const governingDocs = results.governing.map((item) => item.documentId);
  const uniqueDocs = Array.from(new Set(governingDocs));

  if (check.expectFirst && uniqueDocs[0] !== check.expectFirst) {
    console.error(
      `FAIL: "${check.query}" expected first doc ${check.expectFirst} but got ${uniqueDocs[0] ?? "none"}`
    );
    failures += 1;
  }

  for (const documentId of check.requireIncluded ?? []) {
    if (!uniqueDocs.includes(documentId)) {
      console.error(`FAIL: "${check.query}" missing expected doc ${documentId}`);
      failures += 1;
    }
  }

  console.log(
    `OK: "${check.query}" [${classification.primaryIntent}] -> ${uniqueDocs.join(", ")}`
  );
}

if (failures) {
  process.exit(1);
}
