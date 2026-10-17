// The lists of the built MCP server, read on the wire (plan 11e deviation
// 15). The site imports no source of @authtempo/mcp. It starts the built
// binary and sends raw JSON-RPC, as check-cli runs `--help`. The remote
// surface is the built Worker of the same package, called in process with
// one POST per list, as a client calls it.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** One tool of tools/list, with the parts that the reference page shows. */
export interface WireTool {
  name: string;
  title: string;
  description: string;
  annotations: Record<string, unknown>;
  /** The properties of inputSchema, each a JSON Schema object. */
  properties: Record<string, Record<string, unknown>>;
  /** The required keys of inputSchema. */
  required: string[];
  /** The keys of outputSchema. */
  outputKeys: string[];
}

export interface WirePrompt {
  name: string;
  title: string;
  arguments: { name: string; required: boolean }[];
}

export interface WireTemplate {
  name: string;
  uriTemplate: string;
  mimeType: string;
}

/** What the server answered, or the reason that it did not answer. */
export interface WireLists {
  /** The local surface: the binary on stdio. */
  tools: WireTool[];
  prompts: WirePrompt[];
  templates: WireTemplate[];
  /** The names that the remote Worker lists. */
  remote: { tools: string[]; prompts: string[]; templates: string[] };
  /** The first resources/list page of the binary: its size, and whether a next cursor follows. */
  resourcePage: { size: number; more: boolean } | null;
  /** LIMITS of the built package: the owned limits of the remote Worker. */
  limits: Record<string, number>;
  /** Null when every list came back. */
  error: string | null;
}

/** The longest wait for the five answers of the binary. */
const TIMEOUT_MS = 30_000;

/** The protocol revision of the requests: the newest of the 2025 era that the SDK serves. */
const REVISION = "2025-11-25";

const LISTS = ["tools/list", "prompts/list", "resources/templates/list"] as const;

/** The requests of the binary after initialize: the lists, and the first page of the resources. */
const LOCAL = [...LISTS, "resources/list"] as const;

function empty(error: string): WireLists {
  return {
    tools: [],
    prompts: [],
    templates: [],
    remote: { tools: [], prompts: [], templates: [] },
    resourcePage: null,
    limits: {},
    error,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The result of an answer, or a thrown error that names the method and the error of the answer. */
function resultOf(method: string, answer: unknown): Record<string, unknown> {
  if (!isObject(answer)) throw new Error(`${method} gave no answer`);
  if (isObject(answer.error))
    throw new Error(
      `${method} answered the error ${String(answer.error.code)}: ${text(answer.error.message)}`,
    );
  if (!isObject(answer.result)) throw new Error(`${method} answered no result`);
  return answer.result;
}

function listOf(result: Record<string, unknown>, key: string, method: string): unknown[] {
  const list = result[key];
  if (!Array.isArray(list)) throw new Error(`${method} answered no ${key} list`);
  return list;
}

function toolOf(v: unknown): WireTool {
  if (!isObject(v)) throw new Error("tools/list holds a tool that is not an object");
  const input = isObject(v.inputSchema) ? v.inputSchema : {};
  const props = isObject(input.properties) ? input.properties : {};
  const output = isObject(v.outputSchema) ? v.outputSchema : {};
  return {
    name: text(v.name),
    title: text(v.title),
    description: text(v.description),
    annotations: isObject(v.annotations) ? v.annotations : {},
    properties: Object.fromEntries(
      Object.entries(props).map(([k, p]) => [k, isObject(p) ? p : {}]),
    ),
    required: Array.isArray(input.required) ? input.required.map(text) : [],
    outputKeys: Object.keys(isObject(output.properties) ? output.properties : {}),
  };
}

function promptOf(v: unknown): WirePrompt {
  if (!isObject(v)) throw new Error("prompts/list holds a prompt that is not an object");
  const args = Array.isArray(v.arguments) ? v.arguments : [];
  return {
    name: text(v.name),
    title: text(v.title),
    arguments: args.map((a) => ({
      name: text(isObject(a) ? a.name : undefined),
      required: isObject(a) && a.required === true,
    })),
  };
}

function templateOf(v: unknown): WireTemplate {
  if (!isObject(v))
    throw new Error("resources/templates/list holds a template that is not an object");
  return { name: text(v.name), uriTemplate: text(v.uriTemplate), mimeType: text(v.mimeType) };
}

/**
 * The five answers of the binary: initialize, the three lists, and the first
 * resources page. The binary gets stdin open until each request has its
 * answer, because the SDK drops an open request when stdin ends.
 */
function localAnswers(bin: string, indexPath: string): Promise<Map<number, unknown>> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [bin, "--index", indexPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const answers = new Map<number, unknown>();
    let out = "";
    let err = "";
    let settled = false;
    const finish = (e: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (e) {
        child.kill();
        fail(e);
      } else done(answers);
    };
    const timer = setTimeout(
      () => finish(new Error(`no answer in ${TIMEOUT_MS / 1000} s`)),
      TIMEOUT_MS,
    );
    child.on("error", (e) => finish(new Error(`exit 1: ${e.message}`)));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      err += chunk;
    });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
      const lines = out.split("\n");
      out = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error(`a stdout line is no JSON-RPC message: ${line.slice(0, 80)}`));
          return;
        }
        if (isObject(message) && typeof message.id === "number") answers.set(message.id, message);
      }
      if (answers.size === LOCAL.length + 1) child.stdin.end();
    });
    child.on("close", (code) => {
      if (answers.size === LOCAL.length + 1) finish(null);
      else {
        const first = err.trim().split("\n")[0] ?? "";
        finish(new Error(`exit ${code ?? "?"}: ${first}`));
      }
    });
    // A missing file makes node exit 1 before it reads stdin; the write may then fail.
    child.stdin.on("error", () => {});
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: REVISION,
        capabilities: {},
        clientInfo: { name: "check-mcp", version: "0.0.0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    for (const [i, method] of LOCAL.entries()) send({ jsonrpc: "2.0", id: i + 1, method });
  });
}

