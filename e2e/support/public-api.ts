// Helpers for the public API (/api/v1) and the MCP server specs.

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

import { BASE_URL } from "./env";

export interface V1Response<T = any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  status: number;
  body: T;
  headers: Headers;
}

/** Call the public API with a bearer key (null = no Authorization header). */
export async function v1<T = any>( // eslint-disable-line @typescript-eslint/no-explicit-any
  key: string | null,
  method: string,
  pathname: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<V1Response<T>> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (key !== null) headers.authorization = `Bearer ${key}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE_URL}/api/v1${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}

// ------------------------------------------------------------
// MCP server (mcp-server/) over stdio
// ------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..", "..");

/**
 * Compile mcp-server/src with the repo's TypeScript into a folder under
 * the repo's node_modules (so `@modelcontextprotocol/sdk` and `zod`
 * resolve from the root install — mcp-server/ has no install of its
 * own). Type errors (missing @types/node in that sub-project) don't
 * block emit. Returns the entry point.
 */
export function buildMcpServer(): string {
  const out = path.join(ROOT, "node_modules", ".cache", `e2e-mcp-${randomBytes(4).toString("hex")}`);
  mkdirSync(out, { recursive: true });
  try {
    execFileSync(
      path.join(ROOT, "node_modules", ".bin", "tsc"),
      ["-p", path.join(ROOT, "mcp-server", "tsconfig.json"), "--outDir", out, "--declaration", "false", "--sourceMap", "false"],
      { cwd: ROOT, stdio: "pipe" },
    );
  } catch {
    /* type errors only — emit still happens */
  }
  const entry = path.join(out, "index.js");
  if (!existsSync(entry)) throw new Error(`MCP server build produced no ${entry}`);
  writeFileSync(path.join(out, "package.json"), JSON.stringify({ type: "module" }));
  return entry;
}

interface JsonRpcResponse {
  id?: number;
  result?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  error?: { code: number; message: string };
}

/** Minimal newline-delimited JSON-RPC client for an MCP stdio server. */
export class McpStdioClient {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (r: JsonRpcResponse) => void>();
  stderr = "";

  constructor(entry: string, env: Record<string, string>) {
    this.proc = spawn(process.execPath, [entry], {
      env: { NODE_ENV: "production", PATH: process.env.PATH ?? "", ...env },
      stdio: "pipe",
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
        }
      }
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (c: string) => (this.stderr += c));
  }

  request(method: string, params: unknown = {}, timeoutMs = 20_000): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out. stderr: ${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown = {}) {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize() {
    const r = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "wacrm-e2e", version: "1.0.0" },
    });
    this.notify("notifications/initialized");
    return r;
  }

  /** Call a tool; returns the parsed JSON of its first text content (or the raw text). */
  async callTool(name: string, args: Record<string, unknown> = {}) {
    const r = await this.request("tools/call", { name, arguments: args });
    if (r.error) throw new Error(`MCP ${name}: ${r.error.message}`);
    const text: string = r.result?.content?.[0]?.text ?? "";
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* error text */
    }
    return { isError: Boolean(r.result?.isError), text, json: json as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  /** Resolves when the process exits (with its exit code). */
  exited(): Promise<number | null> {
    if (this.proc.exitCode !== null) return Promise.resolve(this.proc.exitCode);
    return new Promise((resolve) => this.proc.once("exit", (code) => resolve(code)));
  }

  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}
