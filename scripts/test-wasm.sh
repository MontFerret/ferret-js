#!/bin/sh
set -eu

# Go's WASM runner has an 8 KiB argv/environment budget. Keep the build's
# environment intact and pass only basic process settings to the test runtime.
exec env -i PATH="$PATH" HOME="${HOME:-}" TMPDIR="${TMPDIR:-/tmp}" "$@"
