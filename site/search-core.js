export const DOCUMENT_PRIORITY = [
  "confession-of-faith",
  "larger-catechism",
  "shorter-catechism",
  "form-of-government",
  "book-of-discipline",
  "directory-of-public-worship",
  "directory-of-private-and-family-worship",
  "manual-of-authorities-and-duties",
  "what-we-believe"
];

export const DOCUMENT_LABELS = {
  "confession-of-faith": "Confession of Faith",
  "larger-catechism": "Larger Catechism",
  "shorter-catechism": "Shorter Catechism",
  "form-of-government": "Form of Government",
  "book-of-discipline": "Book of Discipline",
  "directory-of-public-worship": "Directory of Public Worship",
  "directory-of-private-and-family-worship": "Directory of Private and Family Worship",
  "manual-of-authorities-and-duties": "Manual of Authorities and Duties",
  "what-we-believe": "Position Statements and Other Resources"
};

export const QUESTION_INTENTS = {
  doctrine: "doctrine",
  procedure: "procedure",
  government: "government",
  worship: "worship",
  mixed: "mixed",
  general: "general"
};

const DOCUMENT_PRIORITY_INDEX = new Map(
  DOCUMENT_PRIORITY.map((documentId, index) => [documentId, index])
);

const STOPWORDS = new Set([
  "what",
  "are",
  "is",
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "for",
  "on",
  "and",
  "or",
  "do",
  "does",
  "did",
  "can",
  "could",
  "should",
  "would",
  "will",
  "have",
  "about",
  "we",
  "they",
  "it",
  "be"
]);

const GENERIC_INTENT_TERMS = new Set([
  "how",
  "what",
  "when",
  "where",
  "why",
  "who",
  "which",
  "file",
  "filed",
  "submit",
  "submitted",
  "process",
  "procedure"
]);

export function searchDocuments(question, chunks, selectedCategory = "all", classification = null) {
  const candidateChunks =
    selectedCategory === "all"
      ? chunks
      : chunks.filter((chunk) => chunk.category === selectedCategory);

  const resolvedClassification = classification ?? classifyQuestion(question);
  const queryProfile = buildQueryProfile(question, resolvedClassification);
  const ranked = candidateChunks
    .map((chunk) => ({
      ...chunk,
      score: scoreChunk(queryProfile, chunk),
      directRelevance: directRelevanceScore(queryProfile, chunk)
    }))
    .filter((chunk) => chunk.score > 0)
    .sort((left, right) => {
      if (right.directRelevance !== left.directRelevance) {
        return right.directRelevance - left.directRelevance;
      }

      return right.score - left.score;
    });

  const groupedByDocument = groupByDocument(ranked);
  const governing = collectPrimaryEvidence(groupedByDocument, queryProfile);
  const supplemental = collectSupplementalEvidence(groupedByDocument, governing);

  return {
    classification: resolvedClassification,
    queryProfile,
    ranked,
    governing,
    supplemental
  };
}

export function classifyQuestion(question, overrideType = "auto") {
  const manual = buildManualClassification(overrideType);
  if (manual) {
    return manual;
  }

  const lowered = question.toLowerCase();
  const matched = [];
  const doctrinalDefinitionTerms = [
    "sin",
    "justification",
    "sanctification",
    "adoption",
    "repentance",
    "faith",
    "saving faith",
    "sacrament",
    "baptism",
    "lord's supper",
    "prayer",
    "providence",
    "creation",
    "decree",
    "decrees",
    "covenant",
    "mediator",
    "church",
    "communion",
    "resurrection",
    "glorification"
  ];
  const looksLikeDefinitionQuestion =
    lowered.startsWith("what is ") ||
    lowered.startsWith("what are ") ||
    lowered.startsWith("who is ") ||
    lowered.startsWith("who are ");
  const isDoctrinalDefinition =
    looksLikeDefinitionQuestion &&
    doctrinalDefinitionTerms.some((term) => lowered.includes(term));

  const isWorship =
    lowered.includes("worship") ||
    lowered.includes("lord's supper") ||
    lowered.includes("sacrament") ||
    lowered.includes("baptism") ||
    lowered.includes("public worship") ||
    lowered.includes("private worship");
  if (isWorship) {
    matched.push(QUESTION_INTENTS.worship);
  }

  const isProcedure =
    lowered.includes("how do i") ||
    lowered.includes("how can i") ||
    lowered.includes("how to") ||
    lowered.includes("submit") ||
    lowered.includes("file") ||
    lowered.includes("appeal") ||
    lowered.includes("complaint") ||
    lowered.includes("charge") ||
    lowered.includes("trial") ||
    lowered.includes("discipline") ||
    lowered.includes("censure") ||
    lowered.includes("procedure") ||
    lowered.includes("process");
  if (isProcedure) {
    matched.push(QUESTION_INTENTS.procedure);
  }

  const isGovernment =
    lowered.includes("session") ||
    lowered.includes("presbytery") ||
    lowered.includes("synod") ||
    lowered.includes("elder") ||
    lowered.includes("deacon") ||
    lowered.includes("officer") ||
    lowered.includes("church government") ||
    lowered.includes("court") ||
    lowered.includes("courts");
  if (isGovernment) {
    matched.push(QUESTION_INTENTS.government);
  }

  const isDoctrine =
    isDoctrinalDefinition ||
    lowered.includes("believe") ||
    lowered.includes("doctrine") ||
    lowered.includes("confession") ||
    lowered.includes("catechism") ||
    lowered.includes("jesus") ||
    lowered.includes("christ") ||
    lowered.includes("god") ||
    lowered.includes("salvation") ||
    lowered.includes("justify") ||
    lowered.includes("justification") ||
    lowered.includes("redemption") ||
    lowered.includes("redeem") ||
    lowered.includes("atonement") ||
    lowered.includes("cross") ||
    lowered.includes("death") ||
    lowered.includes("die") ||
    lowered.includes("judge") ||
    lowered.includes("judgment") ||
    lowered.includes("magistrate") ||
    (lowered.includes("civil") && lowered.includes("government"));
  if (isDoctrine) {
    matched.push(QUESTION_INTENTS.doctrine);
  }

  const deduped = Array.from(new Set(matched));
  const primaryIntent =
    deduped.length === 0
      ? QUESTION_INTENTS.general
      : deduped.length === 1
        ? deduped[0]
        : deduped[0] === QUESTION_INTENTS.procedure && deduped.includes(QUESTION_INTENTS.government)
          ? QUESTION_INTENTS.procedure
          : deduped[0] === QUESTION_INTENTS.worship && deduped.includes(QUESTION_INTENTS.doctrine)
            ? QUESTION_INTENTS.worship
            : deduped[0] === QUESTION_INTENTS.doctrine && deduped.includes(QUESTION_INTENTS.government)
              ? QUESTION_INTENTS.doctrine
              : QUESTION_INTENTS.mixed;

  const suggestedDocuments = suggestDocumentsForIntent(primaryIntent, deduped);
  const confidence =
    primaryIntent === QUESTION_INTENTS.general ? 0.35 : primaryIntent === QUESTION_INTENTS.mixed ? 0.6 : 0.85;

  return {
    primaryIntent,
    secondaryIntents: deduped.filter((intent) => intent !== primaryIntent),
    matchedIntents: deduped,
    confidence,
    suggestedDocuments
  };
}

