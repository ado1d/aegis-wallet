// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @notice Minimal interface for the swap venue the vault trades through.
 *         `swap` receives the sell asset (ERC-20 pre-approved pull, or
 *         `msg.value` for native ETH) and pays out the buy asset to `msg.sender`.
 */
interface ISwapVenue {
    function swap(address sellToken, address buyToken, uint256 sellAmount, uint256 minOut)
        external
        payable
        returns (uint256 outAmount);
}

/**
 * @title AegisVault — on-chain guardrails for an autonomous AI agent.
 *
 * @notice Aegis Wallet separates *judgement* from *enforcement*:
 *          - The AI agent (off-chain) decides WHAT to do and PROPOSES actions.
 *          - This contract (on-chain) decides what is ALLOWED and ENFORCES it.
 *
 *         Five hard rules are enforced by the contract, not by the agent:
 *
 *           1. Kill switch     — owner can pause / revoke the agent instantly.
 *                                Revocation is sticky: only an explicit
 *                                `setAgent` re-grants access.
 *           2. Whitelist       — agent funds can ONLY move to owner-approved
 *                                addresses. Absolute floor, applies to both the
 *                                auto-execute path and the approval queue.
 *           3. Per-transaction cap — agent auto-transfers above the asset cap
 *                                revert; the agent must ask the owner instead.
 *           4. Rolling 24h cap — cumulative agent outflow per asset inside any
 *                                24-hour sliding window is capped (CP1.1: this
 *                                replaces the fixed UTC-day ledger, so the
 *                                boundary-burst "full cap before AND after
 *                                midnight" exposure is closed). Entries expire
 *                                exactly 24 hours after they were spent.
 *           5. Approval queue  — over-limit proposals sit in a queue until the
 *                                owner approves / rejects them. Human-approved
 *                                executions are exempt from agent caps (the
 *                                human took responsibility), but the whitelist
 *                                floor is re-checked at execution time.
 *
 *         CP1.1 hardening additions:
 *          - Rolling-window metering via a per-token ring buffer that FAILS
 *            CLOSED: if the buffer is full (64 live entries) the contract
 *            reverts with `Aegis__DailyWindowUncertain` rather than risk
 *            under-counting (PRD invariant INV-3).
 *          - `agentSwap`: a venue-based swap (MockSwap, fixed rate, minOut
 *            floor) that consumes the SAME rolling window on the sell-side
 *            asset as transfers — unified accounting, no swap-shaped bypass.
 *          - `logRejection`: a permanent on-chain rejection ledger. The agent
 *            records attempts its off-chain policy engine refused, and owner
 *            `rejectTx` decisions are auto-logged with the same event.
 *          - `rationaleHash` (keccak256 of the agent's reason string) emitted
 *            as an INDEXED topic on every agent action event, so full
 *            rationales can be attested and filtered off-chain without
 *            bloating calldata.
 *
 * @dev Design philosophy (documented for reviewers):
 *          - The agent NEVER holds a user key. It holds its own low-value key
 *            and can only call `agentExecute` / `submitForApproval` /
 *            `agentSwap` / `logRejection`.
 *          - The owner is sovereign: `ownerWithdraw` has NO whitelist/limit
 *            restrictions (it is the user's money and the emergency recovery
 *            path). Every owner action is event-logged for auditability.
 *          - Amounts are expressed in the asset's own smallest unit
 *            (USDC = 6 decimals; native ETH = wei). Each asset has its own
 *            policy, so a multi-asset portfolio (e.g. 60/40 ETH/USDC) can be
 *            bounded per asset without price oracles.
 *          - The swap venue is owner-configured (`setSwapVenue`) — an explicit
 *            trust decision equivalent to whitelisting. The agent cannot
 *            choose where to trade, and swap output always returns to the
 *            vault, so the agent cannot use swaps to route funds to
 *            arbitrary addresses.
 *
 *      Aegis Wallet — 2026 Shenzhen International FinTech Competition,
 *      International Track, Topic F (Agent Wallet).
 *      Deploy target: Sepolia testnet (testnet evidence accepted per the
 *      organizing committee's 2026-10-13 email).
 */
