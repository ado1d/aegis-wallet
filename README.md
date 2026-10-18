# Aegis Wallet

An AI agent that moves money inside on-chain guardrails. You type an
instruction in plain language, the agent works out the intent, scores the
risk, and either executes the payment inside limits you control or holds it
for your approval. The limits live in a smart contract, so they hold even if
the agent is buggy, tricked, or replaced.

The repository carries the complete product in three parts: the Solidity
vault, the agent backend, and the web app. Everything runs on testnets with
mock USDC. There is no real money anywhere in this project.

Built for the 2026 Shenzhen International FinTech Competition,
International Track, Topic F (Agent Wallet).

## The five on-chain guardrails

AegisVault is the smart contract that holds the funds. The agent proposes;
the contract disposes. The agent never holds the user's key and cannot move
a cent outside these rules:

| # | Guardrail | How it is enforced |
|---|-----------|--------------------|
| 1 | Kill switch | `pauseAgent()` freezes everything the agent can do. `revokeAgent()` is sticky: only an explicit `setAgent()` re-grants it. Owner functions keep working either way. |
| 2 | Whitelist floor | Agent funds can only move to owner-approved addresses. Re-checked on-chain at execution time, so it applies to auto-executed and queued transactions alike. |
| 3 | Per-transaction cap | `agentExecute` / `agentSwap` above `maxPerTx` (per asset) reverts with `Aegis__ExceedsPerTxLimit`. |
| 4 | Rolling 24-hour cap | Cumulative agent outflow per asset inside any sliding 24-hour window is capped. A spend stops counting exactly 24 hours after it happens; there is no midnight reset, so the "full cap before and after 00:00" boundary burst is impossible. Human-approved executions are exempt. |
| 5 | Approval queue | Over-limit proposals wait in a queue with a risk score and the agent's reason until the owner approves or rejects them. |

## What happens to a command

A message like "savings se landlord ko 50 dollar bhejo" goes through a fixed
pipeline. First the intent parser extracts the action, token, amount, and
recipient; it accepts about 25 language families plus code-mixing, so
Banglish, Hinglish, or Spanish mixed with English all parse. An LLM does the
parsing when a key is configured, with a deterministic rules parser as
fallback, and a circuit breaker drops to rules instantly if the LLM endpoint
is unreachable so replies never stall. Conversation memory lets a partial
answer ("savings") complete the question asked one turn earlier, and
commands like "revert koro" cancel every pending approval on-chain.

Second, the risk engine scores the instruction across five families:
lookalike payee labels, contract codesize checks, amount anomalies against
history, velocity over a rolling window, and embedding similarity (optional,
via a MiniLM endpoint). Third, the policy mirror decides execute, queue, or
reject. Anything the agent executes is pre-flight simulated on-chain; if the
chain disagrees with the off-chain mirror, the action is refused and logged.
Every decision lands in an audit journal, the activity feed, and the vault's
own event log.

## Repository layout

```
contracts/   Foundry project: AegisVault, deployment script, 75 tests
             (lib/ carries vendored OpenZeppelin and forge-std, kept so a
             fresh clone builds with no extra setup)
agent/       Node backend: accounts, per-user vaults, intent, risk, policy,
             the API server (Express-style, port 8787)
dashboard/   Next.js web app: landing, signup, onboarding, and the
             seven-tab app (Home, Console, Approvals, Activity, Payees,
             Limits, Security)
render.yaml  Blueprint that deploys agent + dashboard to Render, free tier
.github/     Uptime workflow for a deployed agent
```

## Quick start (local)

You need Node 18.17 or newer, Git, and Foundry (`curl -L https://foundry.paradigm.xyz | bash`). Postgres is optional: with an empty `DATABASE_URL` the agent uses an in-memory store, and accounts vanish on restart, which is fine for a first look.

Terminal 1, the chain:

```bash
cd aegis-wallet/contracts
anvil
```

Terminal 2, deploy the shared demo assets (fresh anvil addresses are deterministic):

