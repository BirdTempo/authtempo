# Sourced by run.sh. The suite's prebuilt images of the tag that plan 12e names (docker-compose-prebuilt.yml reads IMAGE_TAG).
IMAGE_TAG=release-v5.3.2
# The suite's public base URL; run-test-plan.py reads CONFORMANCE_SERVER, and the client callbacks hang under it.
CONFORMANCE_SERVER=https://localhost.emobix.co.uk:8443/
# The local suite runs its dev profile and gives no API token. With CONFORMANCE_SERVER set,
# run-test-plan.py at the tag takes dev mode only from this variable (line 1126). Without it,
# the script reads CONFORMANCE_TOKEN (lines 1190 to 1193) and stops with a KeyError.
CONFORMANCE_DEV_MODE=1
