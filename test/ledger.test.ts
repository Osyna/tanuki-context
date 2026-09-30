// Net-savings ledger (0.24): a fetch is charged against the tokens its stash saved.

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeOutput } from "../src/crush.ts";
import { logFetch, logStash, stashNet } from "../src/ledger.ts";
import { toolFetch, toolStash } from "../src/main.ts";

function withStash<T>(fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "tanuki-ledger-"));
  const prev = process.env.TANUKI_STASH;
  process.env.TANUKI_STASH = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TANUKI_STASH;
    else process.env.TANUKI_STASH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Letters only (distill masks digits and hex, which would collapse the lines into one template). */
const word = (seed: string): string => createHash("sha256").update(seed).digest("hex").replace(/[0-9]/g, (c) => String.fromCharCode(103 + Number(c))).slice(0, 14);
/** Incompressible output too big for the inline budget. */
const big = (tag: string): string => Array.from({ length: 300 }, (_, i) => `${word(tag + i)} ${word(tag + i + "b")} ${word(tag + i + "c")}`).join("\n");
const idOf = (out: string): string => [...out.matchAll(/[0-9a-f]{12}/g)].pop()![0];
type Net = { stashes: number; fetches: number; savedTokens: number; fetchedTokens: number; netTokens: number };
const net = (): { rules: Record<string, Net>; total: Net } => stashNet() as never;

test("net savings: a fetch is charged against the tokens its stash saved", () => {
  withStash(() => {
    const out = routeOutput(["mytool", "--all"], big("a"), 0, null, (id) => `fetch ${id}`, "/p");
    const before = net().rules.distill;
    expect(before.stashes).toBe(1);
    expect(before.savedTokens).toBeGreaterThan(0);
    toolFetch({ id: idOf(out), lines: "1-5" });
    const after = net().rules.distill;
    expect(after.fetches).toBe(1);
    expect(after.fetchedTokens).toBeGreaterThan(0);
    expect(after.netTokens).toBe(after.savedTokens - after.fetchedTokens);
    expect(net().total).toEqual(after);
  });
});

test("net savings: a crush rule owns its stashes; a manual stash counts under 'stash'", () => {
  withStash(() => {
    const cargo = ["Compiling a v0.1.0", ...Array.from({ length: 400 }, (_, i) => `   Compiling ${word("c" + i)} v0.1.0`), "error[E0308]: mismatched types", "  --> src/lib.rs:3:5"].join("\n");
    const out = routeOutput(["cargo", "build"], cargo, 101, null, (id) => `fetch ${id}`, "/p");
    expect(net().rules.cargo.stashes).toBe(1);
    toolFetch({ id: idOf(out), find: "mismatched types" });
    expect(net().rules.cargo.fetches).toBe(1);
    const overview = (toolStash({ text: big("m") }) as { text: string }[])[0].text;
    toolFetch({ id: idOf(overview), lines: "1-5" });
    expect(net().rules.stash).toMatchObject({ stashes: 1, fetches: 1 });
  });
});

test("net savings: a fetch of an unknown stash is 'untracked', an empty ledger reports nothing, a fetch follows the latest stash of its id", () => {
  withStash(() => {
    expect(stashNet()).toBeNull();
    logFetch("0123456789ab", 40);
    expect(net().rules.untracked).toMatchObject({ stashes: 0, fetches: 1, fetchedTokens: 40, netTokens: -40 });
    logStash("aaaaaaaaaaaa", "one", 100);
    logStash("aaaaaaaaaaaa", "two", 100);
    logFetch("aaaaaaaaaaaa", 30);
    expect(net().rules.one.fetches).toBe(0);
    expect(net().rules.two.fetches).toBe(1);
    expect(net().total).toMatchObject({ stashes: 2, savedTokens: 200, fetchedTokens: 70, netTokens: 130 });
  });
});
