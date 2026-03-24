import {
  buildLocalAnswer,
  buildPriorityReview,
  classifyQuestion,
  extractSnippetDetails,
  searchDocuments,
  sourceDescriptor
} from "./search-core.js";

const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const questionType = document.getElementById("question-type");
const buildStatus = document.getElementById("build-status");
const messageTemplate = document.getElementById("message-template");
const loadingScreen = document.getElementById("loading-screen");
const loadingText = document.getElementById("loading-text");
const loadingLogoStack = document.getElementById("loading-logo-stack");
const heroLogo = document.getElementById("hero-logo");
const apiBase = normalizeApiBase(window.ARP_API_BASE ?? "");

let indexData = null;
let apiStatus = null;
let loadingFillInterval = null;
let pendingAssistantMessage = null;

startLoadingAnimation();
initialize().catch((error) => {
  console.error(error);
  buildStatus.textContent = "The document index could not be loaded.";
  loadingText.textContent = "The interface could not finish loading.";
  finishLoadingSequence();
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!indexData) {
    return;
  }

  const question = chatInput.value.trim();
  const selectedQuestionType = questionType.value;
  if (!question) {
    return;
  }

  appendMessage("You", `<p>${escapeHtml(question)}</p>`, "message-user");
  chatInput.value = "";
  pendingAssistantMessage = appendMessage(
    "Assistant",
    `<p class="thinking-indicator">Thinking<span class="thinking-dots"></span></p>`,
    "message-assistant"
  );

  const response = await askAssistant(question, selectedQuestionType);
  replaceMessage(pendingAssistantMessage, "Assistant", renderAnswer(response, question), "message-assistant");
  pendingAssistantMessage = null;
  chatInput.focus();
});

chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

async function initialize() {
  await waitForRefresh();

  const [indexResponse, healthResponse] = await Promise.all([
    fetch("./data/search-index.json", { cache: "no-store" }),
    fetch(apiUrl("/api/health"), { cache: "no-store" }).catch(() => null)
  ]);

  if (!indexResponse.ok) {
    throw new Error(`Failed to load search index: ${indexResponse.status}`);
  }

  indexData = await indexResponse.json();
  apiStatus = healthResponse && healthResponse.ok ? await healthResponse.json() : null;

  const updated = new Date(indexData.generatedAt).toLocaleString();
  buildStatus.textContent = apiStatus?.llmEnabled
    ? apiStatus.llmLastError
      ? `Latest ARP source refresh: ${updated}. LLM mode: ${apiStatus.model}. Server ${apiStatus.responseVersion}. Last LLM error: ${apiStatus.llmLastError}`
      : `Latest ARP source refresh: ${updated}. LLM mode: ${apiStatus.model}. Server ${apiStatus.responseVersion}.`
    : `Latest ARP source refresh: ${updated}. Local citation mode active. Server ${apiStatus?.responseVersion ?? "unknown"}.`;

  finishLoadingSequence();
}

async function waitForRefresh() {
  setLoadingFill(12);
  let attempts = 0;

  while (attempts < 120) {
    attempts += 1;
    const response = await fetch(apiUrl("/api/status"), { cache: "no-store" }).catch(() => null);
    if (!response || !response.ok) {
      loadingText.textContent = "Opening interface...";
      await delay(300);
      continue;
    }

    const status = await response.json();
    loadingText.textContent = status.refreshing
      ? "Refreshing ARP source data..."
      : "Finalizing interface...";

    if (status.refreshing) {
      const progress = Math.min(88, 14 + attempts * 2);
      setLoadingFill(progress);
      await delay(500);
      continue;
    }

    if (status.lastError) {
      loadingText.textContent = "Using the latest available local ARP data...";
    }

    setLoadingFill(100);
    await delay(250);
    return;
  }

  setLoadingFill(100);
}

async function askAssistant(question, selectedQuestionType) {
  try {
    const response = await fetch(apiUrl("/api/chat"), {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        question,
        questionType: selectedQuestionType,
        category: "all"
      })
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error(error);
    return buildFallbackResponse(
      question,
      selectedQuestionType,
      "The API request failed. Showing the local citation-based answer instead."
    );
  }
}

function buildFallbackResponse(question, selectedQuestionType, warning = "") {
  const classification = classifyQuestion(question, selectedQuestionType);
  const results = searchDocuments(question, indexData.chunks, "all", classification);
  if (!results.governing.length) {
    return {
      mode: "fallback",
      responseVersion: apiStatus?.responseVersion ?? "browser-fallback",
      warning,
      answer: "No strong match was found in the current ARP document set. Try naming a doctrine, office, process, or document.",
      citations: [],
      supplemental: [],
      reviewedSources: [],
      classification
    };
  }

  return {
    mode: "fallback",
    responseVersion: apiStatus?.responseVersion ?? "browser-fallback",
    warning,
    answer: buildLocalAnswer(question, results.governing, results.queryProfile),
    citations: results.governing.map((item) => ({
      ...snippetPayload(item.text, question),
      title: item.title,
      section: item.section,
      page: item.page,
      sourceUrl: item.sourceUrl,
      sourceType: item.sourceType,
      category: item.category
    })),
    supplemental: results.supplemental.map((item) => ({
      ...snippetPayload(item.text, question),
      title: item.title,
      section: item.section,
      page: item.page,
      sourceUrl: item.sourceUrl,
      sourceType: item.sourceType,
      category: item.category
    })),
    reviewedSources: buildPriorityReview(results.governing),
    classification
  };
}