export function buildQueryProfile(question, classification = classifyQuestion(question)) {
  const lowered = question.toLowerCase();
  const terms = new Set(tokenize(question));
  for (const term of Array.from(terms)) {
    for (const variant of expandTermVariants(term)) {
      terms.add(variant);
    }
  }
  const priorityDocuments = new Set();
  const priorityCategories = new Set();

  const civilGovernmentQuestion =
    (lowered.includes("civil") && lowered.includes("government")) ||
    lowered.includes("magistrate");
  const worshipQuestion = lowered.includes("worship");
  const emphasizeDoctrine =
    lowered.includes("what do we believe") ||
    lowered.includes("believe") ||
    lowered.includes("doctrine") ||
    lowered.includes("confession");
  const atonementQuestion =
    (lowered.includes("jesus") || lowered.includes("christ")) &&
    (lowered.includes("die") ||
      lowered.includes("death") ||
      lowered.includes("cross") ||
      lowered.includes("sacrifice") ||
      lowered.includes("atonement") ||
      lowered.includes("redeem") ||
      lowered.includes("redemption") ||
      lowered.includes("satisfaction"));
  const judgmentQuestion =
    lowered.includes("judge") ||
    lowered.includes("judgment") ||
    lowered.includes("judgement");
  const disciplineQuestion =
    lowered.includes("discipline") ||
    lowered.includes("censure") ||
    lowered.includes("charge") ||
    lowered.includes("trial");
  const complaintQuestion =
    lowered.includes("complaint") ||
    lowered.includes("complaints") ||
    lowered.includes("appeal") ||
    lowered.includes("appeals");
  const processQuestion =
    lowered.includes("how can i") ||
    lowered.includes("how do i") ||
    lowered.includes("how do we") ||
    lowered.includes("how to") ||
    lowered.includes("submit") ||
    lowered.includes("file") ||
    lowered.includes("process") ||
    lowered.includes("procedure");
  const officeEligibilityQuestion =
    (lowered.includes("deacon") ||
      lowered.includes("deacons") ||
      lowered.includes("elder") ||
      lowered.includes("elders") ||
      lowered.includes("officer") ||
      lowered.includes("officers")) &&
    (lowered.startsWith("who can") ||
      lowered.startsWith("who may") ||
      lowered.includes("can be") ||
      lowered.includes("may be") ||
      lowered.includes("eligible") ||
      lowered.includes("eligibility") ||
      lowered.includes("qualifications") ||
      lowered.includes("qualified"));
  const officeDutiesQuestion =
    (lowered.includes("deacon") ||
      lowered.includes("deacons") ||
      lowered.includes("elder") ||
      lowered.includes("elders") ||
      lowered.includes("minister") ||
      lowered.includes("ministers") ||
      lowered.includes("officer") ||
      lowered.includes("officers")) &&
    (lowered.startsWith("what do") ||
      lowered.startsWith("what does") ||
      lowered.includes("duties") ||
      lowered.includes("responsibilities") ||
      lowered.includes("role") ||
      lowered.includes("roles") ||
      lowered.includes("purpose") ||
      lowered.includes("function") ||
      lowered.includes("functions"));
  const definitionQuestion =
    lowered.startsWith("what is ") ||
    lowered.startsWith("what are ") ||
    lowered.startsWith("who is ") ||
    lowered.startsWith("who are ");
  const definitionTarget = extractDefinitionTarget(lowered);
  const officeFocus =
    lowered.includes("deacon") || lowered.includes("deacons")
      ? "deacon"
      : lowered.includes("elder") || lowered.includes("elders")
        ? "elder"
        : lowered.includes("minister") || lowered.includes("ministers") || lowered.includes("pastor") || lowered.includes("pastors")
          ? "minister"
          : "";

  applyIntentHints(classification, priorityDocuments, priorityCategories, terms);

  if (civilGovernmentQuestion) {
    ["magistrate", "magistrates", "civil", "government", "authority", "authorities"].forEach((term) =>
      terms.add(term)
    );
    priorityDocuments.add("confession-of-faith");
    priorityCategories.add("doctrinal-standards");
  }

  if (worshipQuestion) {
    ["worship", "directory", "public", "church"].forEach((term) => terms.add(term));
    priorityDocuments.add("directory-of-public-worship");
    priorityDocuments.add("confession-of-faith");
    priorityCategories.add("worship-and-authorities");
  }

  if (lowered.includes("church government") || lowered.includes("session") || lowered.includes("presbytery")) {
    ["government", "church", "session", "presbytery", "synod"].forEach((term) => terms.add(term));
    priorityDocuments.add("form-of-government");
    priorityCategories.add("church-government");
  }

  if (officeEligibilityQuestion) {
    [
      "eligible",
      "eligibility",
      "qualifications",
      "qualified",
      "office",
      "offices",
      "ordination",
      "installation",
      "member",
      "members",
      "full",
      "active",
      "communion"
    ].forEach((term) => terms.add(term));
    priorityDocuments.add("form-of-government");
    priorityCategories.add("church-government");
  }

  if (officeDutiesQuestion) {
    [
      "duties",
      "responsibilities",
      "responsibility",
      "purpose",
      "role",
      "service",
      "serve",
      "ministry",
      "oversight",
      "mercy",
      "stewardship",
      "property"
    ].forEach((term) => terms.add(term));
    priorityDocuments.add("form-of-government");
    priorityCategories.add("church-government");
  }

  if (disciplineQuestion) {
    ["discipline", "charges", "charge", "trial", "censure", "offense"].forEach((term) =>
      terms.add(term)
    );
    priorityDocuments.add("book-of-discipline");
    priorityDocuments.add("form-of-government");
    priorityCategories.add("discipline");
  }

  if (complaintQuestion) {
    [
      "complaint",
      "complaints",
      "complainant",
      "appeal",
      "appeals",
      "file",
      "filed",
      "submit",
      "submitted",
      "written",
      "clerk",
      "lower",
      "higher",
      "court",
      "courts"
    ].forEach((term) => terms.add(term));
    priorityDocuments.add("book-of-discipline");
    priorityDocuments.add("form-of-government");
    priorityCategories.add("discipline");
    priorityCategories.add("church-government");
  }

  if (emphasizeDoctrine) {
    ["confession", "catechism", "chapter"].forEach((term) => terms.add(term));
    priorityDocuments.add("confession-of-faith");
    priorityDocuments.add("larger-catechism");
    priorityDocuments.add("shorter-catechism");
    priorityCategories.add("doctrinal-standards");
  }

  if (atonementQuestion) {
    [
      "jesus",
      "christ",
      "die",
      "death",
      "cross",
      "sacrifice",
      "obedience",
      "satisfaction",
      "redemption",
      "redeem",
      "mediator",
      "justify",
      "justification"
    ].forEach((term) => terms.add(term));
    priorityDocuments.add("confession-of-faith");
    priorityDocuments.add("larger-catechism");
    priorityDocuments.add("shorter-catechism");
    priorityCategories.add("doctrinal-standards");
  }

  if (judgmentQuestion) {
    ["judge", "judgment", "judgement", "world", "last"].forEach((term) => terms.add(term));
    priorityDocuments.add("confession-of-faith");
    priorityDocuments.add("larger-catechism");
    priorityDocuments.add("shorter-catechism");
    priorityCategories.add("doctrinal-standards");
  }

  return {
    terms: Array.from(terms),
    priorityDocuments,
    priorityCategories,
    civilGovernmentQuestion,
    worshipQuestion,
    emphasizeDoctrine,
    atonementQuestion,
    judgmentQuestion,
    disciplineQuestion,
    complaintQuestion,
    processQuestion,
    officeEligibilityQuestion,
    officeDutiesQuestion,
    officeFocus,
    definitionQuestion,
    definitionTarget
  };
}

