#!/bin/sh
# Usage: sh rules-tests/run.sh [vitest -t filter]   (needs a JDK; set JDK_DIR)
JDK="${JDK_DIR:?Set JDK_DIR to a JDK 11+ folder}"
export JAVA_HOME="$(cygpath -w "$JDK")" PATH="$JDK/bin:$PATH" JAVA_TOOL_OPTIONS='-Djdk.net.unixdomain.tmpdir=C:/uds_test'
FILTER=""; [ -n "$1" ] && FILTER="-t \"$1\""
npx -y firebase-tools@15 emulators:exec --only firestore --project demo-payment-dashboard "npx vitest run -c vitest.rules.config.ts $FILTER" 2>&1 \
  | grep -E "✓|×|Tests |PERMISSION_DENIED|maximum|Index|evaluation error" | grep -v "^\s*$" | sort -u | head -40