function renderAnswer(response, question) {
  const citationsHtml = (response.citations ?? [])
    .map((citation) => {
      const citationText = citation.page
        ? `${citation.title}, page ${citation.page}`
        : `${citation.title}, ${citation.section}`;
      const href = citation.page && /\.pdf($|[?#])/i.test(citation.sourceUrl)
        ? `${citation.sourceUrl}#page=${citation.page}`
        : citation.sourceUrl;
      return `
        <li>
          <a href="${href}" target="_blank" rel="noreferrer">${escapeHtml(citationText)}</a>
          <p>${highlightRelevantText(citation.snippet, question)}</p>
          ${renderReferences(citation.references)}
        </li>
      `;
    })
    .join("");

  const supplementalHtml = (response.supplemental ?? []).length
    ? `
      <section class="supplemental-block">
        <p class="supplemental-title">Additional context from the ARP belief/position material:</p>
        <ol class="citations">
          ${(response.supplemental ?? [])
            .map((item) => `
              <li>
                <a href="${item.sourceUrl}" target="_blank" rel="noreferrer">${escapeHtml(item.section)}</a>
                <p>${highlightRelevantText(item.snippet, question)}</p>
                ${renderReferences(item.references)}
              </li>
            `)
            .join("")}
        </ol>
      </section>
    `
    : "";

  const warningHtml = response.warning
    ? `<p class="build-meta">${escapeHtml(response.warning)}</p>`
    : "";

  const citationCount = (response.citations ?? []).length;
  const sourceChipsHtml = citationCount
    ? `<ul class="source-chips">${renderSourceChips(response.citations ?? [])}</ul>`
    : "";
  const citationSection = citationCount
    ? `
      ${sourceChipsHtml}
      <details class="citations-panel">
        <summary>Citations (${citationCount})</summary>
        <ol class="citations">${citationsHtml}</ol>
      </details>
    `
    : "";

  return `
    <p>${escapeHtml(response.answer)}</p>
    ${warningHtml}
    ${citationSection}
    ${supplementalHtml}
  `;
}

function renderSourceChips(results) {
  const uniqueSources = Array.from(
    new Map(
      results.map((result) => [
        `${result.title}:${result.page ?? result.section}`,
        result.page ? `${result.title} p.${result.page}` : result.title
      ])
    ).values()
  );

  return uniqueSources
    .map((label) => `<li class="source-chip">${escapeHtml(label)}</li>`)
    .join("");
}

function renderReferences(references = []) {
  if (!references.length) {
    return "";
  }

  return `<p class="scripture-refs">${escapeHtml(references.join(" "))}</p>`;
}

function appendMessage(label, html, className) {
  const fragment = messageTemplate.content.cloneNode(true);
  const article = fragment.querySelector(".message");
  article.classList.add(className);
  fragment.querySelector(".message-label").textContent = label;
  fragment.querySelector(".message-body").innerHTML = html;
  chatLog.appendChild(fragment);
  chatLog.scrollTop = chatLog.scrollHeight;
  return article;
}

function replaceMessage(article, label, html, className) {
  if (!article) {
    appendMessage(label, html, className);
    return;
  }

  article.className = "message";
  article.classList.add(className);
  article.querySelector(".message-label").textContent = label;
  article.querySelector(".message-body").innerHTML = html;
  chatLog.scrollTop = chatLog.scrollHeight;
}

function startLoadingAnimation() {
  let progress = 8;
  setLoadingFill(progress);
  loadingFillInterval = window.setInterval(() => {
    progress = Math.min(82, progress + 3);
    setLoadingFill(progress);
  }, 280);
}

function finishLoadingSequence() {
  if (loadingFillInterval) {
    window.clearInterval(loadingFillInterval);
    loadingFillInterval = null;
  }

  setLoadingFill(100);

  const startRect = loadingLogoStack.getBoundingClientRect();
  const endRect = heroLogo.getBoundingClientRect();
  const deltaX = endRect.left + endRect.width / 2 - (startRect.left + startRect.width / 2);
  const deltaY = endRect.top + endRect.height / 2 - (startRect.top + startRect.height / 2);
  const scale = endRect.width / startRect.width;

  loadingLogoStack.animate(
    [
      {
        transform: "translate(0px, 0px) scale(1)",
        opacity: 1
      },
      {
        transform: `translate(${deltaX}px, ${deltaY}px) scale(${scale})`,
        opacity: 1
      }
    ],
    {
      duration: 460,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      fill: "forwards"
    }
  );

  window.setTimeout(() => {
    document.body.classList.remove("is-loading");
    loadingScreen.classList.add("is-hidden");
  }, 420);
}

function setLoadingFill(progress) {
  loadingScreen.style.setProperty("--loading-fill", `${progress}%`);
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return `${value ?? ""}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function snippetPayload(text, question) {
  const details = extractSnippetDetails(text, question);
  return {
    snippet: details.text,
    references: details.references
  };
}

function highlightRelevantText(text, question) {
  const escaped = escapeHtml(text);
  const terms = Array.from(
    new Set(
      `${question ?? ""}`
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((term) => term.length >= 4)
    )
  ).sort((a, b) => b.length - a.length);

  let highlighted = escaped;
  for (const term of terms.slice(0, 10)) {
    const pattern = new RegExp(`\\b(${escapeRegExp(term)})\\b`, "gi");
    highlighted = highlighted.replace(pattern, "<strong>$1</strong>");
  }

  return highlighted;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeApiBase(value) {
  const raw = `${value ?? ""}`.trim();
  if (!raw) {
    return "";
  }

  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function apiUrl(path) {
  return apiBase ? `${apiBase}${path}` : `.${path}`;
}
