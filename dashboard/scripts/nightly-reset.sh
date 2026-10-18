#!/usr/bin/env bash
# Nightly reset to a known-good demo state (plan CP3 item 4).
#
#   Mode A (default, local anvil): redeploy + fund + whitelist on a FRESH
#     anvil, clear the agent journal. Fully automated below.
#
#   Mode B (hosted Sepolia, used by the public demo): contracts are
#     redeployed and the agent's .env is repointed — printed as a checklist
#     because it involves the hosting supervisor + secrets.
#
# Usage:
#   bash scripts/nightly-reset.sh            # local anvil mode
#   SEPOLIA=1 bash scripts/nightly-reset.sh  # print the hosted checklist

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if [[ "${SEPOLIA:-0}" == "1" ]]; then
  cat <<'EOF'
── Hosted (Sepolia) nightly reset checklist ──────────────────────────────
1.  cd contracts && OWNER_KEY=0x… AGENT_KEY=0x… SEPOLIA_RPC_URL=… \
        forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast --slow
2.  Fund the new vault + whitelist the demo recipients (see INSTRUCTIONS.md Part D)
3.  Update agent/.env: VAULT_ADDRESS / VENUE_ADDRESS / USDC_ADDRESS
4.  Restart the agent process (hosting supervisor auto-restart, or manually)
5.  Verify:  AGENT_URL=https://… node dashboard/scripts/uptime-check.mjs
6.  The uptime GitHub Action goes green again within 30 minutes.
Transcript of the reset (tx hashes) is itself evidence — keep it in the log.
──────────────────────────────────────────────────────────────────────────
EOF
  exit 0
fi

# ── Mode A: local anvil ────────────────────────────────────────────────────
echo "── Nightly reset (local anvil) ──"
echo "IMPORTANT: restart anvil first for a virgin chain (Ctrl+C in its terminal, run: anvil)"
read -p "anvil restarted and running on :8545? [y/N] " yn
[[ "$yn" == "y" ]] || { echo "do that first, then re-run"; exit 1; }

cd "$ROOT/contracts"

OWNER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
AGENT_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
RPC=http://localhost:8545

echo "1/4 deploying AegisVault (owner = anvil #0, agent = anvil #1)…"
OWNER_KEY=$OWNER_KEY AGENT_KEY=$AGENT_KEY \
  forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --slow >/dev/null

# on a fresh anvil the addresses are deterministic — the agent/.env defaults
VAULT=0x5FC8d32690cc91D4c39d9d3abcBD16989F875707
USDC=0x5FbDB2315678afecb367f032d93F642f64180aa3
SAVINGS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
LANDLORD=0x90F79bf6EB2c4f8443659171C71522320EB20889

echo "2/4 funding the vault (10,000 USDC + 2 ETH)…"
cast send $USDC "approve(address,uint256)" $VAULT 10000000000 --private-key $OWNER_KEY --rpc-url $RPC >/dev/null
cast send $VAULT "depositERC20(address,uint256)" $USDC 10000000000 --private-key $OWNER_KEY --rpc-url $RPC >/dev/null
cast send $VAULT --value 2ether --private-key $OWNER_KEY --rpc-url $RPC >/dev/null

echo "3/4 whitelisting the two demo recipients…"
cast send $VAULT "setWhitelist(address,string,bool)" $SAVINGS "Savings Wallet" true --private-key $OWNER_KEY --rpc-url $RPC >/dev/null
cast send $VAULT "setWhitelist(address,string,bool)" $LANDLORD "Rent - Landlord" true --private-key $OWNER_KEY --rpc-url $RPC >/dev/null

echo "4/4 clearing the agent decision journal…"
: > "$ROOT/agent/data/journal.jsonl" 2>/dev/null || true

echo ""
echo "Known-good state restored. Last step (manual):"
echo "  restart the agent:  cd agent  →  Ctrl+C  →  node src/server.js"
echo "  (restart also resets the in-memory faucet ledger)"
echo "Verify with:  cd ../dashboard && node scripts/uptime-check.mjs"
