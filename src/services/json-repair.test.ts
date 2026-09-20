import { describe, it, expect } from "vitest";
import { safeParseJson } from "./json-repair.js";

describe("JSON Repair & Safe Parser", () => {
  it("parses valid JSON", () => {
    const raw = '{"hello": "world", "status": 200}';
    expect(safeParseJson(raw)).toEqual({ hello: "world", status: 200 });
  });

  it("strips markdown json code fences", () => {
    const raw = `\`\`\`json
{
  "triage": "done",
  "score": 99
}
\`\`\``;
    expect(safeParseJson(raw)).toEqual({ triage: "done", score: 99 });
  });

  it("extracts embedded JSON from explanatory text", () => {
    const raw = `Here is the requested analysis:
{
  "summary": "Found 1 security issue",
  "files": []
}
Hope this helps!`;
    expect(safeParseJson(raw)).toEqual({ summary: "Found 1 security issue", files: [] });
  });

  it("repairs trailing commas", () => {
    const raw = '{"a": 1, "b": 2, "c": [1, 2, ], }';
    expect(safeParseJson(raw)).toEqual({ a: 1, b: 2, c: [1, 2] });
  });

  it("recovers truncated JSON objects and arrays", () => {
    const truncated = '{"summary": "Incomplete output", "items": [{"id": 1, "name": "first"}, {"id": 2';
    const result = safeParseJson<any>(truncated);
    expect(result.summary).toBe("Incomplete output");
    expect(result.items).toHaveLength(2);
    expect(result.items[0].name).toBe("first");
  });

  it("uses fallback if JSON cannot be repaired", () => {
    const raw = "Totally not json";
    expect(safeParseJson(raw, { default: true })).toEqual({ default: true });
  });
});
