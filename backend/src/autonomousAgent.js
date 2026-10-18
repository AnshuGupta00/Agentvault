import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { randomUUID } from "node:crypto";

import {
  loadProjectContext,
  searchKnowledge,
} from "./knowledge.js";


const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

function rowsFrom(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.records)) return result.records;
  return [];
}

function safeJson(text) {
  const cleaned = String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  return JSON.parse(cleaned);
}

async function searchGraphMemories(graph, userId, query) {
  const terms = String(query || "")
    .toLowerCase()
    .match(/[a-z0-9_-]+/g) || [];

  const uniqueTerms = [...new Set(terms)].slice(0, 8);

  if (!uniqueTerms.length) return [];

  const result = await graph.query(
    `MATCH (m:Memory {userId: $userId})
     WHERE m.type IN ['episodic', 'semantic', 'procedural']
       AND any(term IN $terms WHERE
         toLower(coalesce(m.content, '')) CONTAINS term)
     RETURN m.id AS id,
            m.type AS type,
            m.content AS content,
            m.createdAt AS createdAt
     LIMIT 12`,
    { params: { userId, terms: uniqueTerms } }
  );

  return rowsFrom(result).map((row) => ({
    id: row.id,
    type: row.type,
    content: row.content,
    createdAt: row.createdAt,
  }));
}

async function executeSafeTool(graph, userId, tool) {
  switch (tool.name) {
    case "search_memory": {
      const memories = await searchGraphMemories(
        graph,
        userId,
        tool.input?.query || ""
      );

      return {
        tool: tool.name,
        success: true,
        count: memories.length,
        memories,
      };
    }

    case "inspect_auth_config": {
      // Never return or log the actual secret value.
      const checks = {
        GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY),
        // Configure this name if your app uses a different API auth variable.
        API_AUTH_TOKEN: Boolean(process.env.API_AUTH_TOKEN),
        NODE_ENV: process.env.NODE_ENV || "not_set",
      };

      return {
        tool: tool.name,
        success: true,
        checks,
        note: "Only presence/configuration status was checked; secret values were not exposed.",
      };
    }

    case "check_service_health": {
      return {
        tool: tool.name,
        success: true,
        service: "AgentVault backend",
        status: "The autonomous API process is running.",
        note: "This does not verify external services or production endpoints.",
      };
    }

    default:
      throw new Error(`Tool not allowed: ${tool.name}`);
  }
}

async function callModel(contents) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          responseMimeType: "application/json",
        },
      });

      if (!response.text) {
        throw new Error("Gemini returned an empty response.");
      }

      return safeJson(response.text);
    } catch (error) {
      const message = String(error?.message || error);
      const isTemporary =
        /503|UNAVAILABLE|high demand|overloaded|429|RESOURCE_EXHAUSTED|500|502|504|timeout|ECONNRESET/i.test(
          message
        );

      // Retry temporary errors, but do not retry malformed JSON or
      // permanent configuration/authentication errors.
      if (!isTemporary || attempt === maxAttempts) {
        throw error;
      }

      const delayMs = attempt * 2000;
      console.warn(
        `Gemini temporary error. Retry ${attempt}/${maxAttempts - 1} in ${delayMs}ms.`
      );

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error("Gemini request failed after retries.");
}