export function buildLocalAnswer(question, governingResults, queryProfile) {
  const primary = governingResults[0];
  const snippets = governingResults.map((result) => extractSnippet(result.text, question));
  const distinctSnippets = Array.from(new Set(snippets)).slice(0, 3);
  const framed = distinctSnippets.map((snippet) => normalizeSentence(snippet)).filter(Boolean);

  if (queryProfile.civilGovernmentQuestion) {
    const lead = framed[0] ?? "The governing documents distinguish civil authority from the church's own spiritual authority.";
    return `After reviewing the governing documents in priority order, the strongest answer comes first from the ${primary.title}. ${lead}`;
  }

  if (queryProfile.disciplineQuestion) {
    const lead = framed[0] ?? "The governing documents answer this first in the disciplinary standards and related government rules.";
    return `After reviewing the governing documents in priority order, the answer is grounded first in the ${primary.title}. ${lead}`;
  }

  if (queryProfile.complaintQuestion) {
    const lead = framed[0] ?? "The governing documents answer this in the Book of Discipline and related court procedures.";
    return `After reviewing the governing documents in priority order, the answer is grounded first in the ${primary.title}. ${lead}`;
  }

  if (queryProfile.worshipQuestion) {
    const lead = framed[0] ?? "The answer is governed primarily by the worship directories and any higher-priority doctrinal standards that bear on the issue.";
    return `After reviewing the governing documents in priority order, the answer is grounded first in the ${primary.title}. ${lead}`;
  }

  const lead = framed[0] ?? extractSnippet(primary.text, question);
  const support = framed[1] ? ` ${framed[1]}` : "";
  return `After reviewing the governing documents in priority order, the best answer is drawn first from the ${primary.title}. ${lead}${support}`;
}

export function buildPriorityReview(governingResults) {
  return Array.from(
    new Set(governingResults.map((result) => DOCUMENT_LABELS[result.documentId] ?? result.title))
  );
}

export function extractSnippet(text, question) {
  return extractSnippetDetails(text, question).text;
}