```bash
cd aegis-wallet/contracts
OWNER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
AGENT_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
  forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --slow
```

Terminal 3, the agent:

```bash
cd aegis-wallet/agent
npm install
cp .env.example .env
node -e "console.log('AEGIS_SERVER_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
# put that value in .env, plus:
#   AEGIS_MODE=product
#   RPC_URL=http://127.0.0.1:8545
#   USDC_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3
#   VENUE_ADDRESS=0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
#   LLM_PROVIDER=auto        (add OPENAI_API_KEY for LLM parsing, or leave rules-only)
npm run migrate     # skip if DATABASE_URL is empty
node src/server.js
```

Terminal 4, the web app:

```bash
cd aegis-wallet/dashboard
npm install
printf 'NEXT_PUBLIC_AEGIS_MODE=product\nNEXT_PUBLIC_AGENT_URL=http://127.0.0.1:8787\n' > .env.local
npm run dev
```

Open http://localhost:3000. Create an account and watch the onboarding screen provision your own vault: a fresh keypair, a real AegisVault deployment, caps of 1,000 tUSDC per transaction and 2,500 per day, a Savings payee, a top-up of 5,000 tUSDC and 0.05 ETH, then `transferOwnership` to your address. For a one-click login instead, run `npm run seed:demo` in `agent/` and use demo@aegis.app with aegis-demo-2026.

Every variable is documented in `agent/.env.example` and
`dashboard/.env.example`. The default keys above are the well-known public
anvil accounts; they exist for local demos only.

## Deployment

Two services make up a hosted install: the agent (a long-running Node
process) and the dashboard (a static Next.js build).

For Render, `render.yaml` is a complete blueprint: `aegis-agent` and
`aegis-dashboard` on the free tier, with the secrets marked `sync: false`
set once in the Render dashboard. Point a Render account at this repository
and the blueprint creates both services.

For Vercel, import this repository, set the root directory to `dashboard`,
and set `NEXT_PUBLIC_AGENT_URL` to the public agent URL plus
`NEXT_PUBLIC_AEGIS_MODE=product`. The agent itself still needs a Node host;
the Render blueprint above covers it.

To use the uptime workflow, set an `AGENT_URL` secret in the repository's
Actions settings. The check works in both agent modes and fails loudly when
the deployed demo is down.

## Testing

From `contracts/`: `make test` runs 75 tests across four suites (core,
user stories, hardening, invariant fuzz); `make coverage` currently reports
100% lines and functions.

From `agent/`, all of these run offline with no chain and no API key:

```bash
npm run eval               # acceptance gate: 134 intent utterances
                           # (133 action matches, 1 documented divergence),
                           # 60 precision cases at 100%, 30 prompt-injection
                           # attempts, all blocked
npm run test:convo         # 26 conversation-memory checks
npm run test:multilingual  # 66 multilingual and code-mixing cases
npm run test:llm           # 24 fuzzy-matching + LLM network behavior checks
npm run test:breaker       # circuit-breaker half-open cycle
npm run e2e:product        # 28-check product run (needs a live local stack)
```

## Security notes

This is testnet software and has not been audited. Do not put mainnet keys
or real funds in it. The default keys in `.env.example` are public anvil
accounts that anyone can read. In a hosted setup, give the agent its own
funded testnet key: the guardrails cap what the agent can do, but only the
owner's key can change the rules, and the whitelist is re-checked on-chain
at execution time. Prompt-injection attempts are treated as untrusted input
before any parsing happens, which is why the eval gate blocks all 30
attempts across direct, embedded, and fake-system channels.

## Contributing

Clone, run `npm install` in `agent/` and `dashboard/`, and run the test
suites above before opening a pull request; keep changes offline-testable
where possible. Changes to intent parsing should add cases to the eval
corpora in `agent/eval/corpora/` rather than only to ad hoc scripts, so the
acceptance gate keeps covering them. Commit messages follow the conventional
commits format (`feat:`, `fix:`, `docs:`, and so on).

## License

MIT. See [LICENSE](LICENSE).
