#!/usr/bin/env bash
# Nuri - Environment & Health Doctor
set -e

echo "=== Nuri  Doctor Diagnostic ==="
echo "Date: $(date)"
echo ""

echo "[1/4] Checking Node.js Runtime..."
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v)
  echo "  ✅ Node.js: $NODE_VER"
else
  echo "  ❌ Node.js is not installed!"
  exit 1
fi

echo "[2/4] Checking Google Antigravity CLI ('agy')..."
if command -v agy >/dev/null 2>&1; then
  echo "  ✅ agy binary found on PATH"
  agy --help >/dev/null 2>&1 || true
else
  echo "  ❌ 'agy' not found on PATH! Install via official instructions in README."
  exit 1
fi

echo "[3/4] Checking Gemini Subscription Models in agy..."
MODELS=$(agy models 2>/dev/null || true)
if echo "$MODELS" | grep -q "gemini-3.8-flash-medium"; then
  echo "  ✅ Primary Model: gemini-3.8-flash-medium is available"
else
  echo "  ⚠️ gemini-3.8-flash-medium not detected in agy models"
fi

if echo "$MODELS" | grep -q "gemini-3.8-flash-high"; then
  echo "  ✅ High-Reasoning Model: gemini-3.8-flash-high is available"
fi

echo "[4/4] Checking Ambient API Key Safety (Zero Paid API Key Rule)..."
FORBIDDEN_KEYS=("OPENAI_API_KEY" "ANTHROPIC_API_KEY" "GEMINI_API_KEY" "GOOGLE_API_KEY")
VIOLATIONS=()
for KEY in "${FORBIDDEN_KEYS[@]}"; do
  if [ -n "${!KEY}" ]; then
    VIOLATIONS+=("$KEY")
  fi
done

if [ ${#VIOLATIONS[@]} -eq 0 ]; then
  echo "  ✅ Clean environment: No ambient API billing keys injected (subscription_cli_only verified)"
else
  echo "  ⚠️ Warning: Detected ambient API keys: ${VIOLATIONS[*]} - Ensure they are not used for unintended billing"
fi

echo ""
echo "=== All ANB Diagnostics Completed Successfully ==="
