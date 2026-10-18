
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { FalkorDB } from "falkordb";
import { createAutonomousHandler } from "./autonomousAgent.js";

import {
  loadProjectContext,
  saveKnowledge,
  searchKnowledge,
  readPublicUrl,
} from "./knowledge.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "100kb" }));

let graph;
let db;

const PORT = Number(process.env.PORT) || 5000;
const GRAPH_NAME = process.env.GRAPH_NAME || "agentvault";

const MEMORY_TYPES = ["episodic", "semantic", "procedural"];



function validateKnowledgeUserId(value) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 100;
}

// Get the shared AgentVault project context.
app.get("/api/knowledge/context", async (req, res) => {
  try {
    const content = await loadProjectContext();
    res.json({ source: "PROJECT_CONTEXT.md", content });
  } catch (error) {
    console.error("Context load failed:", getErrorMessage(error));
    res.status(500).json({ error: "Could not load project context" });
  }
});

// Save text or document content as searchable semantic knowledge.
app.post("/api/knowledge", async (req, res) => {
  try {
    const { userId, content, sourceType = "text", source = "manual" } =
      req.body ?? {};

    if (!validateKnowledgeUserId(userId)) {
      return res.status(400).json({ error: "A valid userId is required." });
    }

    if (typeof content !== "string" || !content.trim()) {
      return res.status(400).json({ error: "Non-empty content is required." });
    }

    if (content.length > 20000) {
      return res.status(413).json({ error: "Content exceeds 20,000 characters." });
    }

    const memory = await saveKnowledge(graph, {
      userId: userId.trim(),
      content,
      sourceType,
      source,
    });

    return res.status(201).json({
      message: "Knowledge saved to FalkorDB.",
      knowledge: memory,
    });
  } catch (error) {
    console.error("Knowledge save failed:", getErrorMessage(error));
    res.status(500).json({ error: "Could not save knowledge." });
  }
});

// Search knowledge belonging to one user.
app.get("/api/knowledge/search", async (req, res) => {
  try {
    const userId = typeof req.query.userId === "string"
      ? req.query.userId.trim()
      : "";
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    if (!validateKnowledgeUserId(userId) || !q) {
      return res.status(400).json({ error: "userId and q are required." });
    }

    const knowledge = await searchKnowledge(graph, userId, q);
    res.json({ userId, query: q, count: knowledge.length, knowledge });
  } catch (error) {
    console.error("Knowledge search failed:", getErrorMessage(error));
    res.status(500).json({ error: "Could not search knowledge." });
  }
});

// Fetch a public text/HTML/JSON URL and save its readable content.
app.post("/api/knowledge/url", async (req, res) => {
  try {
    const { userId, url } = req.body ?? {};

    if (!validateKnowledgeUserId(userId)) {
      return res.status(400).json({ error: "A valid userId is required." });
    }

    if (typeof url !== "string" || url.length > 2048) {
      return res.status(400).json({ error: "A valid URL is required." });
    }

    const page = await readPublicUrl(url);

    const knowledge = await saveKnowledge(graph, {
      userId: userId.trim(),
      content: `Source URL: ${page.url}\n\n${page.content}`,
      sourceType: "url",
      source: page.url,
    });

    return res.status(201).json({
      message: "Webpage fetched and saved as knowledge.",
      page: {
        url: page.url,
        title: page.title,
        contentType: page.contentType,
        charactersSaved: knowledge.content.length,
      },
      knowledge,
    });
  } catch (error) {
    console.error("URL ingestion failed:", getErrorMessage(error));
    res.status(400).json({
      error: "Could not read or save this URL.",
      detail: getErrorMessage(error),
    });
  }
});



function getRows(result) {
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result)) return result;
  return [];
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this",
  "was", "were", "are", "has", "have", "when", "after",
  "before", "into", "our", "you", "your", "not", "but",
  "because", "then", "than", "its", "key", "why",
  "how", "does", "did", "can", "could", "would", "should",
  "missing", "server", "environment", "investigate",
]);

function extractTerms(text) {
  return [
    ...new Set(text.toLowerCase().match(/[a-z0-9_-]+/g) || []),
  ]
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
    .slice(0, 12);
}

function isValidSourceMemory(memory) {
  const content = String(memory.content || "");

  return (
    !content.includes('"actionMode"') &&
    !content.includes('"recommendation"') &&
    !content.includes('"verificationResult"')
  );
}

// Health check
app.get("/", (req, res) => {
  res.json({ message: "AgentVault backend is running" });
});

