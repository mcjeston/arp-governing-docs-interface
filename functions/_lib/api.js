import {
  DOCUMENT_LABELS,
  buildLocalAnswer,
  buildPriorityReview,
  classifyQuestion,
  extractSnippetDetails,
  searchDocuments
} from "../../site/search-core.js";

const responseVersion = "2026-03-24-cf1";

let indexCache = null;

export async function handleHealth(env, request) {
  return jsonResponse({
    ok: true,
    responseVersion,
    llmEnabled: Boolean(env.OPENAI_API_KEY),
    model: env.OPENAI_API_KEY ? env.OPENAI_MODEL || "gpt-5.4" : null,
    mode: env.OPENAI_API_KEY ? "openai" : "fallback",
    refreshing: false,
    stage: "ready",
    quotaMode: env.USAGE_LIMITS ? "kv" : "none"
  });
}

export async function handleStatus(env, request) {
  const indexData = await loadIndex(env, request);
  return jsonResponse({
    ok: true,
    responseVersion,
    llmEnabled: Boolean(env.OPENAI_API_KEY),
    model: env.OPENAI_API_KEY ? env.OPENAI_MODEL || "gpt-5.4" : null,
    refreshing: false,
    stage: "ready",
    lastStartedAt: null,
    lastCompletedAt: indexData.generatedAt ?? null,
    lastError: null,
    llmLastError: null,
    llmLastSuccessAt: null,
    quotaMode: env.USAGE_LIMITS ? "kv" : "none"
  });
}

