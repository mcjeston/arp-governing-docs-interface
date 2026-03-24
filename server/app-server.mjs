import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { spawn } from "node:child_process";
import OpenAI from "openai";
import {
  DOCUMENT_LABELS,
  buildLocalAnswer,
  buildPriorityReview,
  classifyQuestion,
  extractSnippetDetails,
  searchDocuments
} from "../site/search-core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const docsDir = path.join(rootDir, "docs");
const dataPath = path.join(docsDir, "data", "search-index.json");
const pidFilePath = path.join(rootDir, ".preview-server.json");
const port = Number(process.env.PORT || 4182);
const responseVersion = "2026-03-24c";

loadEnvFile(path.join(rootDir, ".env.local"));

const model = process.env.OPENAI_MODEL || "gpt-5.4";
const reasoningEffort = process.env.OPENAI_REASONING_EFFORT || "medium";
const apiKey = process.env.OPENAI_API_KEY || "";
const openai = apiKey ? new OpenAI({ apiKey }) : null;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png"
};

let indexCache = null;
let refreshState = {
  refreshing: false,
  stage: "idle",
  lastStartedAt: null,
  lastCompletedAt: null,
  lastError: null
};

let llmState = {
  lastError: null,
  lastSuccessAt: null
};

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host}`);

    if (request.method === "GET" && requestUrl.pathname === "/api/health") {
      return sendJson(response, 200, {
        ok: true,
        responseVersion,
        llmEnabled: Boolean(openai),
        model: openai ? model : null,
        mode: openai ? "openai" : "fallback",
        refreshing: refreshState.refreshing,
        stage: refreshState.stage,
        llmLastError: llmState.lastError,
        llmLastSuccessAt: llmState.lastSuccessAt
      });
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/status") {
      return sendJson(response, 200, {
        ok: true,
        responseVersion,
        llmEnabled: Boolean(openai),
        model: openai ? model : null,
        refreshing: refreshState.refreshing,
        stage: refreshState.stage,
        lastStartedAt: refreshState.lastStartedAt,
        lastCompletedAt: refreshState.lastCompletedAt,
        lastError: refreshState.lastError,
        llmLastError: llmState.lastError,
        llmLastSuccessAt: llmState.lastSuccessAt
      });
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/chat") {
      const body = await readJsonBody(request);
      return await handleChat(body, response);
    }

    if (request.method === "GET") {
      return await serveStatic(requestUrl.pathname, response);
    }

    sendJson(response, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "Internal server error" });
  }
});

server.listen(port, "127.0.0.1", () => {
  writePreviewPidFile();
  console.log(`Preview server running at http://127.0.0.1:${port}`);
  startBackgroundRefresh();
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.log(`Preview server already running at http://127.0.0.1:${port}`);
    process.exit(0);
  }

  console.error(error);
  process.exit(1);
});

process.on("exit", cleanupPreviewPidFile);
process.on("SIGINT", () => {
  cleanupPreviewPidFile();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanupPreviewPidFile();
  process.exit(0);
});

async function handleChat(body, response) {
  const question = `${body?.question ?? ""}`.trim();
  const questionType = `${body?.questionType ?? "auto"}`.trim() || "auto";
  const selectedCategory = `${body?.category ?? "all"}`.trim() || "all";
  if (!question) {
    return sendJson(response, 400, { error: "Question is required." });
  }

  const indexData = await loadIndex();
  const classification = classifyQuestion(question, questionType);
  const results = searchDocuments(question, indexData.chunks, selectedCategory, classification);
  const citations = results.governing.map((item) => ({
    ...(snippetPayload(item.text, question)),
    title: item.title,
    section: item.section,
    page: item.page,
    sourceUrl: item.sourceUrl,
    sourceType: item.sourceType,
    category: item.category,
    documentId: item.documentId
  }));

  const supplemental = results.supplemental.map((item) => ({
    ...(snippetPayload(item.text, question)),
    title: item.title,
    section: item.section,
    page: item.page,
    sourceUrl: item.sourceUrl,
    sourceType: item.sourceType,
    category: item.category,
    documentId: item.documentId
  }));

  if (!results.governing.length) {
    return sendJson(response, 200, {
      mode: "fallback",
      responseVersion,
      answer: "No strong match was found in the current ARP document set. Try naming a doctrine, office, process, or document.",
      citations,
      supplemental,
      reviewedSources: [],
      classification
    });
  }

  const reviewedSources = buildPriorityReview(results.governing);
  const localAnswer = buildLocalAnswer(question, results.governing, results.queryProfile);

  if (!openai) {
    return sendJson(response, 200, {
      mode: "fallback",
      responseVersion,
      warning: "OPENAI_API_KEY is not configured. Showing the local citation-based answer instead.",
      answer: localAnswer,
      citations,
      supplemental,
      reviewedSources,
      classification
    });
  }

  try {
    const llmResult = await generateOpenAIAnswer(question, results);
    llmState = {
      lastError: null,
      lastSuccessAt: new Date().toISOString()
    };
    return sendJson(response, 200, {
      mode: "openai",
      responseVersion,
      model,
      answer: llmResult.answer,
      warning: llmResult.warning ?? null,
      citations,
      supplemental,
      reviewedSources,
      classification
    });
  } catch (error) {
    console.error(error);
    llmState = {
      lastError: summarizeOpenAIError(error),
      lastSuccessAt: llmState.lastSuccessAt
    };
    return sendJson(response, 200, {
      mode: "fallback",
      responseVersion,
      warning: `The OpenAI request failed. ${llmState.lastError} Showing the local citation-based answer instead.`,
      answer: localAnswer,
      citations,
      supplemental,
      reviewedSources,
      classification
    });
  }
}

