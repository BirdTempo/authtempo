# The local OpenID conformance run (plan 12e Task 17)

**For:** the owner, who runs four OpenID conformance plans against the example Worker on one machine.

**What it does:** these files run the OpenID conformance suite `release-v5.3.2` in Docker against the example Worker in its conformance mode. Each run gives one evidence line for the plan index. The run is evidence, not a certification.

The run is owner-run (rulings 51 and 52 of plan 12e). No agent edits `/etc/hosts`, pulls the suite, or runs it. No CI job runs it.

## Before you start

- Docker with Compose v2, and about 4 GB of free memory for the suite.
- Python 3 for `run-test-plan.py`.
- The repository installed: `pnpm install` at the root, then `pnpm turbo run build --filter=authtempo-example-worker...`.
- A free local port for the Worker, such as 8788. Check it with `lsof -i :8788` first.
- This line in `/etc/hosts`, so the browser reaches the suite's own host name:

  ```
  127.0.0.1 localhost.emobix.co.uk
  ```

## The files

| File | What it holds |
| --- | --- |
| `suite-env.sh` | `IMAGE_TAG=release-v5.3.2` and `CONFORMANCE_SERVER`. It holds no secret. The plan named it `docker.env`, but the root `.gitignore` keeps every `*.env` file out. |
| `plans/basic.json`, `plans/config.json` | The Basic OP and Config OP configs: the alias `authtempo` and the two static clients. |
| `plans/rp-logout.json`, `plans/backchannel-logout.json` | The two logout configs: the suite registers its own clients. |
| `run.sh` | Fills the placeholders of one plan JSON into a temporary file and calls `run-test-plan.py`. |
| `expected-gaps.md` | Each module that is expected not to pass, with its source file and reason. |

The plan JSON files hold placeholders, never a secret: `{PORT}`, `{PASSWORD}`, `{CLIENT_ID}`, `{CLIENT_SECRET}`, `{CLIENT2_ID}`, and `{CLIENT2_SECRET}`.

## Steps

1. Get the suite at the tag, outside this repository:

   ```sh
   git clone --branch release-v5.3.2 --depth 1 https://gitlab.com/openid/conformance-suite.git ~/conformance-suite
   python3 -m pip install -r ~/conformance-suite/scripts/requirements.txt
   ```

2. Start the suite from its prebuilt images:

   ```sh
   cd ~/conformance-suite
   IMAGE_TAG=release-v5.3.2 docker compose -f docker-compose-prebuilt.yml up -d
   ```

   Open `https://localhost.emobix.co.uk:8443` once and accept its certificate.

3. Apply the D1 migrations of the Worker to its local database. From the repository root:

   ```sh
   CI=1 WRANGLER_SEND_METRICS=false NO_COLOR=1 WRANGLER_HIDE_BANNER=true \
     pnpm --filter authtempo-example-worker exec wrangler d1 migrations apply authtempo-example --local
   ```

4. Start the Worker in its conformance mode. Pick a password of your own for the test user. From the repository root:

   ```sh
   export PORT=8788 CONFORMANCE_PASSWORD='<a long test password>'
   CI=1 WRANGLER_SEND_METRICS=false NO_COLOR=1 WRANGLER_HIDE_BANNER=true \
     pnpm --filter authtempo-example-worker exec wrangler dev \
     --local-protocol https --ip 0.0.0.0 --port "$PORT" \
     --var CONFORMANCE_MODE:1 \
     --var "BASE_URL:https://host.docker.internal:$PORT" \
     --var "AUTH_SECRET:<32 or more random characters>" \
     --var "CONFORMANCE_PASSWORD:$CONFORMANCE_PASSWORD"
   ```

   Send one request to start the mode: `curl -k "https://localhost:$PORT/auth/.well-known/openid-configuration"`. The Worker writes the test user and the two clients at its first request. It prints one stderr line per client: `conformance: <name> client_id=… client_secret=…`. A restart rotates each secret.