export function extractSnippetDetails(text, question) {
  const split = splitBodyAndReferenceText(text);
  const bodyText = split.bodyText;
  const sentences = bodyText.match(/[^.!?]+[.!?]?/g) ?? [bodyText];
  const queryProfile = buildQueryProfile(question);
  const queryTerms = queryProfile.terms;
  const ranked = sentences
    .map((sentence, index) => ({
      index,
      rawSentence: sentence.trim(),
      sentence: cleanSnippetSentence(sentence),
      score:
        queryTerms.reduce(
        (total, term) => total + (sentence.toLowerCase().includes(term) ? 1 : 0),
        0
      ) + definitionSentenceBoost(queryProfile, sentence)
    }))
    .filter((item) => item.sentence.length > 35)
    .filter((item) => !looksLikeHeading(item.sentence))
    .sort((left, right) => right.score - left.score);

  const topMatch = ranked[0] ?? null;
  const rawSnippetSource = topMatch?.rawSentence ?? bodyText;
  const snippetSource = cleanSnippetSentence(rawSnippetSource);
  const referenceMap = extractReferenceMap(split.referenceText);
  const usedReferenceKeys = detectInlineReferenceKeys(
    rawSnippetSource,
    topMatch ? sentences[topMatch.index + 1] ?? "" : ""
  ).filter((key) => referenceMap[key]);

  let cleaned = snippetSource;
  for (const key of usedReferenceKeys) {
    cleaned = cleaned
      .replace(new RegExp(`^${key}\\s+(?=[A-Z])`, "i"), "")
      .replace(new RegExp(`([,;:.!?])${key}(?=\\s+[A-Za-z]|$)`, "gi"), "$1");
  }

  cleaned = cleaned
    .replace(/\s+/g, " ")
    .replace(/\s+([,;:.!?])/g, "$1")
    .trim();

  const truncated = cleaned.length > 420;
  const textOut = truncated ? `${cleaned.slice(0, 417).trimEnd()}...` : cleaned;
  const references = usedReferenceKeys
    .map((key) => referenceMap[key])
    .filter(Boolean);

  return {
    text: textOut,
    references
  };
}

export function humanizeCategory(category) {
  const labels = {
    all: "all sources",
    "doctrinal-standards": "doctrinal standards",
    "church-government": "church government",
    discipline: "discipline",
    "worship-and-authorities": "worship and authorities",
    "belief-context": "belief context page"
  };

  return labels[category] ?? category;
}

export function sourceDescriptor(result) {
  const typeLabel = result.sourceType === "pdf" ? "Governing document" : "Supplemental context";
  return `${typeLabel} | ${humanizeCategory(result.category)}`;
}

export function tokenize(text) {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((token) => token.length >= 2)
        .filter((token) => !STOPWORDS.has(token))
    )
  );
}

function scoreChunk(queryProfile, chunk) {
  if (!queryProfile.terms.length) {
    return 0;
  }

  if (isNonSubstantiveChunk(chunk)) {
    return 0;
  }

  let score = 0;
  let lexicalHits = 0;
  for (const term of queryProfile.terms) {
    if (chunk.terms.includes(term)) {
      score += 6;
      lexicalHits += 1;
    }

    if (chunk.title.toLowerCase().includes(term)) {
      score += 4;
      lexicalHits += 1;
    }

    if ((chunk.section ?? "").toLowerCase().includes(term)) {
      score += 3;
      lexicalHits += 1;
    }

    if (chunk.text.toLowerCase().includes(term)) {
      score += 1;
      lexicalHits += 1;
    }
  }

  if (lexicalHits === 0) {
    return 0;
  }

  if (chunk.sourceType === "pdf") {
    score += 30;
  } else {
    score -= 12;
  }

  if (queryProfile.priorityDocuments.has(chunk.documentId)) {
    score += 18;
  }

  if (queryProfile.priorityCategories.has(chunk.category)) {
    score += 10;
  }

  const priorityIndex = DOCUMENT_PRIORITY_INDEX.get(chunk.documentId);
  if (priorityIndex !== undefined) {
    score += Math.max(0, 18 - priorityIndex * 2);
  }

  if (chunk.title === "Confession of Faith" && queryProfile.emphasizeDoctrine) {
    score += 14;
  }

  if (queryProfile.complaintQuestion) {
    if (chunk.documentId === "book-of-discipline") {
      score += 34;
    }

    if (chunk.documentId === "form-of-government") {
      score += 18;
    }

    if (/appeals?\s+and\s+complaints?/i.test(chunk.section ?? "")) {
      score += 40;
    }

    if (/complaint|complainant|higher court|lower court|clerk|within 30 days|within 45 days|written/i.test(chunk.text)) {
      score += 18;
    }

    if (queryProfile.processQuestion && /file|submit|written|clerk|within \d+ days/i.test(chunk.text)) {
      score += 18;
    }

    if (
      ["confession-of-faith", "larger-catechism", "shorter-catechism"].includes(chunk.documentId) &&
      !/complaint|complainant|file|submit|clerk|higher court|lower court|written/i.test(
        `${chunk.section ?? ""} ${chunk.text}`
      )
    ) {
      score -= 24;
    }
  }

  if (chunk.section && /civil magistrate/i.test(chunk.section) && queryProfile.civilGovernmentQuestion) {
    score += 40;
  }

  if (/civil magistrate/i.test(chunk.text) && queryProfile.civilGovernmentQuestion) {
    score += 18;
  }

  if (/worship/i.test(chunk.text) && queryProfile.worshipQuestion && chunk.sourceType === "pdf") {
    score += 8;
  }

  if (queryProfile.definitionQuestion && queryProfile.definitionTarget) {
    const targetPattern = escapeRegExp(queryProfile.definitionTarget);
    if (new RegExp(`what\\s+is\\s+${targetPattern}\\??`, "i").test(chunk.text)) {
      score += 50;
    }

    if (new RegExp(`\\b${targetPattern}\\s+is\\b`, "i").test(chunk.text)) {
      score += 45;
    }

    if (new RegExp(`\\b${targetPattern}\\b`, "i").test(chunk.text)) {
      score += 10;
    }

    if (["larger-catechism", "shorter-catechism"].includes(chunk.documentId)) {
      score += 20;
    }
  }

  if (queryProfile.officeEligibilityQuestion) {
    if (chunk.documentId === "form-of-government") {
      score += 24;
    }

    if (/deacons?\s+and\s+the\s+diaconate|elders?\s+and\s+the\s+session|election,\s+ordination\s+and\s+installation/i.test(chunk.section ?? "")) {
      score += 24;
    }

    if (/description and qualifications of a deacon|qualifications of an elder|eligibility/i.test(`${chunk.section ?? ""} ${chunk.text}`)) {
      score += 36;
    }

    if (/member in good standing|full and active communion|not be under any current or pending discipline|minimum age|recent converts|women can serve as deacons|male members/i.test(chunk.text)) {
      score += 28;
    }

    if (queryProfile.officeFocus === "deacon") {
      if (/deacon|diaconate/i.test(`${chunk.section ?? ""} ${chunk.text}`)) {
        score += 18;
      }

      if (/elder|minister|pastor/i.test(`${chunk.section ?? ""}`) && !/deacon|diaconate/i.test(`${chunk.section ?? ""}`)) {
        score -= 18;
      }
    }
  }

  if (queryProfile.officeDutiesQuestion) {
    if (chunk.documentId === "form-of-government") {
      score += 22;
    }

    if (/purpose of the diaconate|responsibilities|duties|relationship to the session|the elder and the session/i.test(chunk.section ?? "")) {
      score += 30;
    }

    if (/mercy ministry|stewardship|offerings|care of the general property|service after the example of christ|visit|pray|oversight|shepherd/i.test(chunk.text)) {
      score += 28;
    }

    if (queryProfile.officeFocus === "deacon") {
      if (/deacon|diaconate/i.test(`${chunk.section ?? ""} ${chunk.text}`)) {
        score += 22;
      }

      if (/minister|pastor|elder|session/i.test(`${chunk.section ?? ""}`) && !/deacon|diaconate/i.test(`${chunk.section ?? ""}`)) {
        score -= 18;
      }
    }
  }

  if (queryProfile.atonementQuestion) {
    if (chunk.category === "doctrinal-standards") {
      score += 20;
    }

    if (["confession-of-faith", "larger-catechism", "shorter-catechism"].includes(chunk.documentId)) {
      score += 18;
    }

    if (/christ the mediator|justification/i.test(chunk.section ?? "")) {
      score += 30;
    }

    if (/obedience and death|sacrifice of himself|satisfied the justice|redemption|redeemed by christ|mediator/i.test(chunk.text)) {
      score += 24;
    }

    if (
      !["confession-of-faith", "larger-catechism", "shorter-catechism"].includes(chunk.documentId) &&
      !/death|cross|sacrifice|satisfaction|redemption|redeem|mediator|justify|justification/i.test(
        `${chunk.section ?? ""} ${chunk.text}`
      )
    ) {
      score -= 20;
    }
  }

  return score;
}

