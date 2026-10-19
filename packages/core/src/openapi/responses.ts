import type { z } from "zod";
import { ERRORS, OAUTH_ERRORS } from "../errors.js";
import { DOCS_ORIGIN, type ErrorTable, errorAnchor } from "../http/anchors.js";
import type { AnswerKind, RouteContract } from "../http/contract/types.js";
import { ROUTER_CODES, type RouteEntry } from "../http/route-list.js";

/** The schema of an answer, as the document writes it: a converter that owns `components.schemas`. */
export type SchemaOf = (schema: z.ZodType, io: "input" | "output") => object;

/** The two error shapes of spec 25 item 7, under `components.schemas`. */
export const ERROR_SCHEMAS = {
  Error: {
    type: "object",
    properties: {
      error: { type: "string" },
      message: { type: "string", description: "The app's text. Present only on `hook_refused`." },
    },
    required: ["error"],
    additionalProperties: false,
  },
  OAuthError: {
    type: "object",
    properties: { error: { type: "string" } },
    required: ["error"],
    additionalProperties: false,
  },
} as const;

/** The standard that a metadata answer follows. */
const STANDARDS: Record<Extract<AnswerKind, { kind: "metadata" }>["standard"], string> = {
  rfc8414: "The authorization server metadata of RFC 8414.",
  "oidc-discovery": "The provider metadata of OpenID Connect Discovery 1.0.",
  jwks: "The JSON Web Key Set of RFC 7517.",
  openapi: "This OpenAPI document.",
};

interface OpenApiResponse {
  description: string;
  headers?: Record<string, object>;
  content?: Record<string, { schema: object }>;
}

/** The success answer of one answer kind: its status and its response. */
function answerOf(kind: AnswerKind, schemaOf: SchemaOf): [string, OpenApiResponse] {
  switch (kind.kind) {
    case "json":
      return [
        String(kind.status ?? 200),
        {
          description: "The answer.",
          content: { "application/json": { schema: schemaOf(kind.schema, "output") } },
        },
      ];
    case "metadata":
      return [
        "200",
        {
          description: STANDARDS[kind.standard],
          content: { "application/json": { schema: { type: "object" } } },
        },
      ];
    case "html":
      return [
        "200",
        {
          description: "A page of core.",
          content: { "text/html": { schema: { type: "string" } } },
        },
      ];
    case "redirect":
      return [
        "302",
        {
          description:
            kind.param === undefined
              ? "A redirect."
              : `A redirect. A failure carries its code in the \`${kind.param}\` query parameter of the location.`,
          headers: { Location: { required: true, schema: { type: "string" } } },
        },
      ];
  }
}

/** The codes of a route with their tables: its own codes, the router codes that apply, and its OAuth codes. */
export function codesOf(entry: RouteEntry): { code: string; table: ErrorTable; status: number }[] {
  const router = ROUTER_CODES.filter(
    (code) =>
      code !== "origin_not_trusted" || (entry.method === "POST" && entry.crossSiteForm !== true),
  );
  return [
    ...[...entry.codes, ...router].map((code) => ({
      code,
      table: "core" as const,
      status: ERRORS[code],
    })),
    ...entry.oauthCodes.map((code) => ({
      code,
      table: "oauth" as const,
      status: OAUTH_ERRORS[code],
    })),
  ];
}

const REF = {
  core: { $ref: "#/components/schemas/Error" },
  oauth: { $ref: "#/components/schemas/OAuthError" },
};

/**
 * The responses of a route (spec 25 item 7). Each answer kind gives one
 * success answer. Each status of its codes gives one error answer with an
 * `enum` of them.
 * Each code links its anchor on the errors page. `pageCodes` are the codes
 * that a form post gets in `error=` on its own page, not in the redirect parameter.
 */
export function responsesOf(
  entry: RouteEntry,
  contract: RouteContract,
  schemaOf: SchemaOf,
  pageCodes: ReadonlySet<string> = new Set(),
): Record<string, OpenApiResponse> {
  const out: Record<string, OpenApiResponse> = {};
  for (const kind of contract.alt === undefined
    ? [contract.answer]
    : [contract.answer, contract.alt]) {
    const [status, response] = answerOf(kind, schemaOf);
    const seen = out[status];
    out[status] =
      seen === undefined
        ? response
        : {
            description: `${seen.description} ${response.description}`,
            content: { ...seen.content, ...response.content },
          };
  }
  const redirect = [contract.answer, contract.alt].find((k) => k?.kind === "redirect");
  const byStatus = new Map<number, { code: string; table: ErrorTable }[]>();
  for (const { code, table, status } of codesOf(entry)) {
    const list = byStatus.get(status) ?? [];
    if (!list.some((c) => c.code === code && c.table === table)) list.push({ code, table });
    byStatus.set(status, list);
  }
  for (const [status, codes] of [...byStatus].sort(([a], [b]) => a - b)) {
    const tables = [...new Set(codes.map((c) => c.table))];
    const shape =
      tables.length === 1 ? REF[tables[0] ?? "core"] : { anyOf: tables.map((t) => REF[t]) };
    const links = codes
      .map(
        ({ code, table }) =>
          `[\`${code}\`](${DOCS_ORIGIN}/docs/reference/errors/#${errorAnchor(code, table)})`,
      )
      .join(", ");
    const own = codes.filter((c) => !(ROUTER_CODES as readonly string[]).includes(c.code));
    const onPage = own.filter((c) => pageCodes.has(c.code));
    const inParam = own.filter((c) => !pageCodes.has(c.code));
    const listed = (list: { code: string }[]) => list.map((c) => `\`${c.code}\``).join(", ");
    let note = "";
    if (onPage.length > 0)
      note += ` A form post gets ${listed(onPage)} in the \`error\` query parameter of a 302 back to its own page.`;
    if (redirect?.kind === "redirect" && redirect.param !== undefined && inParam.length > 0)
      note +=
        onPage.length > 0
          ? ` A browser flow can get ${listed(inParam)} in the \`${redirect.param}\` query parameter of a 302 in place of this answer.`
          : ` A browser flow can get the code in the \`${redirect.param}\` query parameter of a 302 in place of this answer.`;
    const response: OpenApiResponse = {
      description: `The codes: ${links}.${note}`,
      content: {
        "application/json": {
          schema: { ...shape, properties: { error: { enum: codes.map((c) => c.code) } } },
        },
      },
    };
    // RFC 6750 section 3: the bearer route writes the challenge with these two codes.
    // A router code of the same status (origin_not_trusted on a POST) has no challenge.
    const challenged = entry.auth.includes("accessToken")
      ? codes.filter(
          (c) =>
            c.table === "oauth" && (c.code === "invalid_token" || c.code === "insufficient_scope"),
        )
      : [];
    if (challenged.length > 0) {
      const every = challenged.length === codes.length;
      response.headers = {
        "WWW-Authenticate": {
          required: every,
          description: every
            ? "The bearer challenge of RFC 6750 section 3, with the error code."
            : `The bearer challenge of RFC 6750 section 3, with the error code. Only ${listed(challenged)} carries it.`,
          schema: { type: "string" },
        },
      };
    }
    out[String(status)] = response;
  }
  return out;
}