app.get("/api/health", async (req, res) => {
  try {
    await graph.query("RETURN 1 AS result");

    res.json({
      status: "connected",
      database: "FalkorDB",
      graph: GRAPH_NAME,
    });
  } catch (error) {
    console.error("Health check failed:", getErrorMessage(error));
    res.status(500).json({ error: "Database query failed" });
  }
});

// List agents
app.get("/api/agents", async (req, res) => {
  try {
    const result = await graph.query(`
      MATCH (a:Agent)
      RETURN a.name AS name, a.role AS role
      ORDER BY a.name
    `);

    res.json({ agents: getRows(result) });
  } catch (error) {
    console.error("Fetch agents failed:", getErrorMessage(error));
    res.status(500).json({ error: "Could not retrieve agents" });
  }
});

// Save a memory and connect related memories
app.post("/api/memory", async (req, res) => {
  try {
    const { type, content, userId } = req.body ?? {};

    if (
      !MEMORY_TYPES.includes(type) ||
      typeof content !== "string" ||
      !content.trim() ||
      typeof userId !== "string" ||
      !userId.trim()
    ) {
      return res.status(400).json({
        error: "Provide a valid type, content, and userId",
      });
    }

    const cleanUserId = userId.trim();
    const cleanContent = content.trim();

    if (cleanUserId.length > 100 || cleanContent.length > 10000) {
      return res.status(400).json({ error: "Input is too long" });
    }

    const id = randomUUID();
    const createdAt = Date.now();
    const terms = extractTerms(cleanContent);

    await graph.query(
      `CREATE (m:Memory {
        id: $id,
        type: $type,
        content: $content,
        userId: $userId,
        createdAt: $createdAt
      })`,
      {
        params: {
          id,
          type,
          content: cleanContent,
          userId: cleanUserId,
          createdAt,
        },
      }
    );

    if (terms.length > 0) {
      await graph.query(
        `MATCH (newMemory:Memory {id: $id, userId: $userId})
         MATCH (oldMemory:Memory {userId: $userId})
         WHERE oldMemory.id <> $id
           AND oldMemory.type IN ['episodic', 'semantic', 'procedural']
           AND any(term IN $terms WHERE
             toLower(coalesce(oldMemory.content, '')) CONTAINS term)
         WITH newMemory, oldMemory
         LIMIT 5
         MERGE (newMemory)-[:RELATED_TO]->(oldMemory)`,
        {
          params: {
            id,
            userId: cleanUserId,
            terms,
          },
        }
      );
    }

    return res.status(201).json({
      message: "Memory saved successfully",
      memory: {
        id,
        type,
        content: cleanContent,
        userId: cleanUserId,
        createdAt,
      },
    });
  } catch (error) {
    console.error("Save memory failed:", getErrorMessage(error));
    return res.status(500).json({ error: "Could not save memory" });
  }
});

// Retrieve memories for a user
app.get("/api/memory", async (req, res) => {
  try {
    const userId =
      typeof req.query.userId === "string"
        ? req.query.userId.trim()
        : "";

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const result = await graph.query(
      `MATCH (m:Memory {userId: $userId})
       RETURN m.id AS id,
              m.type AS type,
              m.content AS content,
              m.createdAt AS createdAt
       ORDER BY m.createdAt DESC`,
      { params: { userId } }
    );

    res.json(getRows(result));
  } catch (error) {
    console.error("Retrieve memories failed:", getErrorMessage(error));
    res.status(500).json({ error: "Could not retrieve memories" });
  }
});