async function generateOpenAIAnswer(question, results) {
  const allowedTitles = collectAllowedTitles(results);
  const correctiveTitles = Array.from(
    new Set(
      Object.values(DOCUMENT_LABELS).filter((title) => !allowedTitles.has(title))
    )
  );
  const primaryContext = results.governing
    .map((item, index) => {
      const citation = item.page
        ? `${item.title}, page ${item.page}`
        : `${item.title}, ${item.section}`;
      return `[Primary ${index + 1}] ${citation}\nSection: ${item.section}\nText: ${item.text}`;
    })
    .join("\n\n");

  const supplementalContext = results.supplemental.length
    ? results.supplemental
        .map((item, index) => {
          const citation = item.page
            ? `${item.title}, page ${item.page}`
            : `${item.title}, ${item.section}`;
          return `[Supplemental ${index + 1}] ${citation}\nSection: ${item.section}\nText: ${item.text}`;
        })
        .join("\n\n")
    : "None";
  const classificationContext = [
    `Primary intent: ${results.classification?.primaryIntent ?? "general"}`,
    `Secondary intents: ${(results.classification?.secondaryIntents ?? []).join(", ") || "none"}`,
    `Suggested governing documents: ${(results.classification?.suggestedDocuments ?? []).join(", ") || "none"}`
  ].join("\n");

  const baseInstructions = [
    "You are an ARP governing documents assistant.",
    "Answer only from the provided sources.",
    "Never mention or rely on any document that is not included in the provided Primary or Supplemental sources.",
    `Allowed document titles for this answer: ${Array.from(allowedTitles).join(", ")}.`,
    "Review all provided primary sources before answering. Do not stop after the first one or two documents if more primary evidence is supplied.",
    "Distinguish between documents that directly answer the question and documents that only contain incidental word overlap. Base the answer on the directly relevant sources.",
    "Use this source priority strictly: 1. Confession of Faith, 2. Larger Catechism, 3. Shorter Catechism, 4. Form of Government and Book of Discipline, 5. Directory of Public Worship and Directory of Private and Family Worship, 6. Manual of Authorities and Duties, 7. Position Statements and other resources.",
    "If a higher-priority source does not directly answer the question, ignore it rather than discussing it.",
    "If a higher-priority source answers the question, do not let lower-priority sources override it.",
    "Use supplemental sources only as additional comments when they are relevant.",
    "If the sources are ambiguous or incomplete, say so plainly.",
    "Do not tell the user to consult some other document unless that document is already in the provided evidence.",
    "Respond in 1 to 3 short paragraphs of plain text and do not invent citations or facts beyond the provided context."
  ].join(" ");

  const initialAnswer = await requestOpenAIAnswer(
    baseInstructions,
    question,
    classificationContext,
    primaryContext,
    supplementalContext
  );
  const initialValidation = validateAnswerAgainstEvidence(initialAnswer, allowedTitles);
  if (initialValidation.valid) {
    return {
      answer: initialAnswer
    };
  }

  const retryInstructions = [
    baseInstructions,
    `Your previous draft was invalid because it mentioned forbidden document titles: ${initialValidation.offendingTitles.join(", ")}.`,
    `Forbidden titles for this answer include: ${correctiveTitles.join(", ")}.`,
    "Retry now. Use only the allowed document titles if you mention any title at all."
  ].join(" ");

  const retryAnswer = await requestOpenAIAnswer(
    retryInstructions,
    question,
    classificationContext,
    primaryContext,
    supplementalContext
  );
  const retryValidation = validateAnswerAgainstEvidence(retryAnswer, allowedTitles);
  if (!retryValidation.valid) {
    throw new Error(
      `The model continued to reference documents outside the retrieved evidence: ${retryValidation.offendingTitles.join(", ")}`
    );
  }

  return {
    answer: retryAnswer,
    warning: "The model's first draft referenced a document outside the retrieved evidence, so the answer was regenerated from the allowed sources only."
  };
}

