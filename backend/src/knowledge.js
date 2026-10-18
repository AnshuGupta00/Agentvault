
import fs from "node:fs/promises";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { randomUUID } from "node:crypto";

const MAX_CONTENT_LENGTH = 20000;
const MAX_URL_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;

function rowsFrom(result) {
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result)) return result;
  return [];
}

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;

  return (
    p[0] === 0 ||
    p[0] === 10 ||
    p[0] === 127 ||
    p[0] >= 224 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 192 && p[1] === 0 && p[2] === 0) ||
    (p[0] === 198 && (p[1] === 18 || p[1] === 19))
  );
}

function isPrivateIPv6(ip) {
  const value = ip.toLowerCase().split("%")[0];

  // Reject loopback, unspecified, unique-local, link-local and
  // IPv4-mapped IPv6 addresses.
  return (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^fe[89ab]/.test(value) ||
    value.startsWith("::ffff:")
  );
}

async function validatePublicUrl(input) {
  const url = new URL(input);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are allowed.");
  }

  if (url.username || url.password) {
    throw new Error("URLs containing credentials are not allowed.");
  }

  if (url.port && !["80", "443"].includes(url.port)) {
    throw new Error("Only standard HTTP/HTTPS ports are allowed.");
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal"
  ) {
    throw new Error("Local and metadata hosts are blocked.");
  }

  if (net.isIP(host)) {
    const privateAddress =
      net.isIPv4(host) ? isPrivateIPv4(host) : isPrivateIPv6(host);

    if (privateAddress) throw new Error("Private IP addresses are blocked.");
  } else {
    const addresses = await dns.lookup(host, { all: true, verbatim: true });

    if (
      !addresses.length ||
      addresses.some(({ address }) =>
        net.isIPv4(address)
          ? isPrivateIPv4(address)
          : isPrivateIPv6(address)
      )
    ) {
      throw new Error("The hostname resolves to a private or blocked IP.");
    }
  }

  return url;
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|section|article|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export async function loadProjectContext() {
  const configuredPath = process.env.AGENTVAULT_CONTEXT_PATH;
  const contextPath = configuredPath
    ? path.resolve(configuredPath)
    : path.resolve(process.cwd(), "PROJECT_CONTEXT.md");

  try {
    const content = await fs.readFile(contextPath, "utf8");
    return content.slice(0, MAX_CONTENT_LENGTH);
  } catch (error) {
    if (error.code === "ENOENT") {
      return "No PROJECT_CONTEXT.md has been configured yet.";
    }
    throw error;
  }
}

export async function saveKnowledge(graph, {
  userId,
  content,
  sourceType = "text",
  source = "manual",
}) {
  const cleanUserId = String(userId || "").trim();
  const cleanContent = String(content || "").trim();

  if (!cleanUserId) throw new Error("userId is required.");
  if (cleanUserId.length > 100) throw new Error("userId is too long.");
  if (!cleanContent) throw new Error("content is required.");
  if (cleanContent.length > MAX_CONTENT_LENGTH) {
    throw new Error(`Content must be ${MAX_CONTENT_LENGTH} characters or less.`);
  }

  const id = randomUUID();
  const createdAt = Date.now();

  await graph.query(
    `CREATE (m:Memory {
      id: $id,
      userId: $userId,
      type: 'semantic',
      content: $content,
      sourceType: $sourceType,
      source: $source,
      createdAt: $createdAt
    })`,
    {
      params: {
        id,
        userId: cleanUserId,
        content: cleanContent,
        sourceType: String(sourceType).slice(0, 40),
        source: String(source).slice(0, 2000),
        createdAt,
      },
    }
  );

  return {
    id,
    userId: cleanUserId,
    type: "semantic",
    content: cleanContent,
    sourceType,
    source,
    createdAt,
  };
}

export async function searchKnowledge(graph, userId, query, limit = 8) {
  const terms = [
    ...new Set(String(query || "").toLowerCase().match(/[a-z0-9_-]+/g) || []),
  ].filter((term) => term.length > 2).slice(0, 12);

  if (!terms.length) return [];

  const result = await graph.query(
    `MATCH (m:Memory {userId: $userId, type: 'semantic'})
     WHERE any(term IN $terms WHERE
       toLower(coalesce(m.content, '')) CONTAINS term)
     RETURN m.id AS id,
            m.content AS content,
            m.sourceType AS sourceType,
            m.source AS source,
            m.createdAt AS createdAt
     ORDER BY m.createdAt DESC
     LIMIT $limit`,
    { params: { userId, terms, limit } }
  );

  return rowsFrom(result);
}

export async function readPublicUrl(input) {
  let url = await validatePublicUrl(input);

  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt++) {
    // Revalidate every redirect before following it.
    await validatePublicUrl(url.href);

    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: {
        "User-Agent": "AgentVault-KnowledgeReader/1.0",
        Accept: "text/html,text/plain,application/json",
      },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect response had no Location header.");
      if (attempt === MAX_REDIRECTS) throw new Error("Too many redirects.");
      url = new URL(location, url);
      continue;
    }

    if (!response.ok) {
      throw new Error(`URL returned HTTP ${response.status}.`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!/(text\/html|text\/plain|application\/json|application\/xhtml\+xml)/i.test(contentType)) {
      throw new Error("This URL does not return supported text, HTML, or JSON content.");
    }

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_URL_BYTES) {
      throw new Error("Webpage is larger than the 1 MB limit.");
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("Could not read webpage body.");

    const chunks = [];
    let total = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        total += value.byteLength;
        if (total > MAX_URL_BYTES) {
          await reader.cancel();
          throw new Error("Webpage exceeded the 1 MB limit.");
        }

        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const raw = bytes.toString("utf8");
    const content = /html|xhtml/i.test(contentType)
      ? htmlToText(raw)
      : raw;

    if (!content.trim()) throw new Error("No readable text was found on the page.");

    return {
      url: url.href,
      title: content.slice(0, 120),
      content: content.slice(0, MAX_CONTENT_LENGTH),
      contentType,
    };
  }

  throw new Error("Could not fetch the URL.");
}
