import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const buildDir = path.join(rootDir, "build");
const dataDir = path.join(buildDir, "data");
const siteDir = path.join(rootDir, "site");
const docsDir = path.join(rootDir, "docs");
const generatedFiles = ["search-index.json", "sources.json", "source-manifest.json"];

await mkdir(docsDir, { recursive: true });
await mkdir(path.join(docsDir, "data"), { recursive: true });

for (const entry of await readdir(siteDir, { withFileTypes: true })) {
  const sourcePath = path.join(siteDir, entry.name);
  const targetPath = path.join(docsDir, entry.name);

  if (entry.isDirectory()) {
    await rm(targetPath, { recursive: true, force: true });
    await cp(sourcePath, targetPath, { recursive: true });
    continue;
  }

  await cp(sourcePath, targetPath, { force: true });
}

for (const fileName of generatedFiles) {
  const sourcePath = path.join(dataDir, fileName);
  if (!(await exists(sourcePath))) {
    continue;
  }

  const fileContents = await readFile(sourcePath, "utf8");
  await writeFile(path.join(docsDir, "data", fileName), fileContents, "utf8");
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