5. In a second shell, set the values of those lines:

   ```sh
   export SUITE_DIR=~/conformance-suite PORT=8788 CONFORMANCE_PASSWORD='<the same password>'
   export CLIENT_ID=<client_id of "conformance client"> CLIENT_SECRET=<its client_secret>
   export CLIENT2_ID=<client_id of "conformance client 2"> CLIENT2_SECRET=<its client_secret>
   ```

6. Run the four plans from the repository root, one at a time:

   ```sh
   scripts/conformance/run.sh basic
   scripts/conformance/run.sh config
   scripts/conformance/run.sh rp-logout
   scripts/conformance/run.sh backchannel-logout
   ```

   Each run writes `~/authtempo-conformance-out/<plan>.txt` (the `uptime` line first, then the output) and the result zip into the same folder. `OUT_DIR` sets another folder. Copy each zip to `.superpowers/archive/conformance-12e/`.

7. Stop the Worker, then the suite: `docker compose -f docker-compose-prebuilt.yml down` in `~/conformance-suite`. Remove the `/etc/hosts` line if you do not keep it.

## The four plans

| `run.sh` name | Plan and variants | Clients |
| --- | --- | --- |
| `basic` | `oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=static_client]` | the two static clients |
| `config` | `oidcc-config-certification-test-plan` | the static client |
| `rp-logout` | `oidcc-rp-initiated-logout-certification-test-plan[response_type=code][client_registration=dynamic_client]` | registered by the suite |
| `backchannel-logout` | `oidcc-backchannel-rp-initiated-logout-certification-test-plan[response_type=code][client_registration=dynamic_client]` | registered by the suite |

One Basic OP run covers both secret methods. The plan switches to `client_secret_post` for the module `oidcc-server-client-secret-post` (`OIDCCBasicTestPlan.java` at the tag).

## What the mode changes

The mode is on only when `CONFORMANCE_MODE` is exactly `"1"`. `wrangler.jsonc` keeps `"0"`, and a test of the example holds that value. In the mode:

- `jwtMint.alg` is `"RS256"`, because OIDC Discovery 1.0 section 3 asks for RS256.
- `oauth.defaultResource` is the `/mcp` resource, because the suite never sends RFC 8707 `resource` (ruling 52).
- Dynamic registration and the device grant are on.
- `oauth.fetch` reaches `https://localhost.emobix.co.uk:8443` only, for the back-channel logout posts.

## The evidence lines (Step 9 of the task)

Add one line per plan at the end of `docs/superpowers/plans/README.md`, in this form:

```markdown
- Evidence <date> for plan 12e: OpenID conformance suite release-v5.3.2, `<plan>`: <passed> passed, <warnings> warnings, <failed> failed, <skipped> skipped, of <total> modules, read from the summary of run-test-plan.py; machine load <1-minute load>; <date>.
```

- The total is N of the line `Overall totals: ran N test modules.` that `run-test-plan.py` prints.
- At `release-v5.3.2` that script prints no total per result. It prints one line per module: `Test [p:m] <module> <id> <status> - result <RESULT>.` Each count comes from those lines, and the counts must add up to N.
- The line form has no count for REVIEW. Name each REVIEW module in a sentence after the line.
- A plan that reports no modules is a failure, not a line. So is a run that prints `NOT ALL TESTS FROM PLAN WERE RUN` or `TEST MODULES DID NOT RUN TO COMPLETION`.
- The machine load is the first of the three load averages in the `uptime` line of `<plan>.txt`.

## If it fails

- **Every authorize answers `invalid_target`:** the mode is off. Check that `--var CONFORMANCE_MODE:1` is on the `wrangler dev` line.
- **The suite cannot reach the Worker:** the suite runs in Docker and reaches the host as `host.docker.internal`. Check `--ip 0.0.0.0` and the port.
- **A TLS error at the Worker:** `wrangler dev --local-protocol https` uses its own certificate. The suite's Java client and its browser must accept it. The first run may need that certificate in the suite's trust store.
- **The browser stops at the sign-in page:** the steps fill `#password input[name=email]` and `#password input[name=password]`, then click the submit button of that form. The page posts by script, so the suite's browser must run JavaScript (it does: `BrowserControl.java` at the tag).
- **A module that `expected-gaps.md` does not name fails:** stop. Find the cause in the task that owns it before you write a line.
