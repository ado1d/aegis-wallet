// Provisioner — gives every new account its own on-chain AegisVault.
//
// Pipeline (one tx at a time, all gas paid by the AGENT key from a single
// operational pot — the user's key pays nothing at signup):
//
//   1. stipend   : send a little ETH to the user's primary key, so the user
//                  can sign their OWN owner ops later (approve, pause,
//                  limits, withdraw). Self-custody starts here.
//   2. deploy    : agent deploys AegisVault(agent) — deployer (agent) is the
//                  INITIAL owner, exactly how CP1 deployed the demo vault.
//   3. configure : as initial owner the agent sets sensible defaults:
//                    tokenPolicy(USDC), tokenPolicy(ETH), swapVenue,
//                    whitelist(Savings pot). The agent cannot whitelist
//                    arbitrary payees — only the user's own savings address.
//   4. transfer  : transferOwnership(user's primary address). From this tx
//                  on, ONLY the user's key can reconfigure the vault. The
//                  agent key remains the bounded operator — nothing more.
//   5. seed      : mint the demo-USDC seed into the vault (MockUSDC.mint is
//                  an open testnet faucet) + send a little native ETH so
//                  "pay 0.01 ETH" and USDC->ETH swaps have inventory.
//
// Every step is idempotent (safe to re-run after a crash or restart) and the
// state machine is persisted in the `vaults` table, so /me/provision can
// show live progress and the server can resume pending provisions at boot.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { config, toBaseUnits } from "./config.js";
import * as chain from "./chain.js";
import { getStore } from "./store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = JSON.parse(readFileSync(resolve(HERE, "../contracts/AegisVault.json"), "utf8"));

const inFlight = new Map(); // userId -> Promise (serializes per user)
let globalQueue = Promise.resolve(); // one provisioning at a time (agent-key nonce safety)

/** Queue provisioning for a user. Returns the in-flight promise. */
export function provisionUser(userId) {
  if (!inFlight.has(userId)) {
    const p = globalQueue.then(() => runProvision(userId)).catch((err) => err);
    globalQueue = p.then(() => {}, () => {});
    inFlight.set(userId, p);
    const clear = () => inFlight.delete(userId);
    p.then(clear, clear);
  }
  return inFlight.get(userId);
}

/** Boot-time resume for vaults stuck mid-pipeline. */
export async function resumePending() {
  const rows = await getStore().listProvisioning();
  for (const row of rows) provisionUser(row.userId);
  return rows.length;
}

/** Boot-time chain-reset sweep. Postgres survives an anvil restart; the chain
 *  does not — every stored vault address suddenly has no code and the first
 *  command used to die with ethers "could not decode result data (value=0x…)".
 *  The provisioner is idempotent, so re-running it over a code-less address
 *  simply deploys a fresh vault, reconfigures guardrails, hands ownership back
 *  to the user's embedded key and re-seeds demo funds. Kicked in the
 *  background at startup; the per-request self-heal in uservault.js covers
 *  resets that happen while the agent is already running. */
export async function healStaleVaults() {
  const store = getStore();

  // The shared plumbing (USDC mock + swap venue) comes from the CP1 deploy
  // script, NOT from the provisioner — if anvil was restarted without re-running
  // it, every provision would fail at setTokenPolicy. Detect and say so loudly.
  for (const [name, addr] of [["USDC_ADDRESS", config.usdc], ["VENUE_ADDRESS", config.venue]]) {
    if (!addr) continue; // missing keys are already reported at startup
    try {
      if ((await chain.provider.getCode(addr)) === "0x") {
        console.error(
          `  [self-heal] ${name} ${addr} has NO CONTRACT CODE — anvil was restarted without re-running the CP1 deploy.\n` +
          `              Fix: cd contracts && forge script script/Deploy.s.sol --rpc-url ${config.rpcUrl} --broadcast\n` +
          `              (then restart the agent so it re-provisions user vaults)`
        );
        return -1;
      }
    } catch { /* rpc hiccup — the per-request path will surface real errors */ }
  }

  const rows = await store.listVaultsWithAddress().catch(() => []);
  const dead = [];
  for (const row of rows) {
    try {
      if ((await chain.provider.getCode(row.address)) === "0x") dead.push(row);
    } catch { /* rpc hiccup — skip this row */ }
  }
  if (!dead.length) return 0;

  // chain-reset evidence: drop the stale in-memory nonces BEFORE sending the
  // recovery txs, or they would target future nonces that never mine
  await chain.resetNonceManagers().catch(() => {});
  for (const row of dead) {
    console.warn(
      `  [self-heal] vault ${row.address} (user ${row.userId.slice(0, 8)}) vanished — chain was reset. Re-provisioning…`
    );
    await store.upsertVault({ userId: row.userId, state: "deploying", error: null });
    provisionUser(row.userId); // background; serialized by globalQueue
  }
  return dead.length;
}

async function setStatus(userId, state, extra = {}) {
  await getStore().upsertVault({ userId, state, ...extra });
}