export async function handleChat(request, env) {
  const body = await request.json().catch(() => ({}));
  const question = `${body?.question ?? ""}`.trim();
  const questionType = `${body?.questionType ?? "auto"}`.trim() || "auto";
  const selectedCategory = `${body?.category ?? "all"}`.trim() || "all";
  const clientKey = getClientKey(body, request);

  if (!question) {
    return jsonResponse({ error: "Question is required." }, 400);
  }

  const indexData = await loadIndex(env, request);
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
    return jsonResponse({
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
  const model = env.OPENAI_MODEL || "gpt-5.4";

  if (!env.OPENAI_API_KEY) {
    return jsonResponse({
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

  const limitResult = await consumeDailyQuota(env, clientKey);
  if (!limitResult.allowed) {
    return jsonResponse({
      mode: "fallback",
      responseVersion,
      warning: `The daily OpenAI usage limit has been reached for this user (${limitResult.limit} requests per day). Showing the local citation-based answer instead.`,
      answer: localAnswer,
      citations,
      supplemental,
      reviewedSources,
      classification
    });
  }

  try {
    const llmResult = await generateOpenAIAnswer(question, results, env);
    return jsonResponse({
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
    return jsonResponse({
      mode: "fallback",
      responseVersion,
      warning: `The OpenAI request failed. ${summarizeOpenAIError(error)} Showing the local citation-based answer instead.`,
      answer: localAnswer,
      citations,
      supplemental,
      reviewedSources,
      classification
    });
  }
}

async function loadIndex(env, request) {
  if (indexCache) {
    return indexCache;
  }

  const assetUrl = new URL("/data/search-index.json", request.url);
  let response = null;

  if (env.ASSETS?.fetch) {
    response = await env.ASSETS.fetch(new Request(assetUrl.toString()));
  } else {
    response = await fetch(assetUrl.toString(), { cf: { cacheTtl: 60 } });
  }

  if (!response.ok) {
    throw new Error(`Failed to load search index asset: ${response.status}`);
  }

  indexCache = await response.json();
  return indexCache;
}

async function generateOpenAIAnswer(question, results, env) {
  const allowedTitles = collectAllowedTitles(results);
  const correctiveTitles = Array.from(
    new Set(Object.values(DOCUMENT_LABELS).filter((title) => !allowedTitles.has(title)))
  );
  const primaryContext = results.governing
    .map((item, index) => {
      const citation = item.page ? `${item.title}, page ${item.page}` : `${item.title}, ${item.section}`;
      return `[Primary ${index + 1}] ${citation}\nSection: ${item.section}\nText: ${item.text}`;
    })
    .join("\n\n");
  const supplementalContext = results.supplemental.length
    ? results.supplemental
        .map((item, index) => {
          const citation = item.page ? `${item.title}, page ${item.page}` : `${item.title}, ${item.section}`;
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
    "Use this source priority strictly: 1. Confession of Faith, 2. Larger Catechism, 3. Shorter Catechism, 4. Form of Government and Book of Discipline, 5. Directory of Public Worship and Directory of Private and Family Worship, 6. Manual of Authorities and Duties, then 7. Position Statements and other resources.",
    "If a higher-priority source does not directly answer the question, ignore it rather than discussing it.",
    "If a higher-priority source answers the question, do not let lower-priority sources override it.",
    "Use supplemental sources only as additional comments when they are relevant.",
    "If the sources are ambiguous or incomplete, say so plainly.",
    "Do not tell the user to consult some other document unless that document is already in the provided evidence.",
    "Respond in 1 to 3 short paragraphs of plain text and do not invent citations or facts beyond the provided context."
  ].join(" ");

  const initialAnswer = await requestOpenAIAnswer(
    env,
    baseInstructions,
    question,
    classificationContext,
    primaryContext,
    supplementalContext
  );
  const initialValidation = validateAnswerAgainstEvidence(initialAnswer, allowedTitles);
  if (initialValidation.valid) {
    return { answer: initialAnswer };
  }

  const retryInstructions = [
    baseInstructions,
    `Your previous draft was invalid because it mentioned forbidden document titles: ${initialValidation.offendingTitles.join(", ")}.`,
    `Forbidden titles for this answer include: ${correctiveTitles.join(", ")}.`,
    "Retry now. Use only the allowed document titles if you mention any title at all."
  ].join(" ");

  const retryAnswer = await requestOpenAIAnswer(
    env,
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

async function requestOpenAIAnswer(env, instructions, question, classificationContext, primaryContext, supplementalContext) {
  const model = env.OPENAI_MODEL || "gpt-5.4";
  const reasoningEffort = env.OPENAI_REASONING_EFFORT || "medium";

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
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
          content: [{ type: "input_text", text: question }]
        }
      ]
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    const apiMessage = payload?.error?.message || `OpenAI API returned ${response.status}`;
    throw new Error(apiMessage);
  }

  return `${payload.output_text ?? ""}`.trim() || "The model did not return a text answer.";
}

async function consumeDailyQuota(env, clientKey) {
  const limit = Number(env.OPENAI_DAILY_LIMIT || 25);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: true, limit: 0 };
  }

  if (!env.USAGE_LIMITS) {
    return { allowed: true, limit };
  }

  const dayKey = new Date().toISOString().slice(0, 10);
  const hash = await sha256(`${dayKey}:${clientKey}`);
  const key = `usage:${dayKey}:${hash}`;
  const currentRaw = await env.USAGE_LIMITS.get(key);
  const current = Number(currentRaw || 0);
  if (current >= limit) {
    return { allowed: false, limit };
  }

  await env.USAGE_LIMITS.put(key, String(current + 1), {
    expirationTtl: 60 * 60 * 36
  });
  return { allowed: true, limit };
}

function snippetPayload(text, question) {
  const details = extractSnippetDetails(text, question);
  return {
    snippet: details.text,
    references: details.references
  };
}

function collectAllowedTitles(results) {
  return new Set(
    [...results.governing, ...results.supplemental]
      .map((item) => DOCUMENT_LABELS[item.documentId] ?? item.title)
      .filter(Boolean)
  );
}

function validateAnswerAgainstEvidence(answer, allowedTitles) {
  const normalizedAnswer = `${answer ?? ""}`.toLowerCase();
  const offendingTitles = Object.values(DOCUMENT_LABELS).filter((title) => {
    if (allowedTitles.has(title)) {
      return false;
    }

    return normalizedAnswer.includes(title.toLowerCase());
  });

  return {
    valid: offendingTitles.length === 0,
    offendingTitles
  };
}

function getClientKey(body, request) {
  if (`${body?.userId ?? ""}`.trim()) {
    return `user:${`${body.userId}`.trim()}`;
  }

  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "anonymous";
  return `ip:${ip}`;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function summarizeOpenAIError(error) {
  const message = `${error?.message ?? error ?? "Unknown error"}`.trim();
  if (!message) {
    return "Unknown error.";
  }

  return /network|fetch|connection/i.test(message) ? "Connection error." : message;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