function directRelevanceScore(queryProfile, chunk) {
  if (isNonSubstantiveChunk(chunk)) {
    return 0;
  }

  const analysis = analyzeChunk(queryProfile, chunk);
  let score = 0;

  if (analysis.sectionMeaningfulHits > 0) {
    score += 4;
  }

  if (analysis.titleMeaningfulHits > 0) {
    score += 3;
  }

  if (analysis.totalMeaningfulHits >= 2) {
    score += 3;
  } else if (analysis.totalMeaningfulHits === 1) {
    score += 1;
  }

  if (analysis.textMeaningfulHits >= 4) {
    score += 3;
  } else if (analysis.textMeaningfulHits >= 3) {
    score += 2;
  } else if (analysis.textMeaningfulHits >= 2) {
    score += 1;
  }

  if (queryProfile.complaintQuestion) {
    if (/appeals?\s+and\s+complaints?/i.test(chunk.section ?? "")) {
      score += 8;
    }

    if (/complaint|complainant|appeal/i.test(chunk.text) && /written|file|submit|clerk|days?|higher court|lower court/i.test(chunk.text)) {
      score += 8;
    }
  }

  if (queryProfile.civilGovernmentQuestion) {
    if (/civil magistrate/i.test(`${chunk.section ?? ""} ${chunk.text}`)) {
      score += 8;
    }
  }

  if (queryProfile.worshipQuestion) {
    if (/worship/i.test(`${chunk.section ?? ""} ${chunk.text}`)) {
      score += 6;
    }
  }

  if (queryProfile.disciplineQuestion) {
    if (/discipline|censure|trial|charge|charges|offense/i.test(`${chunk.section ?? ""} ${chunk.text}`)) {
      score += 6;
    }
  }

  if (queryProfile.judgmentQuestion) {
    if (/last judgment/i.test(`${chunk.section ?? ""} ${chunk.text}`)) {
      score += 24;
    }
  }

  if (queryProfile.definitionQuestion && queryProfile.definitionTarget) {
    const targetPattern = escapeRegExp(queryProfile.definitionTarget);
    if (new RegExp(`what\\s+is\\s+${targetPattern}\\??`, "i").test(chunk.text)) {
      score += 20;
    }

    if (new RegExp(`\\b${targetPattern}\\s+is\\b`, "i").test(`${chunk.section ?? ""} ${chunk.text}`)) {
      score += 18;
    }

    if (["larger-catechism", "shorter-catechism"].includes(chunk.documentId)) {
      score += 8;
    }
  }

  if (queryProfile.officeEligibilityQuestion) {
    if (/description and qualifications of a deacon|qualifications of an elder|eligibility/i.test(`${chunk.section ?? ""} ${chunk.text}`)) {
      score += 16;
    }

    if (/member in good standing|full and active communion|pending discipline|minimum age|recent converts|women can serve as deacons|male members/i.test(chunk.text)) {
      score += 12;
    }

    if (queryProfile.officeFocus === "deacon") {
      if (/deacon|diaconate/i.test(`${chunk.section ?? ""} ${chunk.text}`)) {
        score += 10;
      }

      if (/elder|minister|pastor/i.test(`${chunk.section ?? ""}`) && !/deacon|diaconate/i.test(`${chunk.section ?? ""}`)) {
        score -= 8;
      }
    }
  }

  if (queryProfile.officeDutiesQuestion) {
    if (/purpose of the diaconate|responsibilities|duties|relationship to the session|the elder and the session/i.test(`${chunk.section ?? ""}`)) {
      score += 16;
    }

    if (/mercy ministry|stewardship|offerings|care of the general property|service after the example of christ|visit|pray|oversight|shepherd/i.test(chunk.text)) {
      score += 12;
    }

    if (queryProfile.officeFocus === "deacon") {
      if (/deacon|diaconate/i.test(`${chunk.section ?? ""} ${chunk.text}`)) {
        score += 10;
      }

      if (/minister|pastor|elder|session/i.test(`${chunk.section ?? ""}`) && !/deacon|diaconate/i.test(`${chunk.section ?? ""}`)) {
        score -= 8;
      }
    }
  }

  if (queryProfile.atonementQuestion) {
    if (/christ the mediator|justification/i.test(`${chunk.section ?? ""}`)) {
      score += 12;
    }

    if (/death|cross|sacrifice|satisfaction|redemption|redeem|mediator|justify|justification/i.test(`${chunk.section ?? ""} ${chunk.text}`)) {
      score += 10;
    }
  }

  return score;
}