// Search memories by exact phrase, keywords, and graph connections
app.get("/api/memory/search", async (req, res) => {
  try {
    const userId =
      typeof req.query.userId === "string"
        ? req.query.userId.trim()
        : "";

    const q =
      typeof req.query.q === "string"
        ? req.query.q.trim()
        : "";

    if (!userId || !q) {
      return res.status(400).json({
        error: "userId and q are required",
      });
    }

    if (userId.length > 100 || q.length > 1000) {
      return res.status(400).json({
        error: "Input is too long",
      });
    }

    const terms = extractTerms(q);
    const resultsById = new Map();

    // 1. Find directly matching memories.
    const directResult = await graph.query(
      `MATCH (m:Memory {userId: $userId})
       WHERE toLower(coalesce(m.content, ''))
                 CONTAINS toLower($q)
          OR any(term IN $terms WHERE
                 toLower(coalesce(m.content, ''))
                   CONTAINS term)
       RETURN m.id AS id,
              m.type AS type,
              m.content AS content,
              m.createdAt AS createdAt,
              false AS graphConnected
       ORDER BY m.createdAt DESC
       LIMIT 20`,
      {
        params: {
          userId,
          q,
          terms,
        },
      }
    );

    for (const memory of getRows(directResult)) {
      if (memory.id) {
        resultsById.set(memory.id, {
          ...memory,
          graphConnected: false,
          retrievalPath: "DIRECT_MATCH",
        });
      }
    }

    // 2. Find memories connected to matching memories.
    const graphResult = await graph.query(
      `MATCH (source:Memory {userId: $userId})
             -[:RELATED_TO]-
             (related:Memory {userId: $userId})
       WHERE source.id <> related.id
         AND (
           toLower(coalesce(source.content, ''))
             CONTAINS toLower($q)
           OR any(term IN $terms WHERE
             toLower(coalesce(source.content, ''))
               CONTAINS term)
         )
       RETURN DISTINCT
              related.id AS id,
              related.type AS type,
              related.content AS content,
              related.createdAt AS createdAt,
              true AS graphConnected,
              source.id AS connectedFrom,
              source.content AS sourceContent,
              'RELATED_TO' AS relationship
       ORDER BY related.createdAt DESC
       LIMIT 30`,
      {
        params: {
          userId,
          q,
          terms,
        },
      }
    );

    for (const memory of getRows(graphResult)) {
      if (!memory.id) continue;

      const existing = resultsById.get(memory.id);

      resultsById.set(memory.id, {
        ...existing,
        ...memory,
        graphConnected: true,
        retrievalPath: existing
          ? "DIRECT_MATCH_AND_GRAPH_NEIGHBOR"
          : "GRAPH_NEIGHBOR",
      });
    }

    // 3. Put graph-connected results first.
    const memories = [...resultsById.values()]
      .sort(
        (a, b) =>
          Number(Boolean(b.graphConnected)) -
          Number(Boolean(a.graphConnected)) ||
          Number(b.createdAt || 0) -
          Number(a.createdAt || 0)
      )
      .slice(0, 30);

    return res.json({
      userId,
      query: q,
      count: memories.length,
      memories,
      message: memories.length
        ? "Memory search completed"
        : "No matching memories found",
    });
  } catch (error) {
    console.error(
      "Memory search failed:",
      getErrorMessage(error)
    );

    return res.status(500).json({
      error: "Could not search memories",
    });
  }
});
// Search memories by exact phrase and individual keywords
// Standalone Research Agent endpoint
app.post("/api/agents/research", async (req, res) => {
  try {
    const { userId, incident } = req.body ?? {};

    if (
      typeof userId !== "string" ||
      !userId.trim() ||
      typeof incident !== "string" ||
      !incident.trim()
    ) {
      return res.status(400).json({
        error: "Provide a valid userId and incident description",
      });
    }

    const cleanUserId = userId.trim();
    const cleanIncident = incident.trim();

    if (cleanUserId.length > 100 || cleanIncident.length > 2000) {
      return res.status(400).json({ error: "Input is too long" });
    }

    const terms = extractTerms(cleanIncident);
    const evidenceById = new Map();

    if (terms.length > 0) {
      const directResult = await graph.query(
        `MATCH (m:Memory {userId: $userId})
         WHERE m.type IN ['episodic', 'semantic', 'procedural']
           AND any(term IN $terms WHERE
             toLower(coalesce(m.content, '')) CONTAINS term)
         RETURN m.id AS id,
                m.type AS type,
                m.content AS content,
                m.createdAt AS createdAt,
                'DIRECT_MATCH' AS retrievalPath
         ORDER BY m.createdAt DESC
         LIMIT 20`,
        { params: { userId: cleanUserId, terms } }
      );

      for (const memory of getRows(directResult)) {
        if (memory.id && isValidSourceMemory(memory)) {
          evidenceById.set(memory.id, {
            ...memory,
            retrievalPath: "DIRECT_MATCH",
            graphConnected: false,
          });
        }
      }

      const graphResult = await graph.query(
        `MATCH (source:Memory {userId: $userId})-[:RELATED_TO]-(related:Memory {userId: $userId})
         WHERE source.type IN ['episodic', 'semantic', 'procedural']
           AND related.type IN ['episodic', 'semantic', 'procedural']
           AND source.id <> related.id
           AND any(term IN $terms WHERE
             toLower(coalesce(source.content, '')) CONTAINS term)
         RETURN DISTINCT
                related.id AS id,
                related.type AS type,
                related.content AS content,
                related.createdAt AS createdAt,
                'GRAPH_NEIGHBOR' AS retrievalPath,
                'RELATED_TO' AS relationship,
                source.id AS connectedFrom,
                source.content AS sourceContent
         LIMIT 30`,
        { params: { userId: cleanUserId, terms } }
      );

      for (const memory of getRows(graphResult)) {
        if (!memory.id || !isValidSourceMemory(memory)) continue;

        const existing = evidenceById.get(memory.id);

        if (existing) {
          evidenceById.set(memory.id, {
            ...existing,
            graphConnected: true,
            relationship: memory.relationship || "RELATED_TO",
            connectedFrom: memory.connectedFrom,
            sourceContent: memory.sourceContent,
          });
        } else {
          evidenceById.set(memory.id, {
            ...memory,
            retrievalPath: "GRAPH_NEIGHBOR",
            graphConnected: true,
          });
        }
      }
    }

    const evidence = [...evidenceById.values()]
      .sort(
        (a, b) =>
          Number(Boolean(b.graphConnected)) -
          Number(Boolean(a.graphConnected))
      )
      .slice(0, 10);

    res.json({
      agent: "Research Agent",
      incident: cleanIncident,
      evidenceCount: evidence.length,
      evidence,
      status: evidence.length ? "evidence_found" : "no_matching_memory",
      message: evidence.length
        ? "Retrieved potentially relevant memories. Verify evidence before acting."
        : "No matching memories found. Investigate using fresh evidence.",
    });
  } catch (error) {
    console.error("Research agent failed:", getErrorMessage(error));
    res.status(500).json({ error: "Research could not be completed" });
  }
});