contract AegisVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // =====================================================================
    // Types
    // =====================================================================

    enum AgentStatus {
        None, // 0 — no agent configured
        Active, // 1 — agent may act within limits
        Paused, // 2 — kill switch: every agent action rejected
        Revoked // 3 — sticky kill switch: only `setAgent` can re-grant
        //        (intentionally NO resume path from Revoked)
    }

    enum TxStatus {
        Queued, // 0 — waiting for the owner
        Approved, // 1 — owner signed off, awaiting execution
        Rejected, // 2 — owner declined
        Executed // 3 — funds moved
    }

    /// @notice Rejection categories for the on-chain rejection ledger
    ///         (mirrored off-chain by the risk engine / dashboard).
    enum RejectionCategory {
        Uncategorised, // 0
        CapPerTx, // 1 — per-transaction cap would be exceeded
        CapWindow, // 2 — rolling 24h window would be exceeded
        Whitelist, // 3 — recipient not whitelisted
        AgentInactive, // 4 — agent paused / revoked
        OwnerRejected, // 5 — owner declined a queued proposal
        RiskEngine, // 6 — off-chain risk engine refused pre-flight
        Slippage, // 7 — swap output below minOut (slippage guard)
        Balance // 8 — vault balance insufficient
    }

    /// @notice Per-asset autonomy envelope for the agent.
    struct TokenPolicy {
        uint256 maxPerTx; // largest single auto-executed transfer / swap sell
        uint256 dailyLimit; // largest cumulative agent outflow per rolling 24h
    }

    /// @notice One item of the human-approval queue.
    struct PendingTx {
        address token; // asset (address(0) = native ETH)
        address to; // must be whitelisted (checked on submit AND execute)
        uint256 amount;
        address proposedBy; // the agent address that proposed it
        uint8 riskScore; // 0-100, assigned by the AI risk engine
        string reason; // human-readable justification (shown in dashboard)
        uint64 createdAt;
        TxStatus status;
    }

    /// @notice One spend record inside a rolling window.
    struct SpendEntry {
        uint64 ts; // block timestamp when the spend happened
        uint128 amount; // agent outflow in the asset's smallest unit
    }

    /// @notice Fixed-capacity ring buffer of recent spends (per asset).
    struct RollingWindow {
        SpendEntry[64] entries; // ring storage, oldest live entry at `head`
        uint8 head; // ring index of the oldest live entry
        uint8 count; // number of live (possibly expired) entries
    }

    /// @notice One entry of the on-chain rejection ledger.
    struct Rejection {
        address actor; // agent (policy pre-check refusal) or owner (rejectTx)
        bytes32 reasonHash; // keccak256 of the human-readable reason
        uint8 category; // RejectionCategory
        uint64 at; // block timestamp
    }

    // =====================================================================
    // Storage
    // =====================================================================

    /// @dev Sentinel asset address for native ETH.
    address public constant NATIVE = address(0);

    /// @dev Sliding-window length: a spend counts against the cap for exactly
    ///      24 hours after it happens (no calendar-day reset, no boundary burst).
    uint256 public constant WINDOW = 24 hours;

    /// @dev Ring-buffer capacity per asset. 64 entries is far beyond the
    ///      agent's realistic hourly rate; if it is ever exhausted the window
    ///      FAILS CLOSED with `Aegis__DailyWindowUncertain`.
    uint256 public constant WINDOW_CAPACITY = 64;

    address public agent;
    AgentStatus public agentStatus;

    /// @notice asset => autonomy envelope for that asset.
    mapping(address => TokenPolicy) public tokenPolicy;

    /// @notice asset => rolling 24h spend ring buffer (agent paths only).
    mapping(address => RollingWindow) private _windows;

    /// @notice Owner-configured swap venue (MockSwap). address(0) = swaps off.
    address public swapVenue;

    /// @notice Monotonic counter of guardrail-relevant actions (audit ordering).
    uint256 public seq;

    mapping(address => bool) public whitelisted;
    mapping(address => string) public whitelistLabel;
    address[] private _whitelist;
    mapping(address => uint256) private _wlIndex; // 1-based slot, 0 = absent

    PendingTx[] private _queue; // tx id = index + 1 (ids start at 1)
    uint256 public nextTxId = 1;

    /// @notice The on-chain rejection ledger (agent pre-check refusals,
    ///         owner rejections of queued proposals).
    Rejection[] private _rejections;

    // =====================================================================
    // Errors (custom errors => cheap + readable revert evidence)
    // =====================================================================

    error Aegis__NotOwner(address caller);
    error Aegis__NotAgent(address caller);
    error Aegis__AgentPaused();
    error Aegis__AgentRevoked();
    error Aegis__InvalidRecipient();
    error Aegis__InvalidAmount();
    error Aegis__RecipientNotWhitelisted(address recipient);
    error Aegis__ExceedsPerTxLimit(address token, uint256 requested, uint256 cap);
    error Aegis__ExceedsDailyLimit(address token, uint256 spent, uint256 requested, uint256 cap);
    error Aegis__InsufficientBalance(address token, uint256 available, uint256 needed);
    error Aegis__EthTransferFailed();
    error Aegis__InvalidAgentStatus(uint8 current);
    error Aegis__InvalidTxId(uint256 id);
    error Aegis__TxNotQueued(uint256 id, uint8 current);
    error Aegis__TxNotApproved(uint256 id, uint8 current);
    error Aegis__TxNotRejectable(uint256 id, uint8 current);
    // ---- CP1.1 hardening ----
    error Aegis__AmountTooLargeToMeter(uint256 amount); // > uint128 max: fail closed
    error Aegis__DailyWindowUncertain(address token); // ring buffer full: fail closed
    error Aegis__SwapVenueNotSet();
    error Aegis__InvalidSwap(address sellToken, address buyToken);
    error Aegis__SwapBelowMinOut(uint256 received, uint256 minimum);
    error Aegis__NotAuthorizedToLog(address caller);

    // =====================================================================
    // Events (indexed for the dashboard + on-chain execution evidence)
    // =====================================================================

    event VaultDeployed(address indexed owner, address indexed agent);
    event TokenPolicyUpdated(
        address indexed token, uint256 oldMaxPerTx, uint256 newMaxPerTx, uint256 oldDailyLimit, uint256 newDailyLimit
    );
    event WhitelistUpdated(address indexed who, string label, bool allowed);
    event AgentUpdated(address indexed oldAgent, address indexed newAgent);
    event AgentPaused(uint256 at);
    event AgentResumed(uint256 at);
    event AgentRevoked(uint256 at);
    event Deposited(address indexed token, address indexed from, uint256 amount);
    event AgentExecuted(
        uint256 seq, // ordering is preserved by log order; not a topic
        address indexed token,
        address indexed to,
        uint256 amount,
        uint256 spentInWindow,
        string reason,
        bytes32 indexed rationaleHash
    );
    event TxQueued(
        uint256 indexed id,
        address token,
        address indexed to,
        uint256 amount,
        uint8 riskScore,
        string reason,
        bytes32 indexed rationaleHash
    );
    event TxApproved(uint256 indexed id, address token, address to, uint256 amount);
    event TxRejected(uint256 indexed id);
    event ApprovedTxExecuted(uint256 indexed id, address token, address to, uint256 amount);
    event OwnerWithdrawal(address indexed token, address indexed to, uint256 amount);
    // ---- CP1.1 hardening ----
    event AgentSwapped(
        uint256 seq, // ordering is preserved by log order; not a topic
        address indexed sellToken,
        address indexed buyToken,
        uint256 sellAmount,
        uint256 outAmount,
        uint256 minOut,
        uint256 spentInWindow,
        string reason,
        bytes32 indexed rationaleHash
    );
    event RejectionLogged(
        uint256 indexed seq, address indexed actor, bytes32 indexed reasonHash, uint8 category, uint64 at
    );
    event SwapVenueUpdated(address indexed oldVenue, address indexed newVenue);

    // =====================================================================
    // Modifiers
    // =====================================================================

    modifier onlyVaultOwner() {
        if (msg.sender != owner()) revert Aegis__NotOwner(msg.sender);
        _;
    }

    // =====================================================================
    // Constructor
    // =====================================================================

    /// @param agent_ The AI executor's address. Pass address(0) to deploy a
    ///               vault with no agent and configure it later via `setAgent`.
    constructor(address agent_) Ownable(msg.sender) {
        if (agent_ != address(0)) {
            agent = agent_;
            agentStatus = AgentStatus.Active;
        }
        emit VaultDeployed(owner(), agent_);
    }

    // =====================================================================
    // Agent execution path — bounded autonomy (User Stories 1, 2A, 4)
    // =====================================================================

    /**
     * @notice Auto-execute a transfer inside the guardrail envelope.
     *         Enforcement order: agent status -> recipient whitelist ->
     *         per-tx cap -> rolling 24h window -> vault balance. Any failure
     *         reverts with a named error the dashboard can decode and explain.
     * @param token  Asset to transfer (address(0) = native ETH).
     * @param to     MUST be whitelisted by the owner.
     * @param amount Must be <= policy.maxPerTx and fit in the rolling window.
     * @param reason Free-text justification from the AI (hash emitted indexed).
     */
    function agentExecute(address token, address to, uint256 amount, string calldata reason) external nonReentrant {
        _requireActiveAgent();

        if (to == address(0)) revert Aegis__InvalidRecipient();
        if (amount == 0) revert Aegis__InvalidAmount();
        if (amount > type(uint128).max) revert Aegis__AmountTooLargeToMeter(amount);
        if (!whitelisted[to]) revert Aegis__RecipientNotWhitelisted(to);

        TokenPolicy memory p = tokenPolicy[token];
        if (amount > p.maxPerTx) revert Aegis__ExceedsPerTxLimit(token, amount, p.maxPerTx);

        uint256 spentAfter = _checkAndPushWindow(token, amount, p.dailyLimit);

        _checkBalance(token, amount);
        _out(token, to, amount);

        seq += 1;
        emit AgentExecuted(seq, token, to, amount, spentAfter, reason, keccak256(bytes(reason)));
    }

    /**
     * @notice Agent swaps one vault asset for another through the owner-set
     *         venue (MockSwap: fixed rate, minOut floor). Unified accounting:
     *         the SELL-side amount is metered against the sell asset's
     *         per-tx cap and rolling 24h window exactly like a transfer, so
     *         swaps cannot be used to bypass the spend limits. The buy asset
     *         always returns to the vault; the agent never chooses the venue.
     *
     *         Enforcement order: agent status -> venue set -> valid pair ->
     *         per-tx cap -> rolling window (sell side) -> balance -> venue
     *         call (reverts below minOut, which rolls the window entry back).
     *
     * @param sellToken  Asset to sell (address(0) = native ETH).
     * @param buyToken   Asset to buy (address(0) = native ETH).
     * @param sellAmount Sell amount in the sell asset's smallest unit.
     * @param minOut     Minimum acceptable buy amount (slippage guard).
     * @param reason     Free-text justification from the AI.
     */
    function agentSwap(address sellToken, address buyToken, uint256 sellAmount, uint256 minOut, string calldata reason)
        external
        nonReentrant
    {
        _requireActiveAgent();

        if (swapVenue == address(0)) revert Aegis__SwapVenueNotSet();
        if (sellToken == buyToken) revert Aegis__InvalidSwap(sellToken, buyToken);
        if (sellAmount == 0) revert Aegis__InvalidAmount();
        if (sellAmount > type(uint128).max) revert Aegis__AmountTooLargeToMeter(sellAmount);

        TokenPolicy memory p = tokenPolicy[sellToken];
        if (sellAmount > p.maxPerTx) revert Aegis__ExceedsPerTxLimit(sellToken, sellAmount, p.maxPerTx);

        // Unified accounting: swaps consume the sell asset's rolling window.
        uint256 spentAfter = _checkAndPushWindow(sellToken, sellAmount, p.dailyLimit);

        _checkBalance(sellToken, sellAmount);

        // Interaction last: any venue revert (incl. below-minOut) rolls the
        // window entry and the sell-side transfer back atomically. The venue
        // pulls the ERC-20 sell side, so approve the exact amount first
        // (allowance returns to zero once pulled — no lingering approvals).
        if (sellToken != NATIVE) {
            IERC20(sellToken).forceApprove(swapVenue, sellAmount);
        }
        uint256 outAmount = ISwapVenue(swapVenue).swap{value: sellToken == NATIVE ? sellAmount : 0}(
            sellToken, buyToken, sellAmount, minOut
        );
        if (outAmount < minOut) revert Aegis__SwapBelowMinOut(outAmount, minOut);

        seq += 1;
        emit AgentSwapped(
            seq, sellToken, buyToken, sellAmount, outAmount, minOut, spentAfter, reason, keccak256(bytes(reason))
        );
    }

    /**
     * @notice Agent proposes an over-limit transfer (or any transfer it wants
     *         a human to co-sign). Nothing moves here — the proposal waits in
     *         the queue until the owner approves or rejects it.
     *         The whitelist floor still applies: the agent can never queue a
     *         transfer to a non-whitelisted address.
     */
    function submitForApproval(address token, address to, uint256 amount, uint8 riskScore, string calldata reason)
        external
    {
        _requireActiveAgent();

        if (to == address(0)) revert Aegis__InvalidRecipient();
        if (amount == 0) revert Aegis__InvalidAmount();
        if (!whitelisted[to]) revert Aegis__RecipientNotWhitelisted(to);

        _queue.push(
            PendingTx({
                token: token,
                to: to,
                amount: amount,
                proposedBy: msg.sender,
                riskScore: riskScore,
                reason: reason,
                createdAt: uint64(block.timestamp),
                status: TxStatus.Queued
            })
        );

        uint256 id = nextTxId;
        nextTxId += 1;
        seq += 1;
        emit TxQueued(id, token, to, amount, riskScore, reason, keccak256(bytes(reason)));
    }

    /**
     * @notice Record a REFUSED action on-chain (the rejection ledger).
     *         The agent calls this when its off-chain policy pre-check stops
     *         an action (saving the gas of a doomed transaction and creating
     *         permanent negative-decision evidence). Owner `rejectTx`
     *         decisions are logged automatically with the same event.
     *         Works while the agent is paused/revoked: blocked attempts
     *         during a kill-switch are exactly the evidence you want.
     *         No funds move here, ever.
     * @param reasonHash keccak256 of the human-readable refusal reason.
     * @param category   One of `RejectionCategory` (0-8).
     */
    function logRejection(bytes32 reasonHash, uint8 category) external {
        if (msg.sender != agent && msg.sender != owner()) {
            revert Aegis__NotAuthorizedToLog(msg.sender);
        }

        _rejections.push(
            Rejection({actor: msg.sender, reasonHash: reasonHash, category: category, at: uint64(block.timestamp)})
        );

        seq += 1;
        emit RejectionLogged(seq, msg.sender, reasonHash, category, uint64(block.timestamp));
    }

    // =====================================================================
    // Owner decision path — human-in-the-loop (User Story 2B)
    // =====================================================================

    /// @notice Owner signs off on a queued proposal (funds do not move yet).
    function approveTx(uint256 id) external onlyVaultOwner {
        PendingTx storage p = _getTx(id);
        if (p.status != TxStatus.Queued) revert Aegis__TxNotQueued(id, uint8(p.status));

        p.status = TxStatus.Approved;
        seq += 1;
        emit TxApproved(id, p.token, p.to, p.amount);
    }

    /// @notice Owner declines a queued proposal (allowed before or after
    ///         approval). The decision is ALSO appended to the rejection
    ///         ledger — negative decisions stay auditable on-chain.
    function rejectTx(uint256 id) external onlyVaultOwner {
        PendingTx storage p = _getTx(id);
        if (p.status != TxStatus.Queued && p.status != TxStatus.Approved) {
            revert Aegis__TxNotRejectable(id, uint8(p.status));
        }

        p.status = TxStatus.Rejected;
        bytes32 reasonHash = keccak256(bytes(p.reason));
        _rejections.push(
            Rejection({
                actor: msg.sender,
                reasonHash: reasonHash,
                category: uint8(RejectionCategory.OwnerRejected),
                at: uint64(block.timestamp)
            })
        );

        seq += 1;
        emit TxRejected(id);
        emit RejectionLogged(
            seq, msg.sender, reasonHash, uint8(RejectionCategory.OwnerRejected), uint64(block.timestamp)
        );
    }

    /**
     * @notice Execute an approved proposal.
     *         Exempt from per-tx/rolling-window caps (the human took
     *         responsibility), but the whitelist floor and vault balance are
     *         re-checked — so a recipient delisted between approval and
     *         execution is refused.
     */
    function executeApprovedTx(uint256 id) external onlyVaultOwner nonReentrant {
        PendingTx storage p = _getTx(id);
        if (p.status != TxStatus.Approved) revert Aegis__TxNotApproved(id, uint8(p.status));
        if (!whitelisted[p.to]) revert Aegis__RecipientNotWhitelisted(p.to);

        _checkBalance(p.token, p.amount);

        p.status = TxStatus.Executed;
        _out(p.token, p.to, p.amount);

        seq += 1;
        emit ApprovedTxExecuted(id, p.token, p.to, p.amount);
    }

    // =====================================================================
    // Kill switch (User Story 5)
    // =====================================================================

    /// @notice Freeze all agent actions. Owner operations keep working.
    function pauseAgent() external onlyVaultOwner {
        _requireStatus(AgentStatus.Active);
        agentStatus = AgentStatus.Paused;
        seq += 1;
        emit AgentPaused(block.timestamp);
    }

    /// @notice Lift a pause. NOTE: impossible from Revoked — revocation is
    ///         sticky and only `setAgent` can re-grant agent access.
    function resumeAgent() external onlyVaultOwner {
        _requireStatus(AgentStatus.Paused);
        agentStatus = AgentStatus.Active;
        seq += 1;
        emit AgentResumed(block.timestamp);
    }

    /// @notice Permanently strip the current agent's authority.
    function revokeAgent() external onlyVaultOwner {
        if (agentStatus != AgentStatus.Active && agentStatus != AgentStatus.Paused) {
            revert Aegis__InvalidAgentStatus(uint8(agentStatus));
        }
        agentStatus = AgentStatus.Revoked;
        seq += 1;
        emit AgentRevoked(block.timestamp);
    }

    /// @notice Rotate or (re-)install the agent key. Pass address(0) to clear.
    ///         This is the ONLY way back from Revoked — a deliberate re-auth.
    function setAgent(address newAgent) external onlyVaultOwner {
        address old = agent;
        agent = newAgent;
        agentStatus = newAgent == address(0) ? AgentStatus.None : AgentStatus.Active;
        seq += 1;
        emit AgentUpdated(old, newAgent);
    }

    // =====================================================================
    // Owner configuration
    // =====================================================================

    /// @notice Set the agent's autonomy envelope for one asset.
    ///         Both zero => agent loses auto-execute rights for that asset
    ///         (it can still use the approval queue).
    function setTokenPolicy(address token, uint256 maxPerTx, uint256 dailyLimit) external onlyVaultOwner {
        TokenPolicy memory old = tokenPolicy[token];
        tokenPolicy[token] = TokenPolicy({maxPerTx: maxPerTx, dailyLimit: dailyLimit});
        seq += 1;
        emit TokenPolicyUpdated(token, old.maxPerTx, maxPerTx, old.dailyLimit, dailyLimit);
    }

    /// @notice Add / remove (and label) a whitelisted recipient.
    function setWhitelist(address who, string calldata label, bool allowed) external onlyVaultOwner {
        if (who == address(0)) revert Aegis__InvalidRecipient();

        whitelisted[who] = allowed;
        whitelistLabel[who] = label;

        if (allowed && _wlIndex[who] == 0) {
            _whitelist.push(who);
            _wlIndex[who] = _whitelist.length;
        } else if (!allowed && _wlIndex[who] != 0) {
            uint256 i = _wlIndex[who] - 1;
            address last = _whitelist[_whitelist.length - 1];
            _whitelist[i] = last;
            _wlIndex[last] = i + 1;
            _whitelist.pop();
            delete _wlIndex[who];
        }

        seq += 1;
        emit WhitelistUpdated(who, label, allowed);
    }

    /// @notice Install the swap venue the agent may trade through (MockSwap).
    ///         Setting address(0) disables `agentSwap` entirely. This is an
    ///         explicit owner trust decision — the agent cannot pick venues.
    function setSwapVenue(address venue) external onlyVaultOwner {
        address old = swapVenue;
        swapVenue = venue;
        seq += 1;
        emit SwapVenueUpdated(old, venue);
    }

    // =====================================================================
    // Deposits & sovereign owner path
    // =====================================================================

    /// @notice Deposit native ETH (explicit form; plain sends hit `receive`).
    function deposit() external payable {
        if (msg.value == 0) revert Aegis__InvalidAmount();
        emit Deposited(NATIVE, msg.sender, msg.value);
    }

    receive() external payable {
        emit Deposited(NATIVE, msg.sender, msg.value);
    }

    /// @notice Deposit an ERC-20 asset (pull pattern).
    function depositERC20(address token, uint256 amount) external nonReentrant {
        if (token == address(0)) revert Aegis__InvalidRecipient();
        if (amount == 0) revert Aegis__InvalidAmount();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(token, msg.sender, amount);
    }

    /**
     * @notice Sovereign withdrawal — NO whitelist, NO limits, by design.
     *         It is the owner's money and this is the emergency recovery path.
     *         Every withdrawal is event-logged for auditability.
     */
    function ownerWithdraw(address token, address to, uint256 amount) external onlyVaultOwner nonReentrant {
        if (to == address(0)) revert Aegis__InvalidRecipient();
        if (amount == 0) revert Aegis__InvalidAmount();

        _checkBalance(token, amount);
        _out(token, to, amount);

        seq += 1;
        emit OwnerWithdrawal(token, to, amount);
    }

    // =====================================================================
    // Views (dashboard helpers)
    // =====================================================================

    /// @notice Agent outflow for an asset inside the CURRENT rolling 24h
    ///         window (auto path only: agentExecute + agentSwap sell side).
    ///         View-only: does not prune; expired entries simply add zero.
    function spentInWindow(address token) public view returns (uint256 sum) {
        RollingWindow storage w = _windows[token];
        for (uint256 i = 0; i < w.count; i++) {
            SpendEntry storage e = w.entries[(w.head + i) % WINDOW_CAPACITY];
            if (e.ts + WINDOW > block.timestamp) sum += e.amount;
        }
    }

    /// @notice Live ring-buffer usage for an asset (dashboard health panel).
    ///         `liveEntries` counts unexpired records; when it reaches
    ///         `capacity` the next agent spend fails CLOSED.
    function windowState(address token) external view returns (uint256 liveEntries, uint256 capacity) {
        RollingWindow storage w = _windows[token];
        uint256 live;
        for (uint256 i = 0; i < w.count; i++) {
            if (w.entries[(w.head + i) % WINDOW_CAPACITY].ts + WINDOW > block.timestamp) live++;
        }
        return (live, WINDOW_CAPACITY);
    }

    function getPolicy(address token) external view returns (uint256 maxPerTx, uint256 dailyLimit) {
        TokenPolicy memory p = tokenPolicy[token];
        return (p.maxPerTx, p.dailyLimit);
    }

    function getWhitelist() external view returns (address[] memory) {
        return _whitelist;
    }

    function whitelistCount() external view returns (uint256) {
        return _whitelist.length;
    }

    function queueLength() external view returns (uint256) {
        return nextTxId - 1;
    }

    function getTx(uint256 id) external view returns (PendingTx memory) {
        return _getTx(id);
    }

    function rejectionCount() external view returns (uint256) {
        return _rejections.length;
    }

    function getRejection(uint256 index) external view returns (Rejection memory) {
        require(index < _rejections.length, "Aegis: rejection index out of range");
        return _rejections[index];
    }

    // =====================================================================
    // Internals
    // =====================================================================

    function _requireActiveAgent() internal view {
        if (msg.sender != agent) revert Aegis__NotAgent(msg.sender);
        if (agentStatus == AgentStatus.Paused) revert Aegis__AgentPaused();
        if (agentStatus == AgentStatus.Revoked) revert Aegis__AgentRevoked();
        // agent == address(0) => caught by NotAgent above.
        // agent != 0 with status None is unreachable: every setter keeps them in sync.
    }

    function _requireStatus(AgentStatus expected) internal view {
        if (agentStatus != expected) revert Aegis__InvalidAgentStatus(uint8(agentStatus));
    }

    function _checkBalance(address token, uint256 amount) internal view {
        uint256 bal = token == NATIVE ? address(this).balance : IERC20(token).balanceOf(address(this));
        if (bal < amount) revert Aegis__InsufficientBalance(token, bal, amount);
    }

    function _out(address token, address to, uint256 amount) internal {
        if (token == NATIVE) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert Aegis__EthTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function _getTx(uint256 id) internal view returns (PendingTx storage p) {
        if (id == 0 || id >= nextTxId) revert Aegis__InvalidTxId(id);
        p = _queue[id - 1];
    }

    /**
     * @dev Rolling-window gate + record (the CP1.1 heart).
     *
     *      1. Lazily prune entries older than 24h from the ring head
     *         (timestamps are monotonic, so expired entries are contiguous).
     *      2. Sum the remaining live entries.
     *      3. Refuse the new amount if (live sum + amount) would exceed the
     *         asset's `dailyLimit`.
     *      4. FAIL CLOSED: if the ring buffer is still full after pruning,
     *         revert with `Aegis__DailyWindowUncertain` — the window must
     *         never under-count (PRD invariant INV-3).
     *      5. Push the new spend. Runs inside the caller's revert scope, so
     *         a failed downstream transfer rolls the record back atomically.
     */
    function _checkAndPushWindow(address token, uint256 amount, uint256 cap) internal returns (uint256 spentAfter) {
        RollingWindow storage w = _windows[token];

        // 1. lazy prune (expired entries live at the head of the ring)
        while (w.count > 0) {
            SpendEntry storage oldest = w.entries[w.head];
            if (oldest.ts + WINDOW > block.timestamp) break; // still live
            delete w.entries[w.head];
            w.head = uint8((uint256(w.head) + 1) % WINDOW_CAPACITY);
            w.count -= 1;
        }

        // 2. live sum
        uint256 sum;
        for (uint256 i = 0; i < w.count; i++) {
            SpendEntry storage e = w.entries[(w.head + i) % WINDOW_CAPACITY];
            if (e.ts + WINDOW > block.timestamp) sum += e.amount; // belt & braces
        }

        // 3. window cap
        if (sum + amount > cap) revert Aegis__ExceedsDailyLimit(token, sum, amount, cap);

        // 4. fail closed — never under-count
        if (w.count == WINDOW_CAPACITY) revert Aegis__DailyWindowUncertain(token);

        // 5. record
        w.entries[(uint256(w.head) + w.count) % WINDOW_CAPACITY] =
            SpendEntry({ts: uint64(block.timestamp), amount: uint128(amount)});
        w.count += 1;

        return sum + amount;
    }
}