function createAutonomousHandler({ graph }) {
  return async function autonomousAgentHandler(req, res) {
    try {
      if (!ai) {
        return res.status(503).json({
          error: "Gemini is not configured.",
          hint: "Set GEMINI_API_KEY in backend/.env and restart the backend.",
        });
      }

      const userId =
        typeof req.body?.userId === "string"
          ? req.body.userId.trim()
          : "";

      const incident =
        typeof req.body?.incident === "string"
          ? req.body.incident.trim()
          : "";

      if (!userId || !incident) {
        return res.status(400).json({
          error: "userId and incident are required.",
        });
      }

      if (userId.length > 120 || incident.length > 3000) {
        return res.status(400).json({
          error: "Input is too long.",
        });
      }

      // Agent 1: Research — retrieve persistent graph memories.
      const initialMemories = await searchGraphMemories(
        graph,
        userId,
        incident
      );
      
      
const [projectContext, relevantKnowledge] = await Promise.all([
  loadProjectContext(),
  searchKnowledge(graph, userId, incident, 8),
]);

      // Agent 2: Planner — decide which allowlisted tools are needed.
      const plan = await callModel([
        {
          role: "user",
          parts: [
            {
              text: `You are the planning agent for AgentVault.

Investigate the incident using only the provided evidence and allowed tools.
Do not claim a check happened unless its tool result confirms it.
Do not invent facts. Never request passwords, tokens, or secret values.
Never propose arbitrary shell commands or destructive changes.
Maximum 3 tool calls.

Return JSON with this exact shape:
{
  "summary": "short summary",
  "hypotheses": ["evidence-based possibilities"],
  "tools": [
    {
      "name": "search_memory | inspect_auth_config | check_service_health",
      "input": {"query": "search terms when applicable"},
      "reason": "why this check is useful"
    }
  ],
  "nextSteps": ["safe, specific next steps"]
}

Allowed tool names:
- search_memory: search persisted memories for relevant information
- inspect_auth_config: inspect whether selected environment variables exist, never their values
- check_service_health: report the current backend process status

USER ID: ${userId}
INCIDENT: ${incident}
INITIAL GRAPH MEMORIES:
${JSON.stringify(initialMemories)}`
            }
          ]
        }
      ]);

      const allowedTools = new Set([
        "search_memory",
        "inspect_auth_config",
        "check_service_health",
      ]);

      const selectedTools = Array.isArray(plan.tools)
        ? plan.tools.filter(
            (tool) =>
              tool &&
              allowedTools.has(tool.name)
          ).slice(0, 3)
        : [];

      // Agent 3: Executor — only runs explicit safe, allowlisted checks.
      const toolResults = [];

      for (const tool of selectedTools) {
        try {
          const result = await Promise.race([
            executeSafeTool(graph, userId, tool),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("Tool timed out")),
                8000
              )
            ),
          ]);

          toolResults.push(result);
        } catch (error) {
          toolResults.push({
            tool: tool.name,
            success: false,
            error: error.message || "Tool failed",
          });
        }
      }

      // Agent 4: Verification — conclusions must be tied to actual evidence.
      const verification = await callModel([
        {
          role: "user",
          parts: [
            {
              text: `You are AgentVault's verification agent.

Compare the incident, graph memories, plan, and actual tool results.
Clearly separate confirmed observations from hypotheses.
Do not claim a fix was applied. No repair or production change was performed.
If evidence is insufficient, say so.

Return JSON:
{
  "conclusion": "evidence-based conclusion",
  "confirmedFindings": ["only facts supported by evidence"],
  "unverifiedHypotheses": ["possible explanations not yet proven"],
  "verificationStatus": "verified | partially_verified | inconclusive",
  "recommendedNextSteps": ["safe next steps"],
  "repairApplied": false
}

INCIDENT: ${incident}
INITIAL MEMORIES: ${JSON.stringify(initialMemories)}
PLAN: ${JSON.stringify(plan)}
ACTUAL TOOL RESULTS: ${JSON.stringify(toolResults)}`
            }
          ]
        }
      ]);

      const response = {
        runId: randomUUID(),
        userId,
        incident,
        mode: "gemini_agent_workflow",
        agents: [
          { name: "Research Agent", status: "completed" },
          { name: "Planning Agent", status: "completed" },
          { name: "Safe Tool Runner", status: "completed" },
          { name: "Verification Agent", status: "completed" },
        ],
        research: {
          evidence: initialMemories,
          count: initialMemories.length,
        },
        plan,
        toolResults,
        verification: {
          ...verification,
          repairApplied: false,
        },
        createdAt: new Date().toISOString(),
      };

      // Persist a concise run record in FalkorDB.
      // MERGE on runId prevents duplicate writes if the same runId is retried.
      await graph.query(
        `MERGE (r:AgentRun {id: $id})
         SET r.userId = $userId,
             r.incident = $incident,
             r.conclusion = $conclusion,
             r.status = $status,
             r.createdAt = $createdAt
         RETURN r.id AS id`,
        {
          params: {
            id: response.runId,
            userId,
            incident,
            conclusion: String(verification.conclusion || "").slice(0, 2000),
            status: String(
              verification.verificationStatus || "inconclusive"
            ),
            createdAt: response.createdAt,
          },
        }
      );

      return res.status(200).json(response);
    } catch (error) {
      console.error("Autonomous agent failed:", error.message);

      return res.status(500).json({
        error: "Autonomous investigation failed.",
        detail: error.message,
        hint: "Check backend logs and confirm the configured Gemini model is available.",
      });
    }
  };
}

export { createAutonomousHandler }; 