// Existing Research -> Planning -> Execution workflow
app.post("/api/workflow/investigate", async (req, res) => {
  console.log("RUN INVESTIGATION REQUEST RECEIVED");

  try {
    const { userId, incident } = req.body ?? {};

    if (
      typeof userId !== "string" ||
      !userId.trim() ||
      typeof incident !== "string" ||
      !incident.trim()
    ) {
      return res.status(400).json({
        error: "Provide a valid userId and incident description",
      });
    }

    const cleanUserId = userId.trim();
    const cleanIncident = incident.trim();

    if (cleanUserId.length > 100 || cleanIncident.length > 2000) {
      return res.status(400).json({ error: "Input is too long" });
    }

    const terms = extractTerms(cleanIncident);
    const evidenceById = new Map();

    if (terms.length > 0) {
      const researchResult = await graph.query(
        `MATCH (m:Memory {userId: $userId})
         WHERE m.type IN ['episodic', 'semantic', 'procedural']
           AND any(term IN $terms WHERE
             toLower(coalesce(m.content, '')) CONTAINS term)
         RETURN m.id AS id,
                m.type AS type,
                m.content AS content,
                m.createdAt AS createdAt,
                'DIRECT_MATCH' AS retrievalPath
         ORDER BY m.createdAt DESC
         LIMIT 20`,
        { params: { userId: cleanUserId, terms } }
      );

      for (const memory of getRows(researchResult)) {
        if (!memory.id || !isValidSourceMemory(memory)) continue;

        evidenceById.set(memory.id, {
          ...memory,
          retrievalPath: "DIRECT_MATCH",
          graphConnected: false,
        });
      }

      const graphResult = await graph.query(
        `MATCH (source:Memory {userId: $userId})-[:RELATED_TO]-(related:Memory {userId: $userId})
         WHERE source.type IN ['episodic', 'semantic', 'procedural']
           AND related.type IN ['episodic', 'semantic', 'procedural']
           AND source.id <> related.id
           AND any(term IN $terms WHERE
             toLower(coalesce(source.content, '')) CONTAINS term)
         RETURN DISTINCT
                related.id AS id,
                related.type AS type,
                related.content AS content,
                related.createdAt AS createdAt,
                'GRAPH_NEIGHBOR' AS retrievalPath,
                'RELATED_TO' AS relationship,
                source.id AS connectedFrom,
                source.content AS sourceContent
         LIMIT 30`,
        { params: { userId: cleanUserId, terms } }
      );

      for (const memory of getRows(graphResult)) {
        if (!memory.id || !isValidSourceMemory(memory)) continue;

        const existing = evidenceById.get(memory.id);

        if (existing) {
          evidenceById.set(memory.id, {
            ...existing,
            graphConnected: true,
            relationship: memory.relationship || "RELATED_TO",
            connectedFrom: memory.connectedFrom,
            sourceContent: memory.sourceContent,
          });
        } else {
          evidenceById.set(memory.id, {
            ...memory,
            retrievalPath: "GRAPH_NEIGHBOR",
            graphConnected: true,
          });
        }
      }
    }

    const evidence = [...evidenceById.values()]
      .sort(
        (a, b) =>
          Number(Boolean(b.graphConnected)) -
          Number(Boolean(a.graphConnected))
      )
      .slice(0, 10);

    const evidenceIds = [
      ...new Set(
        evidence
          .map((item) => item.id)
          .filter((id) => typeof id === "string" && id.length > 0)
      ),
    ];

    const incidentText = cleanIncident.toLowerCase();

    const isAuthIncident =
      incidentText.includes("auth") ||
      incidentText.includes("401") ||
      incidentText.includes("unauthorized") ||
      incidentText.includes("api key") ||
      incidentText.includes("authentication");

    const hasKeyEvidence = evidence.some((item) => {
      const content = String(item.content || "").toLowerCase();

      return (
        content.includes("key") ||
        content.includes("token") ||
        content.includes("authentication") ||
        content.includes("credential")
      );
    });

    let recommendation;
    let evidenceBasis;
    let nextSteps;

    if (isAuthIncident && hasKeyEvidence) {
      recommendation =
        "Investigate the API authentication configuration first. Check whether the required key or token is configured in the backend environment and whether the deployment is loading it correctly. Do not expose or log the secret value.";

      evidenceBasis =
        "Stored memories mention API authentication and key configuration. This supports a suspected cause, but the current environment and logs have not been verified.";

      nextSteps = [
        "Check server logs and the failing request's HTTP status.",
        "Confirm the required environment variable is present without printing its secret value.",
        "Verify that the deployed backend loads the correct configuration and that the credential is valid.",
        "Propose a reversible configuration correction for human approval, then retest authentication.",
      ];
    } else if (evidence.length > 0) {
      recommendation =
        "Review the relevant stored memories and gather current logs before choosing a remediation.";

      evidenceBasis =
        "Relevant stored memories were found, but they do not establish the current root cause.";

      nextSteps = [
        "Collect current logs and recent deployment details.",
        "Compare the stored evidence with the current incident.",
        "Identify and validate the most likely cause.",
        "Propose a reversible change for human approval and verify the result.",
      ];
    } else {
      recommendation =
        "Insufficient relevant evidence is available. Gather current logs and deployment details before recommending a fix.";

      evidenceBasis =
        "No relevant source memories were found; the root cause remains unknown.";

      nextSteps = [
        "Collect the error message, relevant logs, and HTTP status.",
        "Review recent code and configuration changes.",
        "Validate a suspected cause using current evidence.",
        "Propose a remediation only after validation and human approval.",
      ];
    }

    const executionOutcome =
      "No real fix has been applied or verified. The incident remains unresolved.";

    const investigationId = randomUUID();
    const planMemoryId = randomUUID();
    const executionMemoryId = randomUUID();
    const now = Date.now();

    await graph.query(
      `CREATE (i:Investigation {
         id: $investigationId,
         userId: $userId,
         incident: $incident,
         status: 'execution_recorded',
         createdAt: $now
       })
       CREATE (p:Memory {
         id: $planMemoryId,
         userId: $userId,
         type: 'procedural',
         content: $planContent,
         createdAt: $now
       })
       CREATE (e:Memory {
         id: $executionMemoryId,
         userId: $userId,
         type: 'episodic',
         content: $executionContent,
         createdAt: $now
       })
       CREATE (i)-[:HAS_MEMORY]->(p)
       CREATE (i)-[:HAS_MEMORY]->(e)`,
      {
        params: {
          investigationId,
          userId: cleanUserId,
          incident: cleanIncident,
          planMemoryId,
          executionMemoryId,
          planContent: JSON.stringify({
            incident: cleanIncident,
            recommendation,
            evidenceBasis,
            evidenceReviewed: evidence.length,
            nextSteps,
          }),
          executionContent: JSON.stringify({
            incident: cleanIncident,
            actionMode: "safe_simulation_only",
            outcome: executionOutcome,
            verificationResult: "inconclusive",
          }),
          now,
        },
      }
    );

    if (evidenceIds.length > 0) {
      await graph.query(
        `MATCH (i:Investigation {
           id: $investigationId,
           userId: $userId
         })
         MATCH (m:Memory {userId: $userId})
         WHERE m.id IN $evidenceIds
         MERGE (i)-[:HAS_EVIDENCE]->(m)`,
        {
          params: {
            investigationId,
            userId: cleanUserId,
            evidenceIds,
          },
        }
      );
    }

    await graph.query(
      `MATCH (a:Agent), (m:Memory)
       WHERE (a.name = 'Planning Agent' AND m.id = $planMemoryId)
          OR (a.name = 'Execution Agent' AND m.id = $executionMemoryId)
       MERGE (a)-[:CREATED]->(m)`,
      { params: { planMemoryId, executionMemoryId } }
    );

    await graph.query(
      `MATCH (i:Investigation {
         id: $investigationId,
         userId: $userId
       })
       MATCH (a:Agent)
       WHERE a.name IN [
         'Research Agent',
         'Planning Agent',
         'Execution Agent'
       ]
       MERGE (a)-[:PARTICIPATED_IN]->(i)`,
      {
        params: {
          investigationId,
          userId: cleanUserId,
        },
      }
    );

    return res.status(201).json({
      investigationId,
      workflow: "Research -> Planning -> Execution",
      incident: cleanIncident,

      research: {
        evidence: initialMemories,
        count: initialMemories.length,
        projectContextLoaded: Boolean(projectContext),
        knowledge: relevantKnowledge,
        knowledgeCount: relevantKnowledge.length,
      },

      planning: {
        agent: "Planning Agent",
        recommendation,
        evidenceReviewed: evidence.length,
        evidenceBasis,
        nextSteps,
      },
      execution: {
        agent: "Execution Agent",
        actionMode: "safe_simulation_only",
        verificationResult: "inconclusive",
        outcome: executionOutcome,
        status: "execution_recorded",
      },
      savedMemoryIds: [planMemoryId, executionMemoryId],
      message: "Investigation recorded. No real remediation was performed.",
    });
  } catch (error) {
    console.error("INVESTIGATION ERROR:", error);
    console.error("ERROR STACK:", error.stack);

    return res.status(500).json({
      error: "Investigation workflow failed",
      details: getErrorMessage(error),
    });
  }
});
// ============================================
// AGENT HANDOFF: Research Agent -> Planning Agent
// ============================================

