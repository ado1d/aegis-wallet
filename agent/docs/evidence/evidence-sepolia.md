# Aegis Wallet: on-chain evidence pack (sepolia)

Vault `0xe2501aAe11f790a4ef5195364C855e8468b9Da28` · chainId **11155111** · blocks 11947000–11948364 · generated 2026-10-19T13:07:58.129Z
Regenerate any time: `node harvest-evidence.mjs`; this pack is read from chain state and cannot drift.

| Class | Evidence | Have / need | Status |
|---|---|---|---|
| **C1** L1 transfer execution (agent key alone, inside guardrails) | 3 | 3 / 3 | PASS |
| **C2** Rebalancing swap via MockSwap (slippage floor enforced) | 2 | 2 / 2 | PASS |
| **C3** On-chain rejection (logRejection ledger) | 6 | 6 / 2 | PASS |
| **C4** Deliberately reverted transaction (direct call, manual gas limit) | 1 | 1 / 1 | PASS |
| **C5** Approval round trip (queue → approve → execute) | 6 | 6 / 3 | PASS |
| **C6** Kill switch (pause + resume) | 8 | 8 / 2 | PASS |
| **C7** Policy / whitelist configuration (on-chain policy state) | 14 | 14 / 2 | PASS |
| **Total unique tx hashes** | 34 | 34 / 15 | PASS |

**Submission gate: PASS, pack is submission-ready**

## C1: L1 transfer execution (agent key alone, inside guardrails) (3/3)

