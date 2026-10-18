
const API_URL = "http://localhost:5000";

async function request(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.error || `Request failed (${response.status})`
    );
  }

  return data;
}

// Agents
export async function getAgents() {
  const data = await request("/api/agents");
  return data.agents || [];
}

// Persistent memories
export async function getMemories(userId = "demo-user") {
  return request(
    `/api/memory?userId=${encodeURIComponent(userId)}`
  );
}

export async function saveMemory(memory) {
  return request("/api/memory", {
    method: "POST",
    body: JSON.stringify(memory),
  });
}

// Autonomous Gemini agent
export async function runAutonomousAgent(
  incident,
  userId = "demo-user"
) {
  return request("/api/agents/autonomous", {
    method: "POST",
    body: JSON.stringify({ userId, incident }),
  });
}

// Investigation workflow
export async function investigateIncident(
  incident,
  userId = "demo-user"
) {
  return request("/api/workflow/investigate", {
    method: "POST",
    body: JSON.stringify({ userId, incident }),
  });
}

export async function getInvestigation(
  id,
  userId = "demo-user"
) {
  return request(
    `/api/investigations/${encodeURIComponent(id)}?userId=${encodeURIComponent(userId)}`
  );
}

// Project context
export async function getProjectContext() {
  return request("/api/knowledge/context");
}

// Save knowledge as semantic memory
export async function saveKnowledge({
  content,
  userId = "demo-user",
  sourceType = "text",
  source = "manual",
}) {
  return request("/api/knowledge", {
    method: "POST",
    body: JSON.stringify({
      userId,
      content,
      sourceType,
      source,
    }),
  });
}

// Search saved knowledge
export async function searchKnowledge(
  query,
  userId = "demo-user"
) {
  return request(
    `/api/knowledge/search?userId=${encodeURIComponent(userId)}&q=${encodeURIComponent(query)}`
  );
}

// Fetch a public webpage and save it to FalkorDB
export async function importKnowledgeUrl(
  url,
  userId = "demo-user"
) {
  return request("/api/knowledge/url", {
    method: "POST",
    body: JSON.stringify({ userId, url }),
  });
}