// Research Agent saves findings and evidence IDs.
app.post("/api/handoffs", async (req, res) => {
  try {
    const {
      userId,
      investigationId,
      findings,
      evidenceIds = [],
    } = req.body ?? {};

    if (
      typeof userId !== "string" ||
      !userId.trim() ||
      typeof investigationId !== "string" ||
      !investigationId.trim() ||
      typeof findings !== "string" ||
      !findings.trim() ||
      !Array.isArray(evidenceIds)
    ) {
      return res.status(400).json({
        error: "Provide userId, investigationId, findings and evidenceIds",
      });
    }

    const cleanUserId = userId.trim();
    const cleanInvestigationId = investigationId.trim();
    const cleanFindings = findings.trim();

    if (
      cleanUserId.length > 100 ||
      cleanInvestigationId.length > 100 ||
      cleanFindings.length > 5000 ||
      evidenceIds.length > 50
    ) {
      return res.status(400).json({
        error: "Input exceeds the allowed limits",
      });
    }

    const uniqueEvidenceIds = [
      ...new Set(
        evidenceIds.filter(
          (id) => typeof id === "string" && id.trim().length > 0
        ).map((id) => id.trim())
      ),
    ];

    // Ensure the investigation belongs to this user.
    const investigationResult = await graph.query(
      `MATCH (i:Investigation {
        id: $investigationId,
        userId: $userId
      })
      RETURN i.id AS id`,
      {
        params: {
          investigationId: cleanInvestigationId,
          userId: cleanUserId,
        },
      }
    );

    if (!getRows(investigationResult).length) {
      return res.status(404).json({
        error: "Investigation not found for this user",
      });
    }

    // Ensure every evidence ID belongs to the same user.
    if (uniqueEvidenceIds.length > 0) {
      const evidenceResult = await graph.query(
        `MATCH (m:Memory {userId: $userId})
         WHERE m.id IN $evidenceIds
         RETURN collect(m.id) AS ids`,
        {
          params: {
            userId: cleanUserId,
            evidenceIds: uniqueEvidenceIds,
          },
        }
      );

      const validIds = new Set(
        getRows(evidenceResult)[0]?.ids ?? []
      );

      const invalidIds = uniqueEvidenceIds.filter(
        (id) => !validIds.has(id)
      );

      if (invalidIds.length > 0) {
        return res.status(400).json({
          error: "One or more evidence IDs are invalid for this user",
          invalidEvidenceCount: invalidIds.length,
        });
      }
    }

    const handoffId = randomUUID();
    const createdAt = Date.now();

    const payload = {
      findings: cleanFindings,
      evidenceIds: uniqueEvidenceIds,
    };

    await graph.query(
      `CREATE (h:AgentHandoff {
        id: $handoffId,
        userId: $userId,
        investigationId: $investigationId,
        sourceAgent: 'Research Agent',
        targetAgent: 'Planning Agent',
        findings: $findings,
        payloadJson: $payloadJson,
        status: 'pending',
        createdAt: $createdAt
      })`,
      {
        params: {
          handoffId,
          userId: cleanUserId,
          investigationId: cleanInvestigationId,
          findings: cleanFindings,
          payloadJson: JSON.stringify(payload),
          createdAt,
        },
      }
    );

    if (uniqueEvidenceIds.length > 0) {
      await graph.query(
        `MATCH (h:AgentHandoff {
          id: $handoffId,
          userId: $userId
        })
        MATCH (m:Memory {userId: $userId})
        WHERE m.id IN $evidenceIds
        MERGE (h)-[:CARRIES_EVIDENCE]->(m)`,
        {
          params: {
            handoffId,
            userId: cleanUserId,
            evidenceIds: uniqueEvidenceIds,
          },
        }
      );
    }

    // Create the agent relationship only if both agent nodes exist.
    await graph.query(
      `MATCH (source:Agent {name: 'Research Agent'})
       MATCH (target:Agent {name: 'Planning Agent'})
       MATCH (h:AgentHandoff {
         id: $handoffId,
         userId: $userId
       })
       MERGE (source)-[:HANDED_OFF]->(h)
       MERGE (h)-[:ASSIGNED_TO]->(target)`,
      {
        params: {
          handoffId,
          userId: cleanUserId,
        },
      }
    );

    return res.status(201).json({
      handoffId,
      userId: cleanUserId,
      investigationId: cleanInvestigationId,
      sourceAgent: "Research Agent",
      targetAgent: "Planning Agent",
      status: "pending",
      findings: cleanFindings,
      evidenceIds: uniqueEvidenceIds,
      createdAt,
      message: "Research handoff saved to FalkorDB",
    });
  } catch (error) {
    console.error("Create handoff failed:", getErrorMessage(error));

    return res.status(500).json({
      error: "Could not create agent handoff",
    });
  }
});

