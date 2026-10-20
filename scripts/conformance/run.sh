#!/usr/bin/env bash
# Runs one plan of the OpenID conformance suite release-v5.3.2 against the
# example Worker in its conformance mode (plan 12e Task 17). The owner runs
# it: README.md in this folder gives the steps before it. This script fills
# the placeholders of plans/<plan>.json into a temporary file, so no secret
# goes into the repository, then calls the suite's run-test-plan.py.
#
# Usage: run.sh <basic|config|rp-logout|backchannel-logout>
# Each run needs SUITE_DIR (the clone of the suite), PORT (the wrangler dev
# port), and CONFORMANCE_PASSWORD. The basic and config runs also need
# CLIENT_ID, CLIENT_SECRET, CLIENT2_ID, and CLIENT2_SECRET from the stderr
# lines of the Worker. OUT_DIR (default ~/authtempo-conformance-out) gets
# the log and the result zip.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
plan="${1:-}"
case "$plan" in
  # One run covers both secret methods: the plan switches to client_secret_post
  # for oidcc-server-client-secret-post (OIDCCBasicTestPlan.java at the tag).
  basic) name="oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=static_client]" ;;
  # The plan fixes its own variants: discovery and a static client.
  config) name="oidcc-config-certification-test-plan" ;;
  # Dynamic clients: the suite registers its own redirect and logout URIs.
  rp-logout) name="oidcc-rp-initiated-logout-certification-test-plan[response_type=code][client_registration=dynamic_client]" ;;
  backchannel-logout) name="oidcc-backchannel-rp-initiated-logout-certification-test-plan[response_type=code][client_registration=dynamic_client]" ;;
  *)
    echo "usage: run.sh <basic|config|rp-logout|backchannel-logout>" >&2
    exit 2
    ;;
esac

: "${SUITE_DIR:?set SUITE_DIR to the clone of the suite at release-v5.3.2}"
: "${PORT:?set PORT to the port of wrangler dev}"
: "${CONFORMANCE_PASSWORD:?set CONFORMANCE_PASSWORD to the value the Worker got}"
if [ "$plan" = basic ] || [ "$plan" = config ]; then
  : "${CLIENT_ID:?}" "${CLIENT_SECRET:?}" "${CLIENT2_ID:?}" "${CLIENT2_SECRET:?}"
fi

# shellcheck source=suite-env.sh
set -a
. "$here/suite-env.sh"
set +a
out="${OUT_DIR:-$HOME/authtempo-conformance-out}"
mkdir -p "$out"
config="$(mktemp "${TMPDIR:-/tmp}/authtempo-conformance-XXXXXX")"
trap 'rm -f "$config"' EXIT

# json.dumps escapes each value, so a secret with a quote stays one JSON string.
python3 -I - "$here/plans/$plan.json" "$config" <<'PY'
import json, os, sys
text = open(sys.argv[1]).read()
for key in ("PORT", "PASSWORD", "CLIENT_ID", "CLIENT_SECRET", "CLIENT2_ID", "CLIENT2_SECRET"):
    env = "CONFORMANCE_PASSWORD" if key == "PASSWORD" else key
    value = os.environ.get(env, "")
    text = text.replace("{" + key + "}", json.dumps(value)[1:-1])
json.loads(text)
open(sys.argv[2], "w").write(text)
PY

log="$out/$plan.txt"
# The machine load goes beside the counts of the evidence line (plan 12e Step 8).
uptime > "$log"
python3 "$SUITE_DIR/scripts/run-test-plan.py" --export-dir "$out" "$name" "$config" 2>&1 | tee -a "$log"
