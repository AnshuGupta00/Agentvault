
import { useCallback, useEffect, useState } from "react";
import {
  getMemories,
  getAgents,
  saveMemory,
  getInvestigation,
  runAutonomousAgent,
} from "./api";

import "./App.css";
import "./handoff-graph.css";
import MemoryList from "./MemoryList";

const USER_ID = "demo-user";
const API_BASE = "http://localhost:5000";
const TYPES = ["episodic", "semantic", "procedural"];

export default function App() {
  const [memories, setMemories] = useState([]);
  const [agents, setAgents] = useState([]);
  const [investigation, setInvestigation] = useState(null);
  const [investigationId, setInvestigationId] = useState("");
  const [investigationResult, setInvestigationResult] = useState(null);

  const [handoffs, setHandoffs] = useState([]);
  const [handoffsLoading, setHandoffsLoading] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState("");
  const [handoffNotice, setHandoffNotice] = useState("");

  const [incident, setIncident] = useState(
    "API returns 401 Unauthorized after deployment. Investigate possible authentication configuration issues."
  );
  const [type, setType] = useState("episodic");
  const [content, setContent] = useState("");

  const [loading, setLoading] = useState(true);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [investigationLoading, setInvestigationLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [investigating, setInvestigating] = useState(false);

  const [error, setError] = useState("");
  const [agentsError, setAgentsError] = useState("");
  const [investigationError, setInvestigationError] = useState("");
  const [runError, setRunError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeSection, setActiveSection] = useState("overview");

  const navigateToSection = (sectionId) => {
    setActiveSection(sectionId);
    document.getElementById(sectionId)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  const loadMemories = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getMemories(USER_ID);
      setMemories(Array.isArray(result) ? result : []);
      setError("");
    } catch (err) {
      setError(err?.message || "Unable to load memories.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAgents = useCallback(async () => {
    setAgentsLoading(true);
    try {
      const result = await getAgents();
      setAgents(Array.isArray(result) ? result : []);
      setAgentsError("");
    } catch (err) {
      setAgentsError(err?.message || "Unable to load agents.");
    } finally {
      setAgentsLoading(false);
    }
  }, []);

  const loadInvestigation = useCallback(
    async (id = investigationId) => {
      if (!id) {
        setInvestigation(null);
        setInvestigationError("");
        setInvestigationLoading(false);
        return;
      }

      setInvestigationLoading(true);
      try {
        const result = await getInvestigation(id, USER_ID);
        setInvestigation(result?.investigation ?? result ?? null);
        setInvestigationError("");
      } catch (err) {
        setInvestigation(null);
        setInvestigationError(
          err?.message || "Unable to load investigation."
        );
      } finally {
        setInvestigationLoading(false);
      }
    },
    [investigationId]
  );

  const loadHandoffs = useCallback(
    async (id = investigationId) => {
      if (!id) {
        setHandoffs([]);
        return;
      }

      setHandoffsLoading(true);
      try {
        const response = await fetch(
          `${API_BASE}/api/handoffs?userId=${encodeURIComponent(
            USER_ID
          )}&investigationId=${encodeURIComponent(id)}`
        );

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.error || "Could not load handoffs.");
        }

        setHandoffs(Array.isArray(data?.handoffs) ? data.handoffs : []);
        setHandoffError("");
      } catch (err) {
        setHandoffError(err?.message || "Could not load handoffs.");
      } finally {
        setHandoffsLoading(false);
      }
    },
    [investigationId]
  );

  const refreshDashboard = useCallback(async () => {
    await Promise.all([
      loadMemories(),
      loadAgents(),
      loadInvestigation(),
      loadHandoffs(),
    ]);
  }, [loadMemories, loadAgents, loadInvestigation, loadHandoffs]);

  useEffect(() => {
    void refreshDashboard();
  }, [refreshDashboard]);

  async function handleSubmit(event) {
    event.preventDefault();

    if (!content.trim()) {
      setError("Please enter memory content.");
      return;
    }

    setSaving(true);
    setError("");
    setNotice("");

    try {
      await saveMemory({
        userId: USER_ID,
        type,
        content: content.trim(),
      });

      setContent("");
      setNotice("Memory saved successfully.");
      await loadMemories();
    } catch (err) {
      setError(err?.message || "Unable to save memory.");
    } finally {
      setSaving(false);
    }
  }

  // Calls the Gemini-powered autonomous endpoint.
  async function handleInvestigate(event) {
    event.preventDefault();

    if (!incident.trim()) {
      setRunError("Enter an incident description first.");
      return;
    }

    setInvestigating(true);
    setRunError("");
    setInvestigationResult(null);
    setHandoffError("");
    setHandoffNotice("");

    try {
      const result = await runAutonomousAgent(incident.trim(), USER_ID);
      setInvestigationResult(result);

      // AgentRun ID is not necessarily an Investigation ID.
      // Only load saved investigation/handoffs when the API
      // explicitly returns an investigation ID.
      const savedInvestigationId =
        result?.investigationId || result?.id;

      if (savedInvestigationId) {
        setInvestigationId(savedInvestigationId);
        await Promise.all([
          loadMemories(),
          loadInvestigation(savedInvestigationId),
          loadHandoffs(savedInvestigationId),
        ]);
      } else {
        await loadMemories();
      }
    } catch (err) {
      console.error("Autonomous agent failed:", err);
      setRunError(err?.message || "Autonomous investigation failed.");
    } finally {
      setInvestigating(false);
    }
  }

  async function createResearchHandoff() {
    const evidence = investigationResult?.research?.evidence || [];
    const evidenceIds = [
      ...new Set(evidence.map((item) => item?.id).filter(Boolean)),
    ];
    const currentId =
      investigationResult?.investigationId || investigationId;

    if (!currentId) {
      setHandoffError(
        "This autonomous run has no saved investigation ID. Create a saved workflow investigation before creating a handoff."
      );
      return;
    }

    if (!evidenceIds.length) {
      setHandoffError(
        "No evidence IDs were returned by Research Agent."
      );
      return;
    }

    const findings = [
      `Incident: ${investigationResult?.incident || incident}.`,
      `Research Agent retrieved ${evidenceIds.length} evidence memories.`,
      evidence
        .map((item) => safeText(item.content || item.text || ""))
        .filter(Boolean)
        .join(" ")
        .slice(0, 2500),
      "Root cause has not been verified.",
    ].join(" ");

    setHandoffBusy(true);
    setHandoffError("");
    setHandoffNotice("");

    try {
      const response = await fetch(`${API_BASE}/api/handoffs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: USER_ID,
          investigationId: currentId,
          findings,
          evidenceIds,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Could not create handoff.");
      }

      setInvestigationId(currentId);
      setHandoffNotice(`Handoff saved: ${data.handoffId}`);
      await loadHandoffs(currentId);
    } catch (err) {
      setHandoffError(err?.message || "Could not create handoff.");
    } finally {
      setHandoffBusy(false);
    }
  }

  async function receiveResearchHandoff(handoffId) {
    setHandoffBusy(true);
    setHandoffError("");
    setHandoffNotice("");

    try {
      const response = await fetch(
        `${API_BASE}/api/agents/planning/handoff`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: USER_ID, handoffId }),
        }
      );

      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          data?.error || "Planning Agent could not receive handoff."
        );
      }

      setHandoffNotice(
        `Planning Agent received handoff ${handoffId}.`
      );
      await loadHandoffs(investigationId);
    } catch (err) {
      setHandoffError(err?.message || "Could not receive handoff.");
    } finally {
      setHandoffBusy(false);
    }
  }

  const countFor = (value) =>
    memories.filter((memory) => memory.type === value).length;

  const research = investigationResult?.research;
  const planning =
    investigationResult?.planning ?? investigationResult?.plan;
  const toolResults =
    investigationResult?.toolResults ??
    investigationResult?.execution;
  const verification = investigationResult?.verification;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark">A</div>
        <div className="brand-name">AgentVault</div>
        <p className="sidebar-caption">Agent memory and coordination</p>

        <button
          type="button"
          className={`nav-item ${activeSection === "overview" ? "active" : ""}`}
          onClick={() => navigateToSection("overview")}
        >
          Overview
        </button>

        <button
          type="button"
          className={`nav-item ${activeSection === "memory-store" ? "active" : ""}`}
          onClick={() => navigateToSection("memory-store")}
        >
          Memory store
        </button>

        <button
          type="button"
          className={`nav-item ${activeSection === "agent-network" ? "active" : ""}`}
          onClick={() => navigateToSection("agent-network")}
        >
          Agent network
        </button>

        <div className="sidebar-bottom">
          <span className="status-dot" />
          Local development
        </div>
      </aside>

      <section className="main-content" id="overview">
        <header className="topbar">
          <div>
            <p className="eyebrow">WORKSPACE / OVERVIEW</p>
            <h1>Agent memory workspace</h1>
            <p className="muted">
              Store, inspect, and retrieve the knowledge your agents use.
            </p>
          </div>

          <button
            type="button"
            className="secondary-button"
            onClick={refreshDashboard}
            disabled={
              loading || agentsLoading || investigationLoading
            }
          >
            {loading || agentsLoading || investigationLoading
              ? "Refreshing..."
              : "Refresh"}
          </button>
        </header>

        {error && <p className="error-message">{error}</p>}

        <section className="stats-grid">
          <StatCard label="Total memories" value={memories.length} />
          <StatCard label="Episodic" value={countFor("episodic")} />
          <StatCard label="Semantic" value={countFor("semantic")} />
          <StatCard label="Procedural" value={countFor("procedural")} />
        </section>

        {/* Autonomous agent chat / incident input */}
        <section className="panel investigation-panel">
          <div className="panel-heading">
            <div>
              <h2>Autonomous Agent Chat</h2>
              <p className="muted">
                Describe an incident. The agent researches memory,
                proposes a plan, runs approved read-only checks, and
                returns verification findings.
              </p>
            </div>
            <span className="tag">Gemini Agent</span>
          </div>

          <form className="memory-form" onSubmit={handleInvestigate}>
            <label htmlFor="incident-description">
              What should the agent investigate?
            </label>

            <textarea
              id="incident-description"
              value={incident}
              onChange={(event) => setIncident(event.target.value)}
              rows={4}
              maxLength={3000}
              required
              placeholder="Describe the incident..."
            />

            <button
              type="submit"
              className="primary-button"
              disabled={investigating}
            >
              {investigating
                ? "Agent investigating..."
                : "Send to Autonomous Agent"}
            </button>
          </form>

          {runError && <p className="error-message">{runError}</p>}

          {investigating && (
            <p className="muted">
              The agent is researching stored memories and running
              approved checks. Please wait...
            </p>
          )}

          {investigationResult && (
            <div className="workflow-results">
              <h3 className="subsection-title">Agent response</h3>

              <p className="simulation-notice">
                {investigationResult.message ||
                  "Investigation completed. No production repair was performed."}
              </p>

              {investigationResult.runId && (
                <p className="memory-id">
                  Run ID: <code>{safeText(investigationResult.runId)}</code>
                </p>
              )}

              <div className="workflow-step">
                <h3>1. Research Agent</h3>
                <p className="muted">
                  Evidence found:{" "}
                  {research?.count ??
                    research?.evidenceCount ??
                    research?.evidence?.length ??
                    0}
                </p>

                {Array.isArray(research?.evidence) &&
                research.evidence.length > 0 ? (
                  <div className="memory-list">
                    {research.evidence.map((item, index) => (
                      <article
                        className="memory-row graph-evidence-card"
                        key={item.id || index}
                      >
                        <div className="graph-evidence-header">
                          <span
                            className={`memory-type ${item.type || "unknown"}`}
                          >
                            {item.type || "evidence"}
                          </span>

                          <span
                            className={`retrieval-badge ${
                              item.retrievalPath === "GRAPH_NEIGHBOR"
                                ? "graph-path"
                                : "direct-path"
                            }`}
                          >
                            {item.retrievalPath || "DIRECT_OR_UNSPECIFIED"}
                          </span>
                        </div>

                        <p className="graph-evidence-content">
                          <SafeText value={item.content ?? item.text ?? item} />
                        </p>

                        <p className="memory-id">
                          Memory ID: <SafeText value={item.id || "Unavailable"} />
                        </p>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="muted">
                    No matching evidence was returned by the agent.
                  </p>
                )}
              </div>

              <MemoryGraph evidence={research?.evidence || []} />

              <div className="workflow-step">
                <h3>2. Agent Plan</h3>
                <pre className="agent-json-output">
                  {JSON.stringify(
                    planning ?? "No plan returned.",
                    null,
                    2
                  )}
                </pre>
              </div>

              <div className="workflow-step">
                <h3>3. Approved Tool Results</h3>

                {Array.isArray(toolResults) && toolResults.length > 0 ? (
                  <div className="memory-list">
                    {toolResults.map((item, index) => (
                      <article
                        className="memory-row"
                        key={item.tool || index}
                      >
                        <strong>
                          <SafeText value={item.tool || `Tool ${index + 1}`} />
                        </strong>

                        <p>
                          <strong>Result:</strong>{" "}
                          {item.success ? "Success" : "Failed"}
                        </p>

                        <pre className="agent-json-output">
                          {JSON.stringify(item, null, 2)}
                        </pre>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="muted">No tool results returned.</p>
                )}
              </div>

              <div className="workflow-step">
                <h3>4. Verification</h3>
                <pre className="agent-json-output">
                  {JSON.stringify(
                    verification ?? {
                      status: "Not returned",
                      repairApplied: false,
                    },
                    null,
                    2
                  )}
                </pre>

                <p className="simulation-notice">
                  Safety note: the agent does not apply real production
                  fixes. Recommendations and checks should be reviewed
                  before taking action.
                </p>
              </div>
            </div>
          )}
        </section>

        {/* Saved investigation */}
        <section className="panel investigation-panel">
          <div className="panel-heading">
            <div>
              <h2>Saved graph investigation</h2>
              <p className="muted">
                Stored investigation and linked evidence.
              </p>
            </div>

            <button
              type="button"
              className="secondary-button"
              onClick={() => loadInvestigation()}
              disabled={investigationLoading || !investigationId}
            >
              {investigationLoading ? "Loading..." : "Refresh investigation"}
            </button>
          </div>

          {!investigationId ? (
            <p className="empty-state">
              No saved investigation ID is available. An autonomous run
              does not automatically mean a saved Investigation record exists.
            </p>
          ) : investigationLoading ? (
            <p className="muted">Loading investigation...</p>
          ) : investigationError ? (
            <p className="error-message">{investigationError}</p>
          ) : investigation ? (
            <>
              <div className="incident-summary">
                <div>
                  <span className="incident-label">Incident</span>
                  <h3>
                    <SafeText
                      value={investigation.incident || "Unnamed incident"}
                    />
                  </h3>
                  <p className="muted">
                    Investigation ID:{" "}
                    <SafeText
                      value={
                        investigation.id ||
                        investigation.investigationId ||
                        investigationId
                      }
                    />
                  </p>
                </div>

                <span className="investigation-status">
                  <SafeText value={investigation.status || "Unknown status"} />
                </span>
              </div>

              <p className="simulation-notice">
                Safe simulation only. No production fix was applied or verified.
              </p>

              <h3 className="subsection-title">
                Participating agents ({investigation.agents?.length || 0})
              </h3>

              {investigation.agents?.length ? (
                <div className="investigation-agent-grid">
                  {investigation.agents.map((agent, index) => (
                    <AgentCard
                      key={agent.name || index}
                      name={agent.name}
                      role={agent.role}
                      number={String(index + 1).padStart(2, "0")}
                    />
                  ))}
                </div>
              ) : (
                <p className="muted">No participating agents returned.</p>
              )}

              <div className="panel-heading evidence-heading">
                <h3>Linked evidence memories</h3>
                <span className="tag">
                  {investigation.memories?.length || 0} linked
                </span>
              </div>

              {investigation.memories?.length ? (
                <div className="memory-list">
                  {investigation.memories.map((memory, index) => (
                    <article className="memory-row" key={memory.id || index}>
                      <span className={`memory-type ${memory.type || "unknown"}`}>
                        {memory.type || "unknown"}
                      </span>
                      <p className="evidence-content">
                        <EvidenceContent content={memory.content} />
                      </p>
                      <span className="memory-id">
                        {safeText(memory.id || "ID unavailable")}
                      </span>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="empty-state">
                  No linked evidence memories returned.
                </p>
              )}
            </>
          ) : (
            <p className="empty-state">No investigation data available.</p>
          )}
        </section>

        {/* Handoffs */}
        <section className="panel handoff-panel">
          <div className="panel-heading">
            <div>
              <h2>Agent handoff network</h2>
              <p className="muted">
                Persisted Research → Planning handoffs from FalkorDB.
              </p>
            </div>

            <button
              type="button"
              className="secondary-button"
              onClick={() => loadHandoffs()}
              disabled={!investigationId || handoffsLoading}
            >
              {handoffsLoading ? "Loading..." : "Refresh handoffs"}
            </button>
          </div>

          <div className="handoff-graph-wrap">
            <HandoffGraph handoffs={handoffs} />
          </div>

          <div className="handoff-toolbar">
            <p className="muted">
              Current investigation:{" "}
              <code>{investigationId || "No saved investigation ID"}</code>
            </p>

            <button
              type="button"
              className="primary-button"
              onClick={createResearchHandoff}
              disabled={handoffBusy || !investigationResult}
            >
              {handoffBusy
                ? "Working..."
                : "Create Research → Planning handoff"}
            </button>
          </div>

          {handoffNotice && (
            <p className="success-message">{handoffNotice}</p>
          )}
          {handoffError && (
            <p className="error-message">{handoffError}</p>
          )}

          {handoffsLoading ? (
            <p className="muted">Loading persisted handoffs...</p>
          ) : handoffs.length ? (
            <div className="memory-list">
              {handoffs.map((handoff) => (
                <article
                  className="memory-row handoff-row"
                  key={handoff.handoffId}
                >
                  <div className="handoff-row-main">
                    <strong>
                      {handoff.sourceAgent || "Research Agent"} →{" "}
                      {handoff.targetAgent || "Planning Agent"}
                    </strong>
                    <span
                      className={`handoff-status ${
                        handoff.status === "received" ? "received" : "pending"
                      }`}
                    >
                      {handoff.status || "unknown"}
                    </span>
                  </div>

                  <p>
                    <SafeText value={handoff.findings || "No findings attached."} />
                  </p>
                  <p className="memory-id">
                    Handoff ID: <code>{handoff.handoffId}</code>
                  </p>
                  <p className="memory-id">
                    Received at:{" "}
                    {handoff.receivedAt
                      ? new Date(Number(handoff.receivedAt)).toLocaleString()
                      : "Not received yet"}
                  </p>

                  {handoff.status !== "received" && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={handoffBusy}
                      onClick={() =>
                        receiveResearchHandoff(handoff.handoffId)
                      }
                    >
                      {handoffBusy
                        ? "Receiving..."
                        : "Receive as Planning Agent"}
                    </button>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <p className="empty-state">
              No handoffs found for this investigation yet.
            </p>
          )}
        </section>

        {/* Memory form and agents */}
        <section className="content-grid">
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Create a memory</h2>
                <p className="muted">Save knowledge to FalkorDB.</p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="memory-form">
              <label htmlFor="memory-type">Memory type</label>
              <select
                id="memory-type"
                value={type}
                onChange={(event) => setType(event.target.value)}
              >
                {TYPES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>

              <label htmlFor="memory-content">Memory content</label>
              <textarea
                id="memory-content"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                rows={5}
                maxLength={4000}
                required
              />

              <button className="primary-button" disabled={saving}>
                {saving ? "Saving..." : "Save memory"}
              </button>
            </form>

            {notice && <p className="success-message">{notice}</p>}
            {error && <p className="error-message">{error}</p>}
          </section>

          <section className="panel" id="agent-network">
            <div className="panel-heading">
              <div>
                <h2>Agent network</h2>
                <p className="muted">Agents loaded from FalkorDB.</p>
              </div>
              <span className="tag">FalkorDB</span>
            </div>

            {agentsLoading ? (
              <p className="muted">Loading agents...</p>
            ) : agentsError ? (
              <p className="error-message">{agentsError}</p>
            ) : agents.length ? (
              agents.map((agent, index) => (
                <AgentCard
                  key={agent.name || index}
                  name={agent.name}
                  role={agent.role}
                  number={String(index + 1).padStart(2, "0")}
                />
              ))
            ) : (
              <p className="empty-state">No agents found.</p>
            )}
          </section>
        </section>

        <section className="panel memory-panel" id="memory-store">
          <div className="panel-heading">
            <div>
              <h2>Memory store</h2>
              <p className="muted">Memories returned by the current API.</p>
            </div>
            <span className="tag">{memories.length} loaded</span>
          </div>

          {loading ? (
            <p className="muted">Loading memories...</p>
          ) : memories.length ? (
            <div className="memory-list">
              {memories.map((memory, index) => (
                <article className="memory-row" key={memory.id || index}>
                  <span className={`memory-type ${memory.type || "unknown"}`}>
                    {memory.type || "unknown"}
                  </span>
                  <p>
                    <SafeText value={memory.content || "No content"} />
                  </p>
                  <span className="memory-id">
                    {safeText(memory.userId || "legacy memory")}
                  </span>
                </article>
              ))}
            </div>
          ) : (
            <p className="empty-state">No memories returned.</p>
          )}
        </section>

        <footer className="footer">
          AgentVault · Development workspace · Data stored in FalkorDB
        </footer>
      </section>
    </main>
  );
}

function MemoryGraph({ evidence = [] }) {
  const [selectedId, setSelectedId] = useState(null);

  const nodes = evidence
    .filter((item) => item && item.id)
    .filter(
      (item, index, all) =>
        all.findIndex((other) => other.id === item.id) === index
    )
    .slice(0, 12)
    .map((item, index) => ({
      ...item,
      x: index % 2 === 0 ? 190 : 570,
      y: 60 + Math.floor(index / 2) * 125,
    }));

  const edges = [];

  for (const node of nodes) {
    if (!node.connectedFrom) continue;

    const source = nodes.find((item) => item.id === node.connectedFrom);
    if (!source || source.id === node.id) continue;

    const exists = edges.some(
      (edge) =>
        (edge.from === node.id && edge.to === source.id) ||
        (edge.from === source.id && edge.to === node.id)
    );

    if (!exists) {
      edges.push({
        from: source.id,
        to: node.id,
        label: node.relationship || "RELATED_TO",
      });
    }
  }

  const selected = nodes.find((node) => node.id === selectedId);
  const height = Math.max(260, Math.ceil(nodes.length / 2) * 125 + 30);

  return (
    <section className="memory-graph-panel">
      <div className="panel-heading">
        <div>
          <h3>Memory relationship graph</h3>
          <p className="muted">
            Select a node to inspect its evidence and links.
          </p>
        </div>
        <span className="tag">
          {nodes.length} nodes · {edges.length} links
        </span>
      </div>

      {!nodes.length ? (
        <p className="empty-state">
          No graph evidence nodes were returned for this run.
        </p>
      ) : (
        <>
          <div className="memory-graph-legend">
            <span><i className="legend-dot episodic-dot" /> Episodic</span>
            <span><i className="legend-dot semantic-dot" /> Semantic</span>
            <span><i className="legend-dot procedural-dot" /> Procedural</span>
            <span><i className="legend-line" /> Relationship</span>
          </div>

          <div className="memory-graph-canvas">
            <svg
              className="memory-graph-svg"
              viewBox={`0 0 760 ${height}`}
              role="img"
              aria-label="Memory relationship visualization"
            >
              {edges.map((edge, index) => {
                const from = nodes.find((node) => node.id === edge.from);
                const to = nodes.find((node) => node.id === edge.to);
                if (!from || !to) return null;

                return (
                  <g key={`${edge.from}-${edge.to}-${index}`}>
                    <line
                      x1={from.x}
                      y1={from.y + 30}
                      x2={to.x}
                      y2={to.y + 30}
                      className={`memory-graph-edge ${
                        selectedId === from.id || selectedId === to.id
                          ? "edge-selected"
                          : ""
                      }`}
                    />
                    <text
                      x={(from.x + to.x) / 2}
                      y={(from.y + to.y) / 2 + 28}
                      className="memory-graph-edge-label"
                      textAnchor="middle"
                    >
                      {edge.label}
                    </text>
                  </g>
                );
              })}

              {nodes.map((node) => (
                <g
                  key={node.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Select ${node.type || "memory"} node`}
                  aria-pressed={selectedId === node.id}
                  className="memory-graph-node"
                  onClick={() => setSelectedId(node.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedId(node.id);
                    }
                  }}
                >
                  <rect
                    x={node.x - 145}
                    y={node.y}
                    width="290"
                    height="62"
                    rx="10"
                    className={`node-rect node-${node.type || "unknown"} ${
                      selectedId === node.id ? "node-selected" : ""
                    }`}
                  />
                  <text
                    x={node.x}
                    y={node.y + 19}
                    textAnchor="middle"
                    className="memory-graph-node-type"
                  >
                    {(node.type || "memory").toUpperCase()} ·{" "}
                    {node.retrievalPath === "GRAPH_NEIGHBOR"
                      ? "GRAPH"
                      : "DIRECT"}
                  </text>
                  <text
                    x={node.x}
                    y={node.y + 42}
                    textAnchor="middle"
                    className="memory-graph-node-label"
                  >
                    {truncateText(node.content || node.id, 38)}
                  </text>
                </g>
              ))}
            </svg>
          </div>

          {selected && (
            <div className="graph-node-details">
              <h4>Selected memory</h4>
              <p><strong>Type:</strong> {selected.type || "unknown"}</p>
              <p>
                <strong>Retrieval:</strong>{" "}
                {selected.retrievalPath || "Not provided"}
              </p>
              <p>
                <strong>Relationship:</strong>{" "}
                {selected.relationship || "No relationship metadata"}
              </p>
              <p>
                <strong>Content:</strong>{" "}
                <SafeText value={selected.content} />
              </p>
              <p className="graph-detail-id">
                <strong>Memory ID:</strong> {selected.id}
              </p>
              {selected.connectedFrom && (
                <p className="graph-detail-id">
                  <strong>Connected from:</strong> {selected.connectedFrom}
                </p>
              )}
              <button
                type="button"
                className="secondary-button"
                onClick={() => setSelectedId(null)}
              >
                Clear selection
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function HandoffGraph({ handoffs = [] }) {
  const latest = handoffs[0];
  const received = latest?.status === "received";

  return (
    <svg
      className="handoff-graph-svg"
      viewBox="0 0 900 230"
      role="img"
      aria-label="Research Agent to Planning Agent handoff graph"
    >
      <defs>
        <marker
          id="handoff-arrow"
          markerWidth="10"
          markerHeight="10"
          refX="8"
          refY="3"
          orient="auto"
        >
          <path
            d="M0,0 L0,6 L9,3 z"
            fill={received ? "#16a34a" : "#94a3b8"}
          />
        </marker>
      </defs>

      <line
        x1="245"
        y1="105"
        x2="350"
        y2="105"
        stroke={received ? "#16a34a" : "#94a3b8"}
        strokeWidth="3"
        markerEnd="url(#handoff-arrow)"
      />
      <line
        x1="550"
        y1="105"
        x2="655"
        y2="105"
        stroke={received ? "#16a34a" : "#94a3b8"}
        strokeWidth="3"
        markerEnd="url(#handoff-arrow)"
      />

      <text x="297" y="83" textAnchor="middle" className="handoff-edge-label">
        HANDED_OFF
      </text>
      <text x="602" y="83" textAnchor="middle" className="handoff-edge-label">
        ASSIGNED_TO
      </text>

      <rect x="25" y="55" width="220" height="100" rx="14" className="handoff-node agent" />
      <text x="135" y="94" textAnchor="middle" className="handoff-node-title">
        Research Agent
      </text>
      <text x="135" y="120" textAnchor="middle" className="handoff-node-subtitle">
        Findings + evidence
      </text>

      <rect
        x="350"
        y="55"
        width="200"
        height="100"
        rx="14"
        className={`handoff-node record ${received ? "done" : "waiting"}`}
      />
      <text x="450" y="94" textAnchor="middle" className="handoff-node-title">
        AgentHandoff
      </text>
      <text x="450" y="120" textAnchor="middle" className="handoff-node-subtitle">
        {latest?.status || "awaiting handoff"}
      </text>

      <rect x="655" y="55" width="220" height="100" rx="14" className="handoff-node agent" />
      <text x="765" y="94" textAnchor="middle" className="handoff-node-title">
        Planning Agent
      </text>
      <text x="765" y="120" textAnchor="middle" className="handoff-node-subtitle">
        Receives evidence
      </text>

      <text x="450" y="198" textAnchor="middle" className="handoff-graph-caption">
        {handoffs.length
          ? `${handoffs.length} persisted handoff(s) · latest status: ${latest.status}`
          : "Persisted handoff records will appear here after loading."}
      </text>
    </svg>
  );
}

function truncateText(value, limit = 38) {
  const text = safeText(value);
  return text.length > limit
    ? `${text.slice(0, limit - 3)}...`
    : text;
}

function safeText(value) {
  if (value === null || value === undefined) return "";

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "[Content unavailable]";
  }
}

function SafeText({ value }) {
  return <>{safeText(value)}</>;
}

function EvidenceContent({ content }) {
  if (content === null || content === undefined || content === "") {
    return "No content provided";
  }

  let parsed = content;

  if (typeof content === "string") {
    try {
      parsed = JSON.parse(content);
    } catch {
      return <SafeText value={content} />;
    }
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const fields = ["incident", "recommendation", "outcome"].filter(
      (key) => parsed[key]
    );

    if (fields.length) {
      return (
        <span>
          {fields.map((field) => (
            <span key={field}>
              <strong>
                {field.charAt(0).toUpperCase() + field.slice(1)}:
              </strong>{" "}
              <SafeText value={parsed[field]} />{" "}
            </span>
          ))}
        </span>
      );
    }
  }

  return <SafeText value={parsed} />;
}

function StatCard({ label, value }) {
  return (
    <article className="stat-card">
      <p className="muted">{label}</p>
      <strong>{value}</strong>
    </article>
  );
}

function AgentCard({ name, role, number }) {
  const displayName = safeText(name || "Unnamed Agent");

  return (
    <article className="agent-card">
      <span className="agent-number">{number}</span>
      <div className="agent-avatar">{displayName.charAt(0)}</div>
      <div className="agent-details">
        <strong>{displayName}</strong>
        <span>{safeText(role || "unassigned")}</span>
      </div>
      <span className="agent-indicator" title="Configured agent" />
    </article>
  );
}