function groupByDocument(ranked) {
  const grouped = new Map();
  for (const chunk of ranked) {
    const items = grouped.get(chunk.documentId) ?? [];
    items.push(chunk);
    grouped.set(chunk.documentId, items);
  }
  return grouped;
}

function collectPrimaryEvidence(groupedByDocument, queryProfile) {
  const evidence = [];
  const strongestScore = Math.max(
    0,
    ...Array.from(groupedByDocument.values())
      .map((items) => items[0]?.score ?? 0)
      .filter(Boolean)
  );
  const strongestDirect = Math.max(
    0,
    ...Array.from(groupedByDocument.values())
      .map((items) => items[0]?.directRelevance ?? 0)
      .filter(Boolean)
  );
  const competitiveFloor = queryProfile.complaintQuestion
    ? Math.max(45, strongestScore - 60)
    : Math.max(35, strongestScore - 28);
  const directCompetitiveFloor = dynamicDirectFloor(queryProfile, strongestDirect);

  for (const documentId of DOCUMENT_PRIORITY) {
    if (documentId === "what-we-believe") {
      continue;
    }

    const matches = (groupedByDocument.get(documentId) ?? [])
      .filter((chunk) => chunk.sourceType === "pdf")
      .filter((chunk) => chunk.score >= 35)
      .filter((chunk) =>
        chunk.directRelevance >= Math.max(directRelevanceFloor(queryProfile, documentId), directCompetitiveFloor)
      )
      .filter((chunk) =>
        queryProfile.complaintQuestion && documentId === "book-of-discipline"
          ? true
          : chunk.score >= competitiveFloor || chunk.score === strongestScore
      );

    if (!matches.length) {
      continue;
    }

    evidence.push(...matches.slice(0, maxChunksPerDocument(documentId, queryProfile)));
  }

  return evidence.slice(0, maxEvidenceCount(queryProfile));
}

function collectSupplementalEvidence(groupedByDocument, governing) {
  if (!governing.length) {
    return [];
  }

  const baseline = governing[0].score;
  return (groupedByDocument.get("what-we-believe") ?? [])
    .filter((chunk) => chunk.score >= Math.max(25, baseline * 0.35))
    .slice(0, 2);
}

function normalizeSentence(text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  return normalized.endsWith(".") || normalized.endsWith("?") || normalized.endsWith("!")
    ? normalized
    : `${normalized}.`;
}

function maxChunksPerDocument(documentId, queryProfile) {
  if (queryProfile.officeDutiesQuestion && documentId === "form-of-government") {
    return 3;
  }

  if (queryProfile.officeEligibilityQuestion && documentId === "form-of-government") {
    return 3;
  }

  if (queryProfile.complaintQuestion) {
    if (documentId === "book-of-discipline") {
      return 4;
    }

    if (documentId === "form-of-government") {
      return 2;
    }
  }

  if (queryProfile.disciplineQuestion) {
    if (documentId === "book-of-discipline") {
      return 3;
    }

    if (documentId === "form-of-government") {
      return 2;
    }
  }

  if (queryProfile.worshipQuestion) {
    if (
      documentId === "directory-of-public-worship" ||
      documentId === "directory-of-private-and-family-worship"
    ) {
      return 3;
    }
  }

  if (queryProfile.emphasizeDoctrine) {
    if (
      documentId === "confession-of-faith" ||
      documentId === "larger-catechism" ||
      documentId === "shorter-catechism"
    ) {
      return 2;
    }
  }

  if (queryProfile.atonementQuestion) {
    if (
      documentId === "confession-of-faith" ||
      documentId === "larger-catechism" ||
      documentId === "shorter-catechism"
    ) {
      return 3;
    }
  }

  return 1;
}

function maxEvidenceCount(queryProfile) {
  if (queryProfile.officeDutiesQuestion) {
    return 6;
  }

  if (queryProfile.officeEligibilityQuestion) {
    return 6;
  }

  if (queryProfile.complaintQuestion || queryProfile.disciplineQuestion) {
    return 8;
  }

  if (queryProfile.worshipQuestion || queryProfile.emphasizeDoctrine || queryProfile.atonementQuestion) {
    return 7;
  }

  return 6;
}

