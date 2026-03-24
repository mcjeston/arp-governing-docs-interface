import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { convert } from "@opendataloader/pdf";
import * as cheerio from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const buildDir = path.join(rootDir, "build");
const downloadsDir = path.join(buildDir, "downloads");
const odlOutputDir = path.join(buildDir, "odl");
const dataDir = path.join(buildDir, "data");
const docsDataDir = path.join(rootDir, "docs", "data");
const manifestPath = path.join(docsDataDir, "source-manifest.json");

const GOVERNING_DOCS_URL = "https://arpchurch.org/governing-documents/";
const BELIEFS_URL = "https://arpchurch.org/what-we-believe/";
const PROJECT_LANGUAGE = "en";
const SUPPLEMENTAL_SECTION_DENYLIST = [
  /response to/i,
  /memorial/i,
  /references:/i,
  /report/i,
  /board of stewardship/i,
  /minutes/i,
  /committee/i
];
const PDF_NAMES = new Set([
  "Confession of Faith",
  "Larger Catechism",
  "Shorter Catechism",
  "Form of Government",
  "Book of Discipline",
  "Directory of Public Worship",
  "Directory of Private and Family Worship",
  "Manual of Authorities and Duties"
]);

const governingHtml = await fetchText(GOVERNING_DOCS_URL);
const beliefsHtml = await fetchText(BELIEFS_URL);

const governingDocs = extractGoverningDocs(governingHtml);
if (!governingDocs.length) {
  throw new Error("No governing document PDFs were discovered on the ARP source page.");
}

const pdfMetadata = [];
for (const doc of governingDocs) {
  pdfMetadata.push({
    slug: doc.slug,
    url: doc.url,
    ...(await fetchPdfMetadata(doc.url))
  });
}

const currentManifest = {
  language: PROJECT_LANGUAGE,
  governingPageHash: createHash(governingHtml),
  beliefsPageHash: createHash(beliefsHtml),
  documents: pdfMetadata
};

const previousManifest = await readJsonIfExists(manifestPath);
if (previousManifest && manifestsMatch(previousManifest, currentManifest)) {
  console.log("Sources unchanged; skipping PDF download and conversion.");
  process.exit(0);
}

await rm(buildDir, { recursive: true, force: true });
await mkdir(downloadsDir, { recursive: true });
await mkdir(odlOutputDir, { recursive: true });
await mkdir(dataDir, { recursive: true });

for (const doc of governingDocs) {
  doc.localPdfPath = path.join(downloadsDir, `${doc.slug}.pdf`);
  await downloadFile(doc.url, doc.localPdfPath);
}

await convert(
  governingDocs.map((doc) => doc.localPdfPath),
  {
    outputDir: odlOutputDir,
    format: "json,markdown",
    quiet: true,
    useStructTree: true,
    markdownPageSeparator: "\n\n<<<PAGE %page-number%>>>\n\n"
  }
);

const chunkDocuments = [];
for (const doc of governingDocs) {
  const markdownPath = path.join(odlOutputDir, `${doc.slug}.md`);
  const markdown = await readFile(markdownPath, "utf8");
  chunkDocuments.push(...splitPdfIntoChunks(doc, markdown));
}

const beliefContext = extractBeliefContext(beliefsHtml);
chunkDocuments.push(...beliefContext);

const searchIndex = {
  generatedAt: new Date().toISOString(),
  language: PROJECT_LANGUAGE,
  sourcePages: [GOVERNING_DOCS_URL, BELIEFS_URL],
  documents: governingDocs.map((doc) => ({
    id: doc.slug,
    title: doc.title,
    category: doc.category,
    url: doc.url,
    language: PROJECT_LANGUAGE,
    type: "pdf"
  })),
  chunks: chunkDocuments.map((chunk, index) => ({
    id: chunk.id ?? `chunk-${index + 1}`,
    title: chunk.title,
    section: chunk.section,
    page: chunk.page ?? null,
    sourceType: chunk.sourceType,
    sourceUrl: chunk.sourceUrl,
    documentId: chunk.documentId,
    category: chunk.category,
    language: chunk.language ?? PROJECT_LANGUAGE,
    text: chunk.text,
    terms: tokenize(chunk.text)
  }))
};

await writeFile(
  path.join(dataDir, "search-index.json"),
  JSON.stringify(searchIndex, null, 2),
  "utf8"
);

await writeFile(
  path.join(dataDir, "sources.json"),
  JSON.stringify(
    {
      generatedAt: searchIndex.generatedAt,
      governingDocs: governingDocs.map(({ slug, title, category, url }) => ({
        slug,
        title,
        category,
        language: PROJECT_LANGUAGE,
        url
      })),
      beliefContextSections: beliefContext.map(({ title, section, sourceUrl, category }) => ({
        title,
        section,
        category,
        sourceUrl
      }))
    },
    null,
    2
  ),
  "utf8"
);

await mkdir(docsDataDir, { recursive: true });
await writeFile(
  manifestPath,
  JSON.stringify(
    {
      generatedAt: searchIndex.generatedAt,
      ...currentManifest
    },
    null,
    2
  ),
  "utf8"
);

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "arp-governing-chat-build/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function downloadFile(url, destinationPath) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "arp-governing-chat-build/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  await writeFile(destinationPath, Buffer.from(arrayBuffer));
}

async function fetchPdfMetadata(url) {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: {
        "user-agent": "arp-governing-chat-build/0.1"
      }
    });

    if (!response.ok) {
      return {
        lastModified: null,
        contentLength: null
      };
    }

    return {
      lastModified: response.headers.get("last-modified"),
      contentLength: response.headers.get("content-length")
    };
  } catch {
    return {
      lastModified: null,
      contentLength: null
    };
  }
}