| Tx | Block | Time | What it proves |
|---|---|---|---|
| [0x053b111f31…7fb7d074](https://sepolia.etherscan.io/tx/0x053b111f31011e38e613050d94013106f72a04f2a43dc7261a10f5fe7fb7d074) | 11948208 | 2026-10-19 12:36:00 UTC | execute 25 USDC → 0x11c024Bf…6Ae86f · "User requested transferring 25 USDC to the Savings label." · window after: 25 USDC |
| [0x44522f5ae0…f07e411d](https://sepolia.etherscan.io/tx/0x44522f5ae0714ad159b29ad305cb69361c27f325aeb49bd067fa9b75f07e411d) | 11948209 | 2026-10-19 12:36:12 UTC | execute 15 USDC → 0x11c024Bf…6Ae86f · "User requested transferring 15 USDC to Savings." · window after: 40 USDC |
| [0x64edf1fb75…6d1d9559](https://sepolia.etherscan.io/tx/0x64edf1fb75bf9b6ac62ea1678ecbf82e82f3e514ebfa8fe822fcb2326d1d9559) | 11948210 | 2026-10-19 12:36:24 UTC | execute 40 USDC → 0x11c024Bf…6Ae86f · "User requests transferring 40 USDC to Savings." · window after: 80 USDC |

## C2: Rebalancing swap via MockSwap (slippage floor enforced) (2/2)

| Tx | Block | Time | What it proves |
|---|---|---|---|
| [0xd84fa983ad…cbb3fb16](https://sepolia.etherscan.io/tx/0xd84fa983ad3f8cb1b494f0559ed75a00fa6821b15fc4097d5f19eabdcbb3fb16) | 11948260 | 2026-10-19 12:46:48 UTC | swap 50 USDC → 0.02064145381887537 ETH (minOut 0.02033183201159224 ETH enforced) · "User requested swapping 50 USDC for ETH." |
| [0xb91a639f94…7a1f55d0](https://sepolia.etherscan.io/tx/0xb91a639f94a9a4b24a7372a3d8f533127b95dc8c19fd840beec37d567a1f55d0) | 11948262 | 2026-10-19 12:47:12 UTC | swap 50 USDC → 0.02064145381887537 ETH (minOut 0.02033183201159224 ETH enforced) · "User requested swapping 50 USDC for ETH." |

## C3: On-chain rejection (logRejection ledger) (6/2)

| Tx | Block | Time | What it proves |
|---|---|---|---|
| [0x351ba56284…f6f6138f](https://sepolia.etherscan.io/tx/0x351ba56284eef2a57246f84760160544a976e1535020a37152b8b391f6f6138f) | 11948213 | 2026-10-19 12:37:24 UTC | rejection ledger entry · category Whitelist · actor 0x5f2D170E…376C2D |
| [0xd1dde5fb63…31b300ce](https://sepolia.etherscan.io/tx/0xd1dde5fb634e8e60e9feca042cdacdc04d39f8274d59f43d59ef1dd931b300ce) | 11948256 | 2026-10-19 12:46:00 UTC | rejection ledger entry · category OwnerRejected · actor 0xb177fC9f…Ce7D72 |
| [0x117e477cf2…8b6193ad](https://sepolia.etherscan.io/tx/0x117e477cf23bffc5131e64b047053439ef6c8efd3e9ac576c257a8818b6193ad) | 11948258 | 2026-10-19 12:46:24 UTC | rejection ledger entry · category OwnerRejected · actor 0xb177fC9f…Ce7D72 |
| [0x923e77885b…3dd44408](https://sepolia.etherscan.io/tx/0x923e77885bb54fb59c8cd2f2b0fed6964349b28afd8a34655ee9b2183dd44408) | 11948259 | 2026-10-19 12:46:36 UTC | rejection ledger entry · category OwnerRejected · actor 0xb177fC9f…Ce7D72 |
| [0x11a5d834cb…93161417](https://sepolia.etherscan.io/tx/0x11a5d834cb2831bcd040167927e94ca38f9072bfe9bc75252cc5859993161417) | 11948263 | 2026-10-19 12:47:24 UTC | rejection ledger entry · category CapPerTx · actor 0x5f2D170E…376C2D |
| [0x21bd59bfd0…46ff5714](https://sepolia.etherscan.io/tx/0x21bd59bfd03866722fd7bf57c995433e21b0a0a750b5d86e67486f6546ff5714) | 11948275 | 2026-10-19 12:49:48 UTC | rejection ledger entry · category OwnerRejected · actor 0xb177fC9f…Ce7D72 |

## C4: Deliberately reverted transaction (direct call, manual gas limit) (1/1)

| Tx | Block | Time | What it proves |
|---|---|---|---|
| [0xc0fc4ee605…9529f51d](https://sepolia.etherscan.io/tx/0xc0fc4ee605a08a405de45df89bec7e4a8cb8c4b2c2acb34843a1cc7a9529f51d) | 11948353 | 2026-10-19T13:05:00Z | agentExecute(5,000 USDC) called directly from the vault OWNER's exported key (self-custody export route), gas limit forced to 400,000 so the revert is MINED on-chain (status 0, 32,682 gas, block 11,948,353). Revert reason: Aegis__NotAgent, the contract refused the vault's own owner: role separation is enforced on-chain, so bypassing the AI backend gains nothing. Every guardrail lives in the contract, not the prompt. |

## C5: Approval round trip (queue → approve → execute) (6/3)

| Tx | Block | Time | What it proves |
|---|---|---|---|
| [0x2ce337b79b…25bb48a7](https://sepolia.etherscan.io/tx/0x2ce337b79b42083ea83a0780b92211a97ab8c889cfc2b92a7b46b16325bb48a7) | 11948213 | 2026-10-19 12:37:24 UTC | queue proposal #1: 1300000000 USDC → 0x11c024Bf…6Ae86f (risk score 55) · "User requested transferring USDC to Savings. [risk 30/100; over per-transaction cap]" |
| [0xfba3c5ed18…e63e6aa1](https://sepolia.etherscan.io/tx/0xfba3c5ed18084732d084886b7140189fda011744068944ffd210b726e63e6aa1) | 11948214 | 2026-10-19 12:37:36 UTC | queue proposal #2: 1200000000 USDC → 0x11c024Bf…6Ae86f (risk score 55) · "Amount exceeds the per-transaction cap and requires owner approval. [risk 30/100; over per-transaction cap]" |
| [0x2df5976882…8596107b](https://sepolia.etherscan.io/tx/0x2df597688241dbf81cc30d5dbf9825b77858abdcb02ef923c69449938596107b) | 11948215 | 2026-10-19 12:37:48 UTC | owner approves proposal #1: 1300000000 USDC → 0x11c024Bf…6Ae86f (human-in-the-loop) |
| [0x361de0ca62…3e3b9750](https://sepolia.etherscan.io/tx/0x361de0ca6245fb10b74d2fc213fba6f032c7583e9bca707d9726642d3e3b9750) | 11948254 | 2026-10-19 12:45:36 UTC | queue proposal #3: 1300 USDC → 0x11c024Bf…6Ae86f (risk score 35) · "User asked to transfer 1300 USDC to the Savings label. [risk 10/100; over per-transaction cap]" |
| [0x4fc3a0f48f…6b97ca44](https://sepolia.etherscan.io/tx/0x4fc3a0f48f9d6d6b6958dcd1217f43f0e5636bdddd86099bff5483626b97ca44) | 11948255 | 2026-10-19 12:45:48 UTC | queue proposal #4: 1200 USDC → 0x11c024Bf…6Ae86f (risk score 35) · "User requested transferring 1200 USDC to Savings. [risk 10/100; over per-transaction cap]" |
| [0xeafb4797f2…eed96d76](https://sepolia.etherscan.io/tx/0xeafb4797f21fbf17401124b35f85684beaa50670d4ae8ff43a65643aeed96d76) | 11948256 | 2026-10-19 12:46:00 UTC | owner approves proposal #2: 1200000000 USDC → 0x11c024Bf…6Ae86f (human-in-the-loop) |

## C6: Kill switch (pause + resume) (8/2)

| Tx | Block | Time | What it proves |
|---|---|---|---|
| [0xd1dde5fb63…31b300ce](https://sepolia.etherscan.io/tx/0xd1dde5fb634e8e60e9feca042cdacdc04d39f8274d59f43d59ef1dd931b300ce) | 11948256 | 2026-10-19 12:46:00 UTC | owner rejects proposal #2 |
| [0x117e477cf2…8b6193ad](https://sepolia.etherscan.io/tx/0x117e477cf23bffc5131e64b047053439ef6c8efd3e9ac576c257a8818b6193ad) | 11948258 | 2026-10-19 12:46:24 UTC | owner rejects proposal #3 |
| [0x923e77885b…3dd44408](https://sepolia.etherscan.io/tx/0x923e77885bb54fb59c8cd2f2b0fed6964349b28afd8a34655ee9b2183dd44408) | 11948259 | 2026-10-19 12:46:36 UTC | owner rejects proposal #1 |
| [0xd9d8e7059a…7a25b6ac](https://sepolia.etherscan.io/tx/0xd9d8e7059aea9b4990aefa217a3593ef1090a5518cec5a9ccba6fc397a25b6ac) | 11948264 | 2026-10-19 12:47:36 UTC | kill switch: agent PAUSED by owner; every agent action now refuses on-chain |
| [0x28d2e4970d…07182318](https://sepolia.etherscan.io/tx/0x28d2e4970d93c223cff9e157e47aec5a45c4959d6398fbf041d91adb07182318) | 11948265 | 2026-10-19 12:47:48 UTC | kill switch: agent RESUMED by owner; autonomy restored |
| [0x21bd59bfd0…46ff5714](https://sepolia.etherscan.io/tx/0x21bd59bfd03866722fd7bf57c995433e21b0a0a750b5d86e67486f6546ff5714) | 11948275 | 2026-10-19 12:49:48 UTC | owner rejects proposal #4 |
| [0xdfb2cb86dc…5bf58970](https://sepolia.etherscan.io/tx/0xdfb2cb86dc1d9b5c0760e3066b8c18753c8e820e3aceac8b53d7c6455bf58970) | 11948276 | 2026-10-19 12:50:00 UTC | kill switch: agent PAUSED by owner; every agent action now refuses on-chain |
| [0x4cb82e4ed6…5ead3043](https://sepolia.etherscan.io/tx/0x4cb82e4ed6a989485eb417e5adbd2d003204cef8c199ce61cee2d60e5ead3043) | 11948278 | 2026-10-19 12:50:24 UTC | kill switch: agent RESUMED by owner; autonomy restored |

## C7: Policy / whitelist configuration (on-chain policy state) (14/2)

| Tx | Block | Time | What it proves |
|---|---|---|---|
| [0x87a1c6f045…43247b3d](https://sepolia.etherscan.io/tx/0x87a1c6f045324b1652f661e59719a0fe9b5370dbdd546fe8c285907243247b3d) | 11948198 | 2026-10-19 12:34:00 UTC | vault deployed · owner 0x5f2D170E…376C2D · agent 0x5f2D170E…376C2D |
| [0x45107a1a66…f9e17291](https://sepolia.etherscan.io/tx/0x45107a1a668a48c9b45e6aa58523b82c5466a816945f54f46a18afecf9e17291) | 11948199 | 2026-10-19 12:34:12 UTC | policy USDC: per-tx cap 0 USDC → 1000 USDC, rolling-24h window 0 USDC → 2500 USDC |
| [0x50e0e097bb…48aceebf](https://sepolia.etherscan.io/tx/0x50e0e097bb38f568e45fdd60a402c6a3b064ff5a93b7606f01d3470248aceebf) | 11948200 | 2026-10-19 12:34:24 UTC | policy ETH: per-tx cap 0 ETH → 0.05 ETH, rolling-24h window 0 ETH → 0.2 ETH |
| [0xc16e58b32e…65560ac0](https://sepolia.etherscan.io/tx/0xc16e58b32ecdf18f1acb0efeaba5f6bc16d1296c463cfc94ded0dce665560ac0) | 11948202 | 2026-10-19 12:34:48 UTC | swap venue set → 0x579C9577…020e01 |
| [0x2045c1b3e3…fc64a936](https://sepolia.etherscan.io/tx/0x2045c1b3e3220206805e6c1fbe01c5ad9aa74e62c9ce1d787b058d3ffc64a936) | 11948203 | 2026-10-19 12:35:00 UTC | whitelist ADD: 0x11c024Bf…6Ae86f "Savings" |
| [0x4abaf6f427…f421a289](https://sepolia.etherscan.io/tx/0x4abaf6f4277221774c27529924764c9bfc39f65d9ffee2968811d49cf421a289) | 11948207 | 2026-10-19 12:35:48 UTC | deposit into vault: 0.003 ETH from 0x5f2D170E…376C2D |
| [0xd84fa983ad…cbb3fb16](https://sepolia.etherscan.io/tx/0xd84fa983ad3f8cb1b494f0559ed75a00fa6821b15fc4097d5f19eabdcbb3fb16) | 11948260 | 2026-10-19 12:46:48 UTC | deposit into vault: 0.02064145381887537 ETH from 0x579C9577…020e01 |
| [0xb91a639f94…7a1f55d0](https://sepolia.etherscan.io/tx/0xb91a639f94a9a4b24a7372a3d8f533127b95dc8c19fd840beec37d567a1f55d0) | 11948262 | 2026-10-19 12:47:12 UTC | deposit into vault: 0.02064145381887537 ETH from 0x579C9577…020e01 |
| [0x7186b7c9e7…aa8e3f79](https://sepolia.etherscan.io/tx/0x7186b7c9e7aea8ed7e40a53972c3c93ab423b1fc7f3ffbf1801d576eaa8e3f79) | 11948266 | 2026-10-19 12:48:00 UTC | policy USDC: per-tx cap 1000 USDC → 800 USDC, rolling-24h window 2500 USDC → 3000 USDC |
| [0x53f66a8eaf…6c900373](https://sepolia.etherscan.io/tx/0x53f66a8eaf4796b9b76fb97478ae77e4c32b4fea156eff9da53a4c106c900373) | 11948267 | 2026-10-19 12:48:12 UTC | whitelist ADD: 0x22222222…222222 "Evidence Charity" |
| [0xe394223868…ee11fef3](https://sepolia.etherscan.io/tx/0xe394223868b01d86b278b0c2f469a63a194faaafdd89174883411028ee11fef3) | 11948268 | 2026-10-19 12:48:24 UTC | policy USDC: per-tx cap 800 USDC → 1000 USDC, rolling-24h window 3000 USDC → 2500 USDC |
| [0x276553867c…e06abb3c](https://sepolia.etherscan.io/tx/0x276553867c8d2036d6a3e334167407c94df2b7702bdacbb288040185e06abb3c) | 11948279 | 2026-10-19 12:50:36 UTC | policy USDC: per-tx cap 1000 USDC → 800 USDC, rolling-24h window 2500 USDC → 3000 USDC |
| [0x8a92c47fb8…4e05054d](https://sepolia.etherscan.io/tx/0x8a92c47fb8ab1b168d53bf6879749fa26d6db70071fc43c511b9ed684e05054d) | 11948281 | 2026-10-19 12:51:00 UTC | whitelist ADD: 0x22222222…222222 "Evidence Charity" |
| [0x1fe5c459fa…1fab11a9](https://sepolia.etherscan.io/tx/0x1fe5c459fad775165f67b3ffc84c0e0353d20602ae94bf22520af6db1fab11a9) | 11948282 | 2026-10-19 12:51:12 UTC | policy USDC: per-tx cap 800 USDC → 1000 USDC, rolling-24h window 3000 USDC → 2500 USDC |

