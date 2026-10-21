import type { z } from "zod";

/**
 * How a route answers (plan 11g). `json` is a body that `schema` describes,
 * with the status 200 unless `status` says 201. `html` is a page of core: no
 * script, its own CSP. `redirect` is a 302, or the 303 that `status` names:
 * the answer to a form post that the browser follows with a GET. `param` is
 * the query parameter of the error that a redirect carries, and a redirect
 * with an error is a 302. `metadata` is a standard document. `scim` is a
 * SCIM answer (plan 12d).
 */
export type AnswerKind =
  | { readonly kind: "json"; readonly schema: z.ZodType; readonly status?: 200 | 201 }
  | { readonly kind: "html" }
  | {
      readonly kind: "redirect";
      readonly param?: "auth_error" | "error";
      readonly status?: 303;
    }
  | {
      readonly kind: "metadata";
      readonly standard: "rfc8414" | "oidc-discovery" | "jwks" | "openapi";
    }
  /**
   * A SCIM answer (plan 12d deviation 14): `application/scim+json` that
   * `schema` describes, with the status 200. A failure is the SCIM error
   * message of RFC 7644 section 3.12. A null schema: the route answers only
   * that error, with 501.
   */
  | { readonly kind: "scim"; readonly schema: z.ZodType | null };

/**
 * The contract of one route (plan 11g): its input schemas and its answer.
 * The OpenAPI document reads it, and the route parses with the same schema,
 * so the schema of the parse is the schema of the document.
 */
export interface RouteContract {
  /** The query parameters of a GET. `hand`: the route reads them by hand, and a test holds them to the schema. */
  readonly query?: { readonly schema: z.ZodType; readonly parsedBy: "zod" | "hand" };
  /** The body, and the media types that the route reads: readJson is ["json"], readBody is ["json", "form"]. */
  readonly body?: {
    readonly schema: z.ZodType;
    readonly media: readonly ("json" | "form")[];
    readonly parsedBy: "zod" | "hand";
    /** The route reads an empty body as `{}`, so the document marks the body as not required. */
    readonly optional?: true;
  };
  readonly answer: AnswerKind;
  /**
   * The other answer kinds: a JSON body gets JSON, a form post gets a
   * redirect. A list holds more than one kind. The SSO form gets a page or
   * a redirect (plan 12d Task 4 fix M1).
   */
  readonly alt?: AnswerKind | readonly AnswerKind[];
}

/** Each answer kind of a route: `answer` first, then each kind of `alt`. */
export function answerKinds(contract: RouteContract): readonly AnswerKind[] {
  const alt = contract.alt;
  if (alt === undefined) return [contract.answer];
  return "kind" in alt ? [contract.answer, alt] : [contract.answer, ...alt];
}
