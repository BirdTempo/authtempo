import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { BASE_URL, post } from "./helpers.js";
import {
  OPERATOR_EMAIL,
  OPERATOR_SECRETS,
  operatorFixture,
  operatorHeader,
} from "./operator-helpers.js";

/**
 * Spec 9: every 401 of an operator route writes one log line with no
 * secret and no address. The line names the route and a reason code, as
 * the guard refusals do.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const PREFIX = "authtempo: operator route unauthorized";
const IP = "203.0.113.50";
const AGENT = "ops-log-test/1";
const WRONG = "operator-wrong-0123456789abcdef-012345";

/** A platform operator with every operator route on: the secret routes, the tools, and the impersonation. */
async function world() {
  const f = await operatorFixture({
    config: {
      jwtMint: {},
      operator: {
        secrets: [
          {
            name: "support",
            secretHash: await sha256Hex(OPERATOR_SECRETS.support),
            scopes: ["users", "sessions", "audit", "keys", "secrets"],
          },
        ],
        users: true,
        impersonation: {},
      },
    },
  });
  return { ...f, handle: createRouter(f.auth.config, coreRoutes(f.auth.config)) };
}

const cookie = (token: string) => ({ cookie: `__Host-tempo_session=${token}` });
const meta = { "cf-connecting-ip": IP, "user-agent": AGENT };

function get(path: string, headers: Record<string, string>): Request {
  return new Request(`${BASE_URL}/auth${path}`, { headers: { ...meta, ...headers } });
}

function write(path: string, headers: Record<string, string>, body: unknown = {}): Request {
  return post(`/auth${path}`, body, { ...meta, ...headers });
}

describe("the log line of a 401 of an operator route (spec 9)", () => {
  it("writes one line with the route and the reason for each 401, with no secret and no address", async () => {
    const w = await world();
    const token = w.operator.token;
    const userId = w.operator.user.id;
    const cases: [Request, string, string][] = [
      [
        write("/operator/keys/rotate", operatorHeader(WRONG)),
        "POST /operator/keys/rotate",
        "secret_mismatch",
      ],
      [get("/operator/secrets/status", {}), "GET /operator/secrets/status", "secret_mismatch"],
      [
        write("/operator/secrets/rewrap", operatorHeader(WRONG)),
        "POST /operator/secrets/rewrap",
        "secret_mismatch",
      ],
      [get("/operator/info", operatorHeader(WRONG)), "GET /operator/info", "secret_mismatch"],
      [
        get("/operator/users", { ...operatorHeader(OPERATOR_SECRETS.support), ...cookie(token) }),
        "GET /operator/users",
        "secret_and_session",
      ],
      [
        write("/operator/users/ban", operatorHeader(WRONG), { userId, reason: "Case 1" }),
        "POST /operator/users/ban",
        "secret_mismatch",
      ],
      [get("/operator/audit", {}), "GET /operator/audit", "no_session"],
      [
        write("/operator/impersonate", {}, { userId, reason: "Case 1" }),
        "POST /operator/impersonate",
        "no_session",
      ],
      [
        write(
          "/operator/impersonate",
          { ...cookie(token), ...operatorHeader(OPERATOR_SECRETS.support) },
          { userId, reason: "Case 1" },
        ),
        "POST /operator/impersonate",
        "secret_not_accepted",
      ],
      [write("/operator/impersonate/stop", {}), "POST /operator/impersonate/stop", "no_session"],
      [
        write("/operator/impersonate/stop", operatorHeader(OPERATOR_SECRETS.support)),
        "POST /operator/impersonate/stop",
        "secret_not_accepted",
      ],
    ];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [request, route, reason] of cases) {
      errors.mockClear();
      warns.mockClear();
      const res = await w.handle(request);
      expect(res.status, route).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
      // Exactly one line for the answer, and no other line.
      expect(errors.mock.calls, route).toEqual([[PREFIX, route, reason]]);
      expect(warns.mock.calls).toEqual([]);
      const text = JSON.stringify(errors.mock.calls);
      for (const secret of [OPERATOR_SECRETS.support, WRONG, token, IP, AGENT, OPERATOR_EMAIL])
        expect(text).not.toContain(secret);
      expect(text).not.toContain(userId);
      expect(text).not.toContain("Operator ");
    }
  });
});
