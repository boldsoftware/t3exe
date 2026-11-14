#!/usr/bin/env node
// With no arguments, the MCP server on stdio; with arguments, the CLI.
import { existsSync } from "node:fs";

const root = new URL("../", import.meta.url);
// A checkout runs src/*.ts directly (Node strips the types); the package ships dist/*.js.
const fromSource = existsSync(new URL("src/mcp.ts", root));
if (fromSource && existsSync(new URL(".env", root))) process.loadEnvFile(new URL(".env", root));
const entry = process.argv.length > 2 ? "cli" : "mcp";
await import(new URL(fromSource ? `src/${entry}.ts` : `dist/${entry}.js`, root).href);