async function runProvision(userId) {
  const store = getStore();
  const ks = await store.getKeystores(userId);
  if (!ks) return { ok: false, error: "no keystores" };

  const log = (...a) => console.log(`  [provision ${userId.slice(0, 8)}]`, ...a);

  try {
    // ── 1. gas stipend for the user's owner key ─────────────────────────────
    const stipend = ethers.parseEther(String(config.gasStipendEth));
    const userBal = await chain.provider.getBalance(ks.primaryAddress);
    if (userBal < stipend / 2n) {
      await setStatus(userId, "stipend");
      const r = await chain.sendEthFrom(chain.agentWallet, ks.primaryAddress, config.gasStipendEth);
      if (!r.ok) throw new Error(`stipend failed: ${r.revert || r.hash}`);
      log(`stipend ${config.gasStipendEth} ETH -> ${ks.primaryAddress}`);
    }

    // ── 2. deploy the vault (agent = initial owner) ─────────────────────────
    let row = await store.getVault(userId);
    let vaultAddress = row?.address;
    if (!vaultAddress || (await chain.provider.getCode(vaultAddress)) === "0x") {
      await setStatus(userId, "deploying");
      const agentAddress = await chain.agentWallet.getAddress();
      const factory = new ethers.ContractFactory(ARTIFACT.abi, ARTIFACT.bytecode, chain.agentWallet);
      const vault = await factory.deploy(agentAddress);
      const rc = await vault.deploymentTransaction().wait();
      vaultAddress = await vault.getAddress();
      await store.upsertVault({ userId, address: vaultAddress, deployTx: rc.hash, state: "deploying" });
      log(`vault deployed at ${vaultAddress} (tx ${rc.hash})`);
    }

    const vault = new ethers.Contract(vaultAddress, ARTIFACT.abi, chain.provider);
    const vaultAsAgent = vault.connect(chain.agentWallet);

    // ── 3. configure defaults (only while the agent is still the owner) ────
    const owner = await vault.owner();
    const agentAddress = await chain.agentWallet.getAddress();
    if (owner.toLowerCase() === agentAddress.toLowerCase()) {
      await setStatus(userId, "configuring");
      const usdcPolicy = [
        toBaseUnits(config.productUsdcMaxPerTx, 6),
        toBaseUnits(config.productUsdcDaily, 6),
      ];
      const ethPolicy = [
        toBaseUnits(config.productEthMaxPerTx, 18),
        toBaseUnits(config.productEthDaily, 18),
      ];
      const steps = [
        ["setTokenPolicy", [config.usdc, ...usdcPolicy]],
        ["setTokenPolicy", [ethers.ZeroAddress, ...ethPolicy]],
        ["setSwapVenue", [config.venue]],
        ["setWhitelist", [ks.savingsAddress, "Savings", true]],
      ];
      for (const [fn, args] of steps) {
        const r = await chain.send(vaultAsAgent, fn, ...args);
        if (!r.ok) throw new Error(`${fn} failed: ${r.revert || r.hash}`);
      }
      log("configured: USDC/ETH policies, swap venue, Savings payee");
    }

    // ── 4. hand sovereignty to the user ─────────────────────────────────────
    const userIsOwner = (await vault.owner()).toLowerCase() === ks.primaryAddress.toLowerCase();
    if (!userIsOwner) {
      await setStatus(userId, "transferring");
      const r = await chain.send(vaultAsAgent, "transferOwnership", ks.primaryAddress);
      if (!r.ok) throw new Error(`transferOwnership failed: ${r.revert || r.hash}`);
      log(`ownership transferred to ${ks.primaryAddress}`);
    }

    // ── 5. seed demo funds into the vault ───────────────────────────────────
    await setStatus(userId, "seeding");
    const usdcBal = await chain.erc20(config.usdc).balanceOf(vaultAddress);
    if (usdcBal < toBaseUnits(config.usdcSeedAmount, 6) / 2n) {
      const r = await chain.mintMockUsdcFrom(chain.agentWallet, vaultAddress, toBaseUnits(config.usdcSeedAmount, 6));
      if (!r.ok) throw new Error(`usdc seed failed: ${r.revert || r.hash}`);
    }
    const ethBal = await chain.provider.getBalance(vaultAddress);
    if (ethBal < ethers.parseEther(String(config.ethSeedAmount)) / 2n) {
      const r = await chain.sendEthFrom(chain.agentWallet, vaultAddress, config.ethSeedAmount);
      if (!r.ok) throw new Error(`eth seed failed: ${r.revert || r.hash}`);
    }
    log(`seeded ${config.usdcSeedAmount} USDC + ${config.ethSeedAmount} ETH`);

    // ── done ────────────────────────────────────────────────────────────────
    await setStatus(userId, "done");
    await store.addNotification({
      userId,
      kind: "provision",
      title: "Your Aegis vault is live",
      body: `Vault ${vaultAddress} is deployed and funded with ${config.usdcSeedAmount.toLocaleString()} tUSDC. You are its only owner — say hi to Aegis in the console.`,
    });
    await store.addActivity({
      userId, kind: "provision", decision: "done",
      explanation: `Vault ${vaultAddress} deployed, configured and seeded.`,
      txHash: (await store.getVault(userId))?.deployTx || null,
    });
    return { ok: true, address: vaultAddress };
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 400);
    await setStatus(userId, "error", { error: msg });
    console.error(`  [provision ${userId.slice(0, 8)}] ERROR: ${msg}`);
    return { ok: false, error: msg };
  }
}
