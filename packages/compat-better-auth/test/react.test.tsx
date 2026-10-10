import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createAuthClient } from "../src/react.js";

describe("./react", () => {
  it("answers Better Auth's useSession shape, pending before the first read", () => {
    const client = createAuthClient({
      baseURL: "https://api.example.com",
      fetchOptions: {
        customFetchImpl: async () => Response.json({ error: "unauthorized" }, { status: 401 }),
      },
    });
    function Probe() {
      const { data, isPending, isRefetching, error, refetch } = client.useSession();
      return (
        <p>{`${data === null}|${isPending}|${isRefetching}|${error === null}|${typeof refetch}`}</p>
      );
    }
    expect(renderToString(<Probe />)).toBe("<p>true|true|false|true|function</p>");
  });
});
