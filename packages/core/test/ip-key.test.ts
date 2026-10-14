import { describe, expect, it } from "vitest";
import { requestMagicLink } from "../src/engine/magic-link.js";
import { ipKey } from "../src/limiter/ip-key.js";
import { makeAuth } from "./helpers.js";

describe("ipKey (plan 12b, Better Auth docs audit gap 3)", () => {
  it.each([
    [null, "unknown"],
    ["", "unknown"],
    ["192.0.2.1", "192.0.2.1"],
    ["::ffff:192.0.2.1", "192.0.2.1"],
    ["::ffff:c000:201", "192.0.2.1"],
    ["::FFFF:192.0.2.1", "192.0.2.1"],
    ["2001:db8:1:2::1", "2001:db8:1:2::/64"],
    ["2001:0DB8:0001:0002:ffff:ffff:ffff:ffff", "2001:db8:1:2::/64"],
    ["[2001:db8:1:2::1]", "2001:db8:1:2::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["not an ip", "not an ip"],
    ["64:ff9b::192.0.2.1", "64:ff9b:0:0::/64"],
  ])("keys %s as %s", (ip, key) => {
    expect(ipKey(ip)).toBe(key);
  });

  // magic-link:ip:<ip> allows 20 per 15 minutes; each call has its own address,
  // so magic-link:email (5 per 15 minutes) never answers first.
  async function burst(auth: ReturnType<typeof makeAuth>, ips: readonly string[]) {
    const answers: boolean[] = [];
    for (const [i, ip] of ips.entries()) {
      const r = await requestMagicLink(auth.config, { email: `u${i}@example.com`, ip });
      answers.push(r.ok);
    }
    return answers;
  }

  it("shares one count between two addresses of one /64", async () => {
    const auth = makeAuth();
    const first = await burst(
      auth,
      Array.from({ length: 20 }, (_, i) => `2001:db8:1:2::${i + 1}`),
    );
    expect(first.every(Boolean)).toBe(true);
    expect(await burst(auth, ["2001:db8:1:2:ffff:ffff:ffff:fffe"])).toEqual([false]);
  });

  it("keeps a separate count for another /64", async () => {
    const auth = makeAuth();
    await burst(
      auth,
      Array.from({ length: 20 }, (_, i) => `2001:db8:1:2::${i + 1}`),
    );
    expect(await burst(auth, ["2001:db8:1:3::1"])).toEqual([true]);
  });

  it("shares one count between a mapped address and its IPv4 form", async () => {
    const auth = makeAuth();
    await burst(
      auth,
      Array.from({ length: 20 }, () => "::ffff:192.0.2.1"),
    );
    expect(await burst(auth, ["192.0.2.1"])).toEqual([false]);
  });
});