// Planning Agent retrieves the persisted handoff.
app.post("/api/agents/planning/handoff", async (req, res) => {
  try {
    const { userId, handoffId } = req.body ?? {};

    if (
      typeof userId !== "string" ||
      !userId.trim() ||
      typeof handoffId !== "string" ||
      !handoffId.trim()
    ) {
      return res.status(400).json({
        error: "Provide userId and handoffId",
      });
    }

    const cleanUserId = userId.trim();
    const cleanHandoffId = handoffId.trim();

    const result = await graph.query(
      `MATCH (h:AgentHandoff {
        id: $handoffId,
        userId: $userId,
        targetAgent: 'Planning Agent'
      })
      OPTIONAL MATCH (h)-[:CARRIES_EVIDENCE]->(m:Memory {
        userId: $userId
      })
      RETURN h.id AS handoffId,
             h.userId AS userId,
             h.investigationId AS investigationId,
             h.sourceAgent AS sourceAgent,
             h.targetAgent AS targetAgent,
             h.findings AS findings,
             h.payloadJson AS payloadJson,
             h.status AS status,
             h.createdAt AS createdAt,
             collect(DISTINCT CASE
               WHEN m IS NULL THEN null
               ELSE {
                 id: m.id,
                 type: m.type,
                 content: m.content,
                 createdAt: m.createdAt
               }
             END) AS evidence`,
      {
        params: {
          handoffId: cleanHandoffId,
          userId: cleanUserId,
        },
      }
    );

    const handoff = getRows(result)[0];

    if (!handoff?.handoffId) {
      return res.status(404).json({
        error: "Handoff not found for this user",
      });
    }

    const receivedAt = Date.now();

    await graph.query(
      `MATCH (h:AgentHandoff {
        id: $handoffId,
        userId: $userId,
        targetAgent: 'Planning Agent'
      })
      SET h.status = 'received',
          h.receivedAt = $receivedAt`,
      {
        params: {
          handoffId: cleanHandoffId,
          userId: cleanUserId,
          receivedAt,
        },
      }
    );

    let payload = {};

    try {
      payload = JSON.parse(handoff.payloadJson || "{}");
    } catch {
      payload = { findings: handoff.findings };
    }

    return res.json({
      handoffId: handoff.handoffId,
      userId: handoff.userId,
      investigationId: handoff.investigationId,
      sourceAgent: handoff.sourceAgent,
      targetAgent: handoff.targetAgent,
      status: "received",
      findings: handoff.findings,
      evidenceIds: payload.evidenceIds ?? [],
      evidence: (handoff.evidence ?? []).filter(
        (item) => item && item.id
      ),
      createdAt: handoff.createdAt,
      receivedAt,
      message: "Planning Agent retrieved the persisted handoff",
    });
  } catch (error) {
    console.error(
      "Planning handoff retrieval failed:",
      getErrorMessage(error)
    );

    return res.status(500).json({
      error: "Could not retrieve agent handoff",
    });
  }
});

