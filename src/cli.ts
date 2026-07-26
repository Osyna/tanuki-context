#!/usr/bin/env node
//! Bin entry: keeps src/main.ts importable as a library (src/agent.ts) without
//! starting the MCP server as an import side effect.
import { main } from "./main.ts";

main();
