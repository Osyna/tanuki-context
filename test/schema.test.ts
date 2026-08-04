// The advertised tool schema has to satisfy the strictest provider that
// validates it, not just the one we develop against.
//
// Issue #1: `verbatim` was emitted as a union,
// `{"type":["boolean","string"],"enum":[true,false,"lazy"]}`. Anthropic accepts
// it; Moonshot/Kimi rejects the ENTIRE tools list, so the server did not
// degrade to a missing knob, it failed to register at all. Gemini is stricter
// still: its `type` is a single scalar enum, so a union cannot be expressed
// there in any mode. OpenAI only validates `parameters` under `strict: true`.
//
// The first test walks every advertised parameter rather than pinning the one
// that broke, because the next union would be just as invisible here as this
// one was: nothing in our own stack complains.

import { describe, expect, test } from "bun:test";
import { resolveRate } from "../src/cost.ts";
import { weakReader } from "../src/fidelity.ts";
import { toolsList } from "../src/main.ts";
import { parseVerbatim } from "../src/needles.ts";
import { TOOLS, visibleTools } from "../src/tools.ts";

interface Advertised {
  name: string;
  inputSchema: { type?: string; properties?: Record<string, { type?: unknown; enum?: unknown[] }>; required?: string[] };
}

/// The schema as it actually goes on the wire, not the registry it is built
/// from, and for ALL eight tools: the slim default surface hides two, and a
/// bad shape in a hidden one breaks a provider just as hard the moment
/// TANUKI_ALL_TOOLS=1.
function advertised(): Advertised[] {
  // Unchecked cast against our own serializer: the shape is fixed by the
  // function under test, so validating it here would only restate that code.
  const list = toolsList(TOOLS) as { tools: Advertised[] };
  return list.tools;
}

describe("advertised schema is valid for strict providers", () => {
  test("no parameter is a type union", () => {
    const unions: string[] = [];
    for (const t of TOOLS) {
      for (const p of t.params) if (Array.isArray(p.type)) unions.push(`${t.name}.${p.key}`);
    }
    expect(unions).toEqual([]);
  });

  test("every enum member matches its declared type", () => {
    // The old shape also mixed `true`/`false` into a list beside a string,
    // which is what Kimi's message actually objects to.
    const bad: string[] = [];
    for (const t of TOOLS) {
      for (const p of t.params) {
        if (p.values === undefined) continue;
        for (const v of p.values) if (typeof v !== p.type) bad.push(`${t.name}.${p.key}=${JSON.stringify(v)} (declared ${p.type})`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("verbatim is a closed string enum", () => {
    const knob = TOOLS.find((t) => t.name === "tanuki_render")?.params.find((p) => p.key === "verbatim");
    expect(knob?.type).toBe("string");
    expect(knob?.values).toEqual(["full", "lazy", "off"]);
  });

  test("every tool carrying verbatim advertises the same shape", () => {
    // render, estimate and fetch all take it; a per-tool copy could drift.
    const shapes = new Set<string>();
    for (const t of TOOLS) {
      const k = t.params.find((p) => p.key === "verbatim");
      if (k !== undefined) shapes.add(JSON.stringify({ type: k.type, values: k.values }));
    }
    expect(shapes.size).toBe(1);
  });

  test("the slim default surface is advertised too", () => {
    // A schema fix that only reached the hidden tools would still break Kimi.
    expect(visibleTools().length).toBeGreaterThan(0);
    for (const t of visibleTools()) for (const p of t.params) expect(Array.isArray(p.type)).toBe(false);
  });

  test("a no-argument tool omits `properties` rather than sending an empty one", () => {
    // `{"properties":{}}` is fine for Kimi/OpenAI/Mistral/DeepSeek/Anthropic
    // and a hard 400 on Gemini ("should be non-empty for OBJECT type") - the
    // same whole-request failure as issue #1, on a different provider. Kimi
    // and Mistral require the schema field itself to exist, so the shape that
    // satisfies everyone is `{"type":"object"}` with no `properties` key.
    let zeroParam = 0;
    for (const t of advertised()) {
      const schema = t.inputSchema;
      expect(schema.type).toBe("object");
      if (Object.keys(schema.properties ?? {}).length > 0) continue;
      zeroParam++;
      expect(schema.properties).toBeUndefined();
      expect(schema.required).toBeUndefined(); // Kimi: `required` without `properties` is an error
    }
    expect(zeroParam).toBeGreaterThan(0); // the check would be vacuous otherwise
  });
});

describe("verbatim values do what the enum says", () => {
  // "off" is the value this fix ADDED to the advertised contract, and the old
  // parser mapped it to "full" - it only understood the boolean `false`. An
  // enum member that silently means its own opposite is worse than the
  // registration failure, because nothing errors.
  test.each([
    ["full", "full"],
    ["lazy", "lazy"],
    ["off", "off"],
    ["OFF", "off"],
    ["Lazy", "lazy"],
  ])("string %p -> %p", (given, want) => {
    expect(parseVerbatim(given)).toBe(want);
  });

  // Booleans are no longer advertised but must still be accepted: existing
  // callers wrote them against the old union, and the CLI passes them.
  test.each([
    [true, "full"],
    [false, "off"],
  ])("legacy boolean %p -> %p", (given, want) => {
    expect(parseVerbatim(given)).toBe(want);
  });

  test("unknown words fall back to the shipped default", () => {
    expect(parseVerbatim("banana")).toBe("full");
    expect(parseVerbatim(7)).toBe("full");
  });
});

describe("one model string, one vocabulary", () => {
  // The weak-reader gate and the price table read the SAME `model` argument.
  // They used to match it differently - `startsWith` on the raw string here,
  // `includes` on a lowercased one there - so `anthropic/claude-haiku-4-5`,
  // the spelling OpenRouter/Bedrock/LiteLLM use, was priced as haiku and NOT
  // flagged weak. The router then answered "image" for a reader measured at
  // 0% read-back (EVALS §3): the exact failure the 0.17 gate exists to stop.
  test.each([
    "claude-haiku-4-5",
    "anthropic/claude-haiku-4-5",
    "Claude-Haiku-4-5",
    "openrouter/anthropic/claude-sonnet-4-5",
    "bedrock/anthropic.claude-haiku-4-5-v1:0",
  ])("%s is recognised as a weak reader", (model) => {
    expect(weakReader(model)).toBe(true);
    // ...and priced as the same family, which is what proved the two paths
    // disagreed: pricing already resolved these ids correctly.
    expect(["haiku", "sonnet"]).toContain(resolveRate(model).key);
  });

  test("a capable reader is still not flagged", () => {
    for (const m of ["claude-opus-5", "anthropic/claude-opus-4-8", "gpt-5", "gemini-2.5-pro", null]) {
      expect(weakReader(m)).toBe(false);
    }
  });
});
