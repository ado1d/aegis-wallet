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
             the API server. Runs as a normal process (npm start) or as a
             single Vercel serverless function (api/index.js + vercel.json).
             migrations/ holds the Postgres schema; npm run migrate applies it.
dashboard/   Next.js web app: landing, signup, onboarding, and the
             seven-tab app (Home, Console, Approvals, Activity, Payees,
             Limits, Security). public/ carries the logo assets.
render.yaml  Blueprint that deploys agent + dashboard to Render, free tier
.github/     Uptime workflow for a deployed agent
```

A live install runs on Sepolia: the dashboard at
https://aegis-dashboard-rosy.vercel.app and the agent API at
https://aegis-agent-khaki.vercel.app (see /health). Testnet play money
only.

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

Two parts make up a hosted install: the agent (an HTTP API) and the
dashboard. Both run on Vercel's free tier, and this is how the live demo
above is hosted.

For the agent, import this repository into a Vercel project with the root
directory set to `agent`. Vercel picks up `agent/vercel.json`, which routes
every request to one serverless function (`agent/api/index.js`) with a
300-second limit, so slow on-chain vault provisioning survives. The agent
needs a Postgres database: create one anywhere (Neon and Supabase free
tiers work), set `DATABASE_URL`, then run `npm run migrate` once from
`agent/` with that same `DATABASE_URL`. Set the remaining variables from
`agent/.env.example` in the project's environment settings: `RPC_URL` (a
Sepolia endpoint), `USDC_ADDRESS` and `VENUE_ADDRESS` (from the deploy
script output), `AGENT_KEY` (a funded burner testnet key),
`AEGIS_SERVER_SECRET`, and optionally `OPENAI_API_KEY` for LLM parsing.

For the dashboard, import the repository again with the root directory set
to `dashboard`, and set `NEXT_PUBLIC_AGENT_URL` to the agent's public URL
plus `NEXT_PUBLIC_AEGIS_MODE=product`.

The swap venue is the counterparty of every swap: it pays each buy-side
payout from its own balance, so it needs ETH inventory for USDC to ETH
swaps and USDC inventory for the reverse direction. The deploy script seeds
both once, and since v3.9.4 the agent also refills the venue automatically
from the agent key whenever it runs low (bounded by `VENUE_ETH_TARGET`,
never spending the key's last `VENUE_GAS_RESERVE_ETH` of gas money).
`/health` reports `venueEth` and `agentFuelEth`, so a dry venue or a dry
operational key is a one-curl check. A venue deployed before v3.9.4 never
had its reverse rate set; add it once from the venue owner's key:
`cast send $VENUE "setRate(address,address,uint256,uint256)"
0x0000000000000000000000000000000000000000 $USDC 4000000000 1000000000000000000
--private-key $OWNER_KEY --rpc-url $RPC` (4000000000 / 1e18 encodes $4,000
per ETH; adjust to taste).

Since v3.9.5 the agent also verifies swap prices independently and refuses
swaps it cannot serve, before any money moves:

- every quote is cross-checked against the Chainlink ETH/USD feed (public
  Sepolia aggregator, auto-detected; `ORACLE_FEED` overrides). Beyond
  `ORACLE_MAX_DRIFT_PCT` (default 90, loose because the demo venue's rate
  is fixed by hand; use 2-5 for a market-tracking venue) the swap is
  refused with both prices in the reply; inside the band the reply still
  discloses the venue-versus-market gap. `/health` reports the live oracle
  price.
- a swap whose payout exceeds what the venue can ever hold (current
  balance plus everything the agent key can spare) is refused as too
  large, with the payout and the reachable cap in the reply, instead of
  failing through the inventory error with a misleading hint.
- a swap the risk engine wants a human to look at (score 30-59) is refused
  honestly — the vault contract's approval queue can only hold transfers,
  so there is no queue path for swaps.
- a missing feed (local anvil), a stale answer or an unreachable RPC
  degrades the price check to a visible warning unless `ORACLE_STRICT=true`
  fails it closed.

Since v3.9.6 the refusals themselves are honest about what the user can
actually do:

- over-cap swap refusals point at the real remedies (raise the limit on
  the Limits page and retry, or withdraw and swap outside the vault) —
  the vault has no owner-swap path, so "perform this manually" was a
  dead end and is gone.
- every policy refusal states that the transaction shown next to it is
  the on-chain `logRejection` audit entry and no funds moved — the
  dashboard renders that tx hash as an explorer link, which used to read
  like the rejected swap might have gone through.
- when a venue pair is unpriced (`MockSwap__RateNotSet`), the agent
  probes the opposite direction with one read-only quote and, if the
  venue prices it, says so in the refusal ("The opposite direction
  (USDC → ETH) is currently available"). The rules-fallback parser also
  treats "usd" as USDC in swap direction ("0.04 eth to usd" used to
  silently flip to a sell-USDC parse under the LLM breaker).

On Render, `render.yaml` is a complete alternative blueprint: `aegis-agent`
and `aegis-dashboard` on the free tier, with the secrets marked `sync:
false` set once in the Render dashboard.

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
npm run test:venue         # 44 swap-venue checks: revert naming, inventory
                           # top-up plan, executor swap branch, oracle
                           # price sanity, too-large and review-band refusals
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
