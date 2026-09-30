//! Which tools a client's conversations actually call: the evidence behind
//! `--prune-tools`. One small JSON map, tool name -> { adv, used }: in how many
//! conversations the tool was advertised, and in how many it was called. The
//! proxy bumps it as requests pass (names only, never arguments), so the file
//! fills while pruning is still off. Best-effort like every stats file here:
//! an unreadable or unwritable file means "no evidence", which prunes nothing.
//! Mirrored in toolusage.rs.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { asU64, isObj, jstring } from "./serde.ts";

export type UsageMap = Record<string, { adv: number; used: number }>;

export interface UsageStore {
  load(): UsageMap;
  /** count one more conversation for each name advertised / used for the first time */
  bump(adv: string[], used: string[]): void;
}

export function usagePath(): string {
  const p = process.env.TANUKI_TOOL_USAGE;
  if (p !== undefined && p !== "") return p;
  return `${process.env.HOME ?? ""}/.tanuki/tool-usage.json`;
}

export function fileUsage(): UsageStore {
  const load = (): UsageMap => {
    const out: UsageMap = {};
    try {
      const j: unknown = JSON.parse(readFileSync(usagePath(), "utf8"));
      if (isObj(j)) {
        for (const [k, v] of Object.entries(j)) {
          if (isObj(v)) out[k] = { adv: asU64(v.adv) ?? 0, used: asU64(v.used) ?? 0 };
        }
      }
    } catch {
      /* no file yet, or unreadable: no evidence */
    }
    return out;
  };
  return {
    load,
    bump(adv, used) {
      try {
        const m = load();
        for (const n of adv) (m[n] ??= { adv: 0, used: 0 }).adv++;
        for (const n of used) (m[n] ??= { adv: 0, used: 0 }).used++;
        const p = usagePath();
        mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
        // a temp name of our own, then rename: concurrent proxies never write the same
        // file, and a reader sees the old file or the new one, never half of one
        const tmp = `${p}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        try {
          writeFileSync(tmp, jstring(m, false) + "\n", { mode: 0o600 });
          renameSync(tmp, p);
        } catch (e) {
          rmSync(tmp, { force: true });
          throw e;
        }
      } catch {
        /* best effort */
      }
    },
  };
}