function extractGoverningDocs(html) {
  const $ = cheerio.load(html);
  const docs = [];

  $("h4 a, h4").each((_, element) => {
    const anchor = $(element).is("a") ? $(element) : $(element).find("a").first();
    if (!anchor.length) {
      return;
    }

    const title = normalizeWhitespace(anchor.text());
    if (!PDF_NAMES.has(title)) {
      return;
    }

    const href = anchor.attr("href");
    if (!href || !href.toLowerCase().endsWith(".pdf")) {
      return;
    }

    const category = inferCategory(title);
    docs.push({
      slug: slugify(title),
      title,
      category,
      url: new URL(href, GOVERNING_DOCS_URL).toString()
    });
  });

  return dedupeByUrl(docs);
}

function splitPdfIntoChunks(doc, markdown) {
  const rawPages = markdown
    .split(/<<<PAGE\s+(\d+)>>>/g)
    .slice(1);

  const pageChunks = [];
  for (let index = 0; index < rawPages.length; index += 2) {
    const pageNumber = Number(rawPages[index]);
    const rawPageText = rawPages[index + 1] ?? "";
    const pageText = normalizeWhitespace(rawPageText);
    if (!pageText) {
      continue;
    }

    const section = extractSectionHeading(rawPageText, doc.title);
    pageChunks.push({
      id: `${doc.slug}-p${pageNumber}`,
      title: doc.title,
      section,
      page: pageNumber,
      sourceType: "pdf",
      sourceUrl: doc.url,
      documentId: doc.slug,
      category: doc.category,
      language: PROJECT_LANGUAGE,
      text: pageText
    });
  }

  return pageChunks;
}

function extractBeliefContext(html) {
  const $ = cheerio.load(html);
  const contentRoot =
    $("main").first().length
      ? $("main").first()
      : $("article").first().length
        ? $("article").first()
        : $(".et_pb_post").first().length
          ? $(".et_pb_post").first()
          : $("body");
  const chunks = [];
  let sectionTitle = "What We Believe";
  let sectionBuffer = [];

  for (const element of contentRoot.find("h2, h3, h4, h5, p, li").toArray()) {
    const tag = element.tagName?.toLowerCase();
    const text = normalizeWhitespace($(element).text());
    if (!text) {
      continue;
    }

    if (tag && /^h[2-5]$/.test(tag)) {
      flushBeliefSection();
      sectionTitle = text;
      continue;
    }

    if (text === "DO NOT DELETE" || text === "Your content goes here. Edit or remove this text inline or in the module Content settings. You can also style every aspect of this content in the module Design settings and even apply custom CSS to this text in the module Advanced settings.") {
      continue;
    }

    sectionBuffer.push(text);
  }

  flushBeliefSection();
  return chunks;

  function flushBeliefSection() {
    const text = normalizeWhitespace(sectionBuffer.join(" "));
    if (!text || !isAllowedSupplementalSection(sectionTitle)) {
      sectionBuffer = [];
      return;
    }

    chunks.push({
      id: `belief-${slugify(sectionTitle)}`,
      title: "What We Believe",
      section: sectionTitle,
      sourceType: "supplemental",
      sourceUrl: BELIEFS_URL,
      documentId: "what-we-believe",
      category: "belief-context",
      language: PROJECT_LANGUAGE,
      text
    });

    sectionBuffer = [];
  }
}

function extractSectionHeading(rawText, fallbackTitle) {
  const lines = rawText
    .split(/\r?\n+/)
    .map((line) =>
      normalizeWhitespace(
        line
          .replace(/^#+\s*/, "")
          .replace(/\s*#+\s*$/, "")
      )
    )
    .filter(Boolean);

  for (const line of lines.slice(0, 20)) {
    if (/^chapter\b/i.test(line) && line.length <= 160) {
      return line;
    }

    if (/^(of|chapter|section|part)\b/i.test(line) && line.length <= 160) {
      return line;
    }

    if (line.length >= 6 && line.length <= 120 && /^[A-Z0-9 .,'()\-]+$/.test(line)) {
      return line;
    }
  }

  const sentenceLikeLines = normalizeWhitespace(rawText)
    .split(/(?<=[.!?])\s+/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);

  for (const line of sentenceLikeLines.slice(0, 10)) {
    if (line.length >= 6 && line.length <= 120 && /^[A-Z0-9 .,'()\-]+$/.test(line)) {
      return line;
    }
  }

  return fallbackTitle;
}

function isAllowedSupplementalSection(sectionTitle) {
  return !SUPPLEMENTAL_SECTION_DENYLIST.some((pattern) => pattern.test(sectionTitle));
}

function tokenize(text) {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((token) => token.length >= 2)
    )
  );
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function inferCategory(title) {
  if (title.includes("Government")) {
    return "church-government";
  }

  if (title.includes("Discipline")) {
    return "discipline";
  }

  if (title.includes("Catechism") || title.includes("Confession")) {
    return "doctrinal-standards";
  }

  return "worship-and-authorities";
}

function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.url)) {
      return false;
    }

    seen.add(item.url);
    return true;
  });
}

function createHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function readJsonIfExists(filePath) {
  try {
    await stat(filePath);
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function manifestsMatch(previousManifest, currentManifest) {
  return JSON.stringify(previousManifest.documents) === JSON.stringify(currentManifest.documents) &&
    previousManifest.governingPageHash === currentManifest.governingPageHash &&
    previousManifest.beliefsPageHash === currentManifest.beliefsPageHash &&
    previousManifest.language === currentManifest.language;
}