function directRelevanceFloor(queryProfile, documentId) {
  if (queryProfile.officeDutiesQuestion && documentId === "form-of-government") {
    return 6;
  }

  if (queryProfile.officeEligibilityQuestion && documentId === "form-of-government") {
    return 6;
  }

  if (queryProfile.complaintQuestion && documentId === "book-of-discipline") {
    return 6;
  }

  if (queryProfile.complaintQuestion || queryProfile.disciplineQuestion) {
    return 5;
  }

  if (queryProfile.civilGovernmentQuestion || queryProfile.worshipQuestion) {
    return 4;
  }

  if (queryProfile.atonementQuestion) {
    if (
      documentId === "confession-of-faith" ||
      documentId === "larger-catechism" ||
      documentId === "shorter-catechism"
    ) {
      return 8;
    }

    return 6;
  }

  return 3;
}

function dynamicDirectFloor(queryProfile, strongestDirect) {
  if (queryProfile.complaintQuestion) {
    return Math.max(5, strongestDirect - 12);
  }

  if (queryProfile.civilGovernmentQuestion || queryProfile.worshipQuestion) {
    return Math.max(4, strongestDirect - 1);
  }

  if (queryProfile.atonementQuestion || queryProfile.judgmentQuestion || queryProfile.disciplineQuestion || queryProfile.emphasizeDoctrine) {
    return Math.max(4, strongestDirect - 1);
  }

  return Math.max(4, strongestDirect - 1);
}

function suggestDocumentsForIntent(primaryIntent, intents) {
  if (primaryIntent === QUESTION_INTENTS.procedure) {
    return ["book-of-discipline", "form-of-government"];
  }

  if (primaryIntent === QUESTION_INTENTS.government) {
    return ["form-of-government", "book-of-discipline", "manual-of-authorities-and-duties"];
  }

  if (primaryIntent === QUESTION_INTENTS.worship) {
    return ["directory-of-public-worship", "directory-of-private-and-family-worship", "confession-of-faith"];
  }

  if (primaryIntent === QUESTION_INTENTS.doctrine) {
    return ["confession-of-faith", "larger-catechism", "shorter-catechism"];
  }

  if (primaryIntent === QUESTION_INTENTS.mixed) {
    const suggestions = new Set();
    for (const intent of intents) {
      for (const documentId of suggestDocumentsForIntent(intent, [])) {
        suggestions.add(documentId);
      }
    }
    return Array.from(suggestions);
  }

  return [];
}

function buildManualClassification(overrideType) {
  const normalized = `${overrideType ?? "auto"}`.trim().toLowerCase();
  if (!normalized || normalized === "auto") {
    return null;
  }

  if (!Object.values(QUESTION_INTENTS).includes(normalized) || normalized === QUESTION_INTENTS.general) {
    return null;
  }

  const suggestedDocuments = suggestDocumentsForIntent(normalized, [normalized]);
  return {
    primaryIntent: normalized,
    secondaryIntents: [],
    matchedIntents: [normalized],
    confidence: 1,
    suggestedDocuments,
    manualOverride: true
  };
}

function applyIntentHints(classification, priorityDocuments, priorityCategories, terms) {
  const documents = classification?.suggestedDocuments ?? [];
  for (const documentId of documents) {
    priorityDocuments.add(documentId);
  }

  switch (classification?.primaryIntent) {
    case QUESTION_INTENTS.doctrine:
      priorityCategories.add("doctrinal-standards");
      ["confession", "catechism", "doctrine"].forEach((term) => terms.add(term));
      break;
    case QUESTION_INTENTS.procedure:
      priorityCategories.add("discipline");
      ["process", "procedure", "file", "submit", "written", "clerk"].forEach((term) => terms.add(term));
      break;
    case QUESTION_INTENTS.government:
      priorityCategories.add("church-government");
      ["government", "session", "presbytery", "synod", "elder", "deacon"].forEach((term) => terms.add(term));
      break;
    case QUESTION_INTENTS.worship:
      priorityCategories.add("worship-and-authorities");
      ["worship", "public", "private", "family", "directory"].forEach((term) => terms.add(term));
      break;
    case QUESTION_INTENTS.mixed:
      for (const intent of classification.secondaryIntents ?? []) {
        applyIntentHints({ primaryIntent: intent, suggestedDocuments: suggestDocumentsForIntent(intent, []) }, priorityDocuments, priorityCategories, terms);
      }
      break;
    default:
      break;
  }
}

function definitionSentenceBoost(queryProfile, sentence) {
  if (!queryProfile.definitionQuestion || !queryProfile.definitionTarget) {
    return 0;
  }

  const lowered = sentence.toLowerCase();
  const targetPattern = escapeRegExp(queryProfile.definitionTarget);

  if (new RegExp(`what\\s+is\\s+${targetPattern}\\??`, "i").test(lowered)) {
    return 20;
  }

  if (new RegExp(`\\b${targetPattern}\\s+is\\b`, "i").test(lowered)) {
    return 18;
  }

  if (new RegExp(`a\\.\\s*${targetPattern}\\s+is\\b`, "i").test(lowered)) {
    return 22;
  }

  return 0;
}

