-include .env
export

.PHONY: help build test coverage snapshot demo deploy-sepolia deploy-amoy clean

help:
	@echo "Aegis Wallet - contracts (Checkpoint 1 + CP1.1)"
	@echo "  make build           - compile contracts"
	@echo "  make test            - full test suite (75 tests: core + stories + CP1.1 hardening + fuzz)"
	@echo "  make coverage        - coverage report (100% lines on vault + venue)"
	@echo "  make demo            - LIVE 5-story acceptance demo on a local anvil chain"
	@echo "  make snapshot        - gas snapshot"
	@echo "  make deploy-sepolia  - deploy AegisVault + MockSwap + asset to Sepolia (needs .env)"
	@echo "  make deploy-amoy     - deploy to Polygon Amoy (needs .env)"

build:
	forge build

test:
	forge test -vvv

coverage:
	forge coverage --report summary

snapshot:
	forge snapshot

## Live acceptance demo: boots a local anvil chain, deploys everything,
## runs all five user stories and prints every guardrail decision.
## If OWNER_KEY/AGENT_KEY are set (e.g. in .env) they are used; otherwise
## the default anvil test keys are used (local only - zero real funds).
demo:
	@anvil --port 8545 > /tmp/aegis-anvil.log 2>&1 & ANVIL_PID=$$!; \
	sleep 2; \
	OWNER_KEY=$${OWNER_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80} \
	AGENT_KEY=$${AGENT_KEY:-0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d} \
	forge script script/Demo.s.sol --rpc-url http://localhost:8545 --broadcast --slow; \
	RC=$$?; kill $$ANVIL_PID 2>/dev/null; exit $$RC

deploy-sepolia:
	forge script script/Deploy.s.sol --rpc-url ${SEPOLIA_RPC_URL} --broadcast --slow

deploy-amoy:
	forge script script/Deploy.s.sol --rpc-url ${AMOY_RPC_URL} --broadcast --slow

clean:
	forge clean