// List handoffs belonging to a user.
app.get("/api/handoffs", async (req, res) => {
  try {
    const userId =
      typeof req.query.userId === "string"
        ? req.query.userId.trim()
        : "";

    const investigationId =
      typeof req.query.investigationId === "string"
        ? req.query.investigationId.trim()
        : "";

    if (!userId) {
      return res.status(400).json({
        error: "userId is required",
      });
    }

    const result = await graph.query(
      `MATCH (h:AgentHandoff {userId: $userId})
       WHERE $investigationId = ''
          OR h.investigationId = $investigationId
       RETURN h.id AS handoffId,
              h.investigationId AS investigationId,
              h.sourceAgent AS sourceAgent,
              h.targetAgent AS targetAgent,
              h.findings AS findings,
              h.status AS status,
              h.createdAt AS createdAt,
              h.receivedAt AS receivedAt
       ORDER BY h.createdAt DESC
       LIMIT 50`,
      {
        params: {
          userId,
          investigationId,
        },
      }
    );

    const handoffs = getRows(result);

    return res.json({
      userId,
      count: handoffs.length,
      handoffs,
    });
  } catch (error) {
    console.error("List handoffs failed:", getErrorMessage(error));

    return res.status(500).json({
      error: "Could not list handoffs",
    });
  }
});
// Retrieve an investigation with its generated memories and evidence.
app.get("/api/investigations/:id", async (req, res) => {
  try {
    const id =
      typeof req.params.id === "string" ? req.params.id.trim() : "";

    const userId =
      typeof req.query.userId === "string"
        ? req.query.userId.trim()
        : "";

    if (!id || !userId) {
      return res.status(400).json({
        error: "Investigation ID and userId are required",
      });
    }

    const result = await graph.query(
      `MATCH (i:Investigation {id: $id, userId: $userId})
       OPTIONAL MATCH (i)-[:HAS_MEMORY]->(m:Memory)
       WITH i, collect(
         DISTINCT CASE WHEN m IS NULL THEN null ELSE {
           id: m.id,
           type: m.type,
           content: m.content,
           createdAt: m.createdAt
         } END
       ) AS memories
       OPTIONAL MATCH (i)-[:HAS_EVIDENCE]->(e:Memory)
       WITH i, memories, collect(
         DISTINCT CASE WHEN e IS NULL THEN null ELSE {
           id: e.id,
           type: e.type,
           content: e.content,
           createdAt: e.createdAt
         } END
       ) AS evidence
       OPTIONAL MATCH (a:Agent)-[:PARTICIPATED_IN]->(i)
       RETURN i.id AS id,
              i.userId AS userId,
              i.incident AS incident,
              i.status AS status,
              i.createdAt AS createdAt,
              memories,
              evidence,
              collect(
                DISTINCT CASE WHEN a IS NULL THEN null ELSE {
                  name: a.name,
                  role: a.role
                } END
              ) AS agents`,
      { params: { id, userId } }
    );

    const rows = getRows(result);

    if (!rows.length) {
      return res.status(404).json({
        error: "Investigation not found",
      });
    }

    const investigation = rows[0];

    investigation.memories = (investigation.memories || []).filter(
      (memory) => memory && memory.id
    );

    investigation.evidence = (investigation.evidence || []).filter(
      (item) => item && item.id
    );

    investigation.agents = (investigation.agents || []).filter(
      (agent) => agent && agent.name
    );

    res.json(investigation);
  } catch (error) {
    console.error("Get investigation failed:", getErrorMessage(error));
    res.status(500).json({ error: "Could not retrieve investigation" });
  }
});

// Start the API only after FalkorDB is connected.
async function startServer() {
  try {
    db = await FalkorDB.connect({
      host: process.env.FALKORDB_HOST || "localhost",
      port: Number(process.env.FALKORDB_PORT) || 6379,
    });

    graph = db.selectGraph(GRAPH_NAME);
    await graph.query("RETURN 1 AS result");

    // IMPORTANT: graph now exists, so pass the real graph instance.
    app.post(
      "/api/agents/autonomous",
      createAutonomousHandler({ graph })
    );

    app.listen(PORT, () => {
      console.log(`AgentVault API running at http://localhost:${PORT}`);
      console.log(`FalkorDB connected; graph: ${GRAPH_NAME}`);
      console.log("Autonomous endpoint: POST /api/agents/autonomous");
    });
  } catch (error) {
    catch (error) {
  console.error("Backend startup failed:", error);
  console.error(error?.stack || error);
  process.exit(1);
}

    if (db) {
      await db.close().catch(() => { });
    }

    process.exit(1);
  }
}

startServer();