function extractDefinitionTarget(loweredQuestion) {
  const match = loweredQuestion.match(/^(?:what|who)\s+(?:is|are)\s+(.+?)(?:\?|$)/i);
  if (!match) {
    return "";
  }

  return match[1]
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function analyzeChunk(queryProfile, chunk) {
  const titleText = (chunk.title ?? "").toLowerCase();
  const sectionText = (chunk.section ?? "").toLowerCase();
  const bodyText = (chunk.text ?? "").toLowerCase();
  const meaningfulTerms = queryProfile.terms.filter((term) => !GENERIC_INTENT_TERMS.has(term));

  let titleMeaningfulHits = 0;
  let sectionMeaningfulHits = 0;
  let textMeaningfulHits = 0;

  for (const term of meaningfulTerms) {
    if (titleText.includes(term)) {
      titleMeaningfulHits += 1;
    }

    if (sectionText.includes(term)) {
      sectionMeaningfulHits += 1;
    }

    if (bodyText.includes(term)) {
      textMeaningfulHits += 1;
    }
  }

  return {
    titleMeaningfulHits,
    sectionMeaningfulHits,
    textMeaningfulHits,
    totalMeaningfulHits: new Set(
      meaningfulTerms.filter(
        (term) => titleText.includes(term) || sectionText.includes(term) || bodyText.includes(term)
      )
    ).size
  };
}

function expandTermVariants(term) {
  const variants = new Set();
  if (term.endsWith("s") && term.length > 4) {
    variants.add(term.slice(0, -1));
  }

  if (term.endsWith("es") && term.length > 5) {
    variants.add(term.slice(0, -2));
  }

  if (!term.endsWith("s") && term.length > 3) {
    variants.add(`${term}s`);
  }

  return variants;
}

function extractReferenceMap(text) {
  const map = {};
  const markerPattern = /(^|-\s|\s)([a-z]{1,2})(?=(?:\s*[1-3]?\s?[A-Z])|(?:I{1,3}\s)|(?:[A-Z][a-z]))/g;
  const markers = [];

  for (const match of text.matchAll(markerPattern)) {
    const prefix = match[1] ?? "";
    const key = (match[2] ?? "").toLowerCase();
    const index = match.index + prefix.length;
    markers.push({ key, index });
  }

  for (let index = 0; index < markers.length; index += 1) {
    const current = markers[index];
    const next = markers[index + 1];
    const value = text
      .slice(current.index + current.key.length, next ? next.index : text.length)
      .replace(/\s+/g, " ")
      .replace(/^\s+/, "")
      .replace(/\s*-\s*$/g, "")
      .trim();

    if (value && /\d+:\d+/.test(value) && !map[current.key]) {
      map[current.key] = value.endsWith(".") ? value : `${value}.`;
    }
  }

  return map;
}

function splitBodyAndReferenceText(text) {
  const startIndex = text.search(/\b[a-z]{1,2}\s+(?=[1-3]?\s?[A-Z][A-Za-z.]*\s?\d+:\d+)/i);
  if (startIndex === -1) {
    return {
      bodyText: text.trim(),
      referenceText: ""
    };
  }

  return {
    bodyText: text.slice(0, startIndex).trim(),
    referenceText: text.slice(startIndex).trim()
  };
}

function cleanSnippetSentence(sentence) {
  return sentence
    .replace(/^#+\s*/, "")
    .replace(/^[a-z]{1,2}\s+(?=[A-Z])/i, "")
    .replace(/([,;:.!?])([a-z]{1,2})(?=[A-Za-z])/g, "$1 ")
    .replace(/([A-Za-z][,;:.!?])([a-z]{1,2})(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/\s+([,;:.!?])/g, "$1")
    .trim();
}

function looksLikeHeading(sentence) {
  const normalized = sentence.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return true;
  }

  if (/^chapter\b/i.test(normalized)) {
    return true;
  }

  return normalized.length <= 80 && /^[A-Z0-9 .,'()\-]+$/.test(normalized);
}

function isReferenceStyleChunk(chunk) {
  const combined = `${chunk.section ?? ""} ${chunk.text ?? ""}`;
  return /table of contents/i.test(combined) || /(^|\s)index(\s|$)/i.test(combined);
}

function isNonSubstantiveChunk(chunk) {
  const section = `${chunk.section ?? ""}`.trim();
  const text = `${chunk.text ?? ""}`.trim();
  const combined = `${section} ${text}`.replace(/\s+/g, " ").trim();
  const lowered = combined.toLowerCase();

  if (!combined) {
    return true;
  }

  if (isReferenceStyleChunk(chunk)) {
    return true;
  }

  if (/^(contents?|index|indices|appendix|appendices|foreword|preface)$/i.test(section)) {
    return true;
  }

  if (/table of contents|scripture index|subject index|topical index|alphabetical index/i.test(lowered)) {
    return true;
  }

  if (/^chapter\s+\d+\b/i.test(text) && text.length < 80) {
    return true;
  }

  if (/revision history|history of revisions|historical note|amendment history|adopted in|revised in|ordered in/i.test(lowered)) {
    if (!/(shall|must|may|should|is|are|office|discipline|worship|government|member|deacon|elder|minister|session|presbytery|synod|complaint|appeal|charge|sin|christ|god|justification|judgment)/i.test(lowered)) {
      return true;
    }
  }

  if (/see also|cross reference|refer to|see fog|see bod|see wcf|see lc|see sc/i.test(lowered)) {
    if (text.length < 220) {
      return true;
    }
  }

  const tokens = lowered.split(/\s+/).filter(Boolean);
  const uniqueTokens = new Set(tokens);
  const hasVeryLowDiversity = tokens.length >= 12 && uniqueTokens.size / tokens.length < 0.45;
  const looksLikeListOnly =
    /^[-•]/.test(text) &&
    !/[.?!]/.test(text) &&
    /(chapter|section|page|contents|index)/i.test(text);
  if (hasVeryLowDiversity && looksLikeListOnly) {
    return true;
  }

  return false;
}

function detectInlineReferenceKeys(text, nextSentence = "") {
  const keys = new Set();

  const openingMatch = text.match(/^([a-z]{1,2})\s+(?=[A-Z])/i);
  if (openingMatch) {
    keys.add(openingMatch[1].toLowerCase());
  }

  for (const match of text.matchAll(/[,;:.!?]([a-z]{1,2})(?=\s+[A-Za-z]|$)/g)) {
    keys.add(match[1].toLowerCase());
  }

  for (const match of text.matchAll(/[,;:.!?]([a-z]{1,2})(?=[A-Za-z])/g)) {
    keys.add(match[1].toLowerCase());
  }

  const nextSentenceMatch = `${nextSentence ?? ""}`.trim().match(/^([a-z]{1,2})\s+(?=[A-Z])/i);
  if (nextSentenceMatch) {
    keys.add(nextSentenceMatch[1].toLowerCase());
  }

  return Array.from(keys);
}