async function requestOpenAIAnswer(
  instructions,
  question,
  classificationContext,
  primaryContext,
  supplementalContext
) {
  const response = await openai.responses.create({
    model,
    reasoning: { effort: reasoningEffort },
    instructions,
    input: [
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: `Question classification:\n${classificationContext}\n\nPrimary sources:\n${primaryContext}\n\nSupplemental sources:\n${supplementalContext}`
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: question
          }
        ]
      }
    ]
  });

  return response.output_text?.trim() || "The model did not return a text answer.";
}

async function serveStatic(pathname, response) {
  let relativePath = decodeURIComponent(pathname);
  if (relativePath === "/") {
    relativePath = "/index.html";
  }

  const safePath = path.normalize(relativePath).replace(/^(\.\.[\\/])+/, "");
  const filePath = path.join(docsDir, safePath);
  const extension = path.extname(filePath).toLowerCase();

  try {
    const data = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypes[extension] ?? "application/octet-stream",
      "cache-control": "no-store"
    });
    response.end(data);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

async function loadIndex() {
  if (!indexCache) {
    indexCache = JSON.parse(await readFile(dataPath, "utf8"));
  }

  return indexCache;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function loadEnvFile(filePath) {
  try {
    const contents = readFileSync(filePath, "utf8");
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      let value = line.slice(separatorIndex + 1).trim();
      value = value.replace(/^['"]|['"]$/g, "");
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // Ignore missing env file.
  }
}

function writePreviewPidFile() {
  writeFileSync(
    pidFilePath,
    JSON.stringify(
      {
        pid: process.pid,
        port,
        startedAt: new Date().toISOString()
      },
      null,
      2
    ),
    "utf8"
  );
}

function collectAllowedTitles(results) {
  return new Set(
    [...(results.governing ?? []), ...(results.supplemental ?? [])]
      .map((item) => item.title)
      .filter(Boolean)
  );
}

function validateAnswerAgainstEvidence(answer, allowedTitles) {
  const offendingTitles = Array.from(
    new Set(
      Object.values(DOCUMENT_LABELS).filter(
        (title) => !allowedTitles.has(title) && answer.toLowerCase().includes(title.toLowerCase())
      )
    )
  );

  return {
    valid: offendingTitles.length === 0,
    offendingTitles
  };
}

function cleanupPreviewPidFile() {
  try {
    if (!existsSync(pidFilePath)) {
      return;
    }

    const contents = JSON.parse(readFileSync(pidFilePath, "utf8"));
    if (contents?.pid === process.pid) {
      unlinkSync(pidFilePath);
    }
  } catch {
    // Ignore cleanup failures.
  }
}

function startBackgroundRefresh() {
  if (refreshState.refreshing) {
    return;
  }

  refreshState = {
    refreshing: true,
    stage: "Refreshing ARP source data",
    lastStartedAt: new Date().toISOString(),
    lastCompletedAt: refreshState.lastCompletedAt,
    lastError: null
  };

  const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npmExecutable, ["run", "build"], {
    cwd: rootDir,
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
    shell: process.platform === "win32"
  });

  child.on("exit", (code) => {
    if (code === 0) {
      indexCache = null;
      refreshState = {
        refreshing: false,
        stage: "ready",
        lastStartedAt: refreshState.lastStartedAt,
        lastCompletedAt: new Date().toISOString(),
        lastError: null
      };
      return;
    }

    refreshState = {
      refreshing: false,
      stage: "ready-with-error",
      lastStartedAt: refreshState.lastStartedAt,
      lastCompletedAt: refreshState.lastCompletedAt,
      lastError: `Build exited with code ${code}`
    };
  });

  child.on("error", (error) => {
    refreshState = {
      refreshing: false,
      stage: "ready-with-error",
      lastStartedAt: refreshState.lastStartedAt,
      lastCompletedAt: refreshState.lastCompletedAt,
      lastError: error.message
    };
  });
}

function summarizeOpenAIError(error) {
  if (!error) {
    return "Unknown OpenAI error.";
  }

  if (error.status) {
    return `OpenAI API error ${error.status}: ${error.message}`;
  }

  if (error.code) {
    return `OpenAI connection error (${error.code}): ${error.message}`;
  }

  return error.message || "Unknown OpenAI error.";
}

function snippetPayload(text, question) {
  const details = extractSnippetDetails(text, question);
  return {
    snippet: details.text,
    references: details.references
  };
}
