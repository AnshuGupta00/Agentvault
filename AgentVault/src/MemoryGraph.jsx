import React from "react";
import "./MemoryGraph.css";

function shorten(value, max = 30) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export default function MemoryGraph({ evidence = [] }) {
  const items = Array.isArray(evidence) ? evidence : [];

  if (!items.length) {
    return (
      <section className="graph-visual-panel">
        <h3>Memory relationship graph</h3>
        <p className="graph-visual-description">
          Run an investigation to visualize the returned memory evidence.
        </p>
      </section>
    );
  }

  const width = 720;
  const height = Math.max(240, items.length * 105 + 60);
  const centerX = 360;
  const centerY = height / 2;

  const nodes = items.map((item, index) => {
    const isNeighbor = item.retrievalPath === "GRAPH_NEIGHBOR";
    const y = 45 + index * 105;

    return {
      ...item,
      label: shorten(item.content || item.type || "Memory", 34),
      x: isNeighbor ? 535 : 185,
      y,
      isNeighbor,
      nodeId: item.id || `memory-${index}`,
    };
  });

  return (
    <section className="graph-visual-panel">
      <h3>Memory relationship graph</h3>
      <p className="graph-visual-description">
        Visualization of evidence returned by the investigation API.
        Lines show the returned connection metadata; this is not a full
        dump of every node in FalkorDB.
      </p>

      <div className="graph-visual-scroll">
        <svg
          className="graph-visual-svg"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Memory evidence relationship graph"
        >
          <defs>
            <marker
              id="memory-arrow"
              markerWidth="8"
              markerHeight="8"
              refX="6"
              refY="3"
              orient="auto"
            >
              <path d="M0,0 L0,6 L6,3 z" fill="#536179" />
            </marker>
          </defs>

          <rect
            x="12"
            y="12"
            width={width - 24}
            height={height - 24}
            rx="12"
            fill="#0c0e14"
            stroke="#272d3c"
          />

          <text x="185" y="30" textAnchor="middle" className="graph-edge-label">
            DIRECT MATCH
          </text>
          <text x="535" y="30" textAnchor="middle" className="graph-edge-label">
            GRAPH NEIGHBOR
          </text>

          {nodes.map((node, index) => {
            const related = node.connectedFrom
              ? nodes.find((candidate) => candidate.id === node.connectedFrom)
              : null;

            const fallback = nodes.find(
              (candidate) =>
                candidate.nodeId !== node.nodeId &&
                candidate.isNeighbor !== node.isNeighbor
            );

            const target = related || fallback;

            if (!target || target.nodeId === node.nodeId) return null;

            return (
              <g key={`edge-${node.nodeId}-${index}`}>
                <line
                  className="graph-edge"
                  x1={node.x}
                  y1={node.y}
                  x2={target.x}
                  y2={target.y}
                  markerEnd="url(#memory-arrow)"
                />
                <text
                  className="graph-edge-label"
                  x={(node.x + target.x) / 2}
                  y={(node.y + target.y) / 2 - 7}
                  textAnchor="middle"
                >
                  {node.relationship || "EVIDENCE"}
                </text>
              </g>
            );
          })}

          {nodes.map((node) => (
            <g key={node.nodeId}>
              <rect
                className={`graph-node ${
                  node.isNeighbor
                    ? "graph-node-neighbor"
                    : "graph-node-direct"
                }`}
                x={node.x - 135}
                y={node.y - 29}
                width="270"
                height="58"
                rx="10"
              />
              <text
                className="graph-node-title"
                x={node.x}
                y={node.y - 5}
                textAnchor="middle"
              >
                {node.type || "memory"} · {node.retrievalPath || "unknown"}
              </text>
              <text
                className="graph-node-subtitle"
                x={node.x}
                y={node.y + 15}
                textAnchor="middle"
              >
                {node.label}
              </text>
            </g>
          ))}
        </svg>
      </div>

      <div className="graph-legend">
        <span className="graph-legend-item">
          <span className="graph-legend-dot direct" />
          Direct match
        </span>
        <span className="graph-legend-item">
          <span className="graph-legend-dot neighbor" />
          Graph neighbor
        </span>
        <span className="graph-legend-item">
          <span className="graph-legend-dot edge" />
          Relationship / evidence link
        </span>
      </div>
    </section>
  );
}
