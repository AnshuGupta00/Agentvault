
import { useEffect, useState } from "react";
import { getMemories } from "./api";

export default function MemoryList() {
  const [memories, setMemories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    getMemories("demo-user")
      .then(setMemories)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p>Loading memories...</p>;
  if (error) return <p>Error: {error}</p>;

  return (
    <section>
      <h2>Saved Memories ({memories.length})</h2>

      {memories.length === 0 ? (
        <p>No memories found for demo-user.</p>
      ) : (
        memories.map((memory, index) => (
          <article key={memory.id || index}>
            <strong>{memory.type || "Memory"}</strong>
            <p>{memory.content || "No content available"}</p>
          </article>
        ))
      )}
    </section>
  );
}

