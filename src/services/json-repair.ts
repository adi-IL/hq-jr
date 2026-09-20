/**
 * Balances and auto-closes truncated JSON strings, objects, and arrays.
 */
function balanceTruncatedJson(str: string): string {
  let inString = false;
  let isEscaped = false;
  const stack: string[] = [];

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === "\\") {
        isEscaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" && stack[stack.length - 1] === "{") {
      stack.pop();
    } else if (ch === "]" && stack[stack.length - 1] === "[") {
      stack.pop();
    }
  }

  let repaired = str.trim();

  // If terminated inside a string, close the string quote
  if (inString) {
    if (repaired.endsWith("\\")) {
      repaired = repaired.slice(0, -1);
    }
    repaired += '"';
  }

  // Strip trailing partial keys or dangling commas
  repaired = repaired.replace(/,\s*$/, "").replace(/:\s*$/, ": null");

  // Close open arrays and objects in reverse order
  while (stack.length > 0) {
    const open = stack.pop();
    repaired += open === "{" ? "}" : "]";
  }

  return repaired;
}

/**
 * Resilient JSON parsing helper that extracts and repairs JSON from LLM outputs.
 */
export function safeParseJson<T = unknown>(raw: string, fallback?: T): T {
  if (!raw || raw.trim().length === 0) {
    if (fallback !== undefined) return fallback;
    throw new Error("Cannot parse empty JSON string");
  }

  let cleaned = raw.trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Continue to repair attempts
  }

  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/i);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
    try {
      return JSON.parse(cleaned);
    } catch {}
  }

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  try {
    const balanced = balanceTruncatedJson(cleaned);
    return JSON.parse(balanced);
  } catch {}

  try {
    const noTrailingCommas = balanceTruncatedJson(cleaned).replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(noTrailingCommas);
  } catch {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`Failed to repair and parse JSON: ${raw.slice(0, 100)}...`);
  }
}