/** The Worker's surface of the built package: its fetch with assets from the given files. */
interface RemoteWorker {
  fetch(request: Request, env: unknown): Promise<Response>;
}

/**
 * The answers of the built remote Worker, one stateless POST per list. Its
 * assets are the index of this site build and the skills of the package.
 */
async function remoteAnswers(pkg: string, indexPath: string): Promise<unknown[]> {
  const worker = (await import(pathToFileURL(`${pkg}dist/worker.js`).href)) as {
    createWorker(): RemoteWorker;
  };
  const reader = (await import(pathToFileURL(`${pkg}dist/index-reader.js`).href)) as {
    readSkills(dir: string): unknown;
  };
  const files: Record<string, string> = {
    "/index.json": readFileSync(indexPath, "utf8"),
    "/skills.json": JSON.stringify(reader.readSkills(`${pkg}skills/`)),
  };
  const host = "mcp.authtempo.com";
  const env = {
    ASSETS: {
      fetch: async (r: Request) => {
        const file = files[new URL(r.url).pathname];
        return file === undefined ? new Response("", { status: 404 }) : new Response(file);
      },
    },
    MCP_HOST: host,
    MCP_ALLOWED_ORIGINS: "",
  };
  const w = worker.createWorker();
  const out: unknown[] = [];
  for (const [i, method] of LISTS.entries()) {
    const res = await w.fetch(
      new Request(`https://${host}/mcp`, {
        method: "POST",
        headers: {
          host,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": REVISION,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: i + 1, method }),
      }),
      env,
    );
    const body = await res.text();
    if (res.status !== 200) throw new Error(`the remote ${method} answered ${res.status}`);
    // The SDK answers a 2025-era POST as one server-sent event.
    const data = body
      .split("\n")
      .find((l) => l.startsWith("data: "))
      ?.slice("data: ".length);
    out.push(JSON.parse(data ?? body));
  }
  return out;
}

/**
 * Starts the built server `bin` with `--index indexPath`. It sends
 * initialize, the three lists, and a resources/list, and reads the answers.
 * Then it asks the built remote Worker of the same package for the same
 * lists, and reads LIMITS. A failure
 * of any step is the `error` of the answer, never a throw.
 */
export async function wireLists(bin: string, indexPath: string): Promise<WireLists> {
  // bin is <package>/dist/bin/authtempo-mcp.js.
  const pkg = `${resolve(dirname(bin), "../..")}/`;
  let local: Map<number, unknown>;
  try {
    local = await localAnswers(bin, indexPath);
  } catch (e) {
    return empty((e as Error).message);
  }
  try {
    resultOf("initialize", local.get(0));
    const tools = listOf(resultOf("tools/list", local.get(1)), "tools", "tools/list").map(toolOf);
    const prompts = listOf(resultOf("prompts/list", local.get(2)), "prompts", "prompts/list").map(
      promptOf,
    );
    const templates = listOf(
      resultOf("resources/templates/list", local.get(3)),
      "resourceTemplates",
      "resources/templates/list",
    ).map(templateOf);
    const first = resultOf("resources/list", local.get(4));
    const resourcePage = {
      size: listOf(first, "resources", "resources/list").length,
      more: typeof first.nextCursor === "string",
    };
    const [rt, rp, rr] = await remoteAnswers(pkg, indexPath);
    const remote = {
      tools: listOf(resultOf("tools/list", rt), "tools", "tools/list").map((t) => toolOf(t).name),
      prompts: listOf(resultOf("prompts/list", rp), "prompts", "prompts/list").map(
        (p) => promptOf(p).name,
      ),
      templates: listOf(
        resultOf("resources/templates/list", rr),
        "resourceTemplates",
        "resources/templates/list",
      ).map((t) => templateOf(t).uriTemplate),
    };
    const { LIMITS } = (await import(pathToFileURL(`${pkg}dist/limits.js`).href)) as {
      LIMITS: Record<string, number>;
    };
    return { tools, prompts, templates, remote, resourcePage, limits: { ...LIMITS }, error: null };
  } catch (e) {
    return empty((e as Error).message);
  }
}
