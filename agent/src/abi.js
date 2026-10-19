// Minimal hand-written ABI for AegisVault + MockSwap + ERC20.
// Mirrors contracts/src/AegisVault.sol (CP1.1, tag cp1.1) — keep in sync.

export const VAULT_ABI = [
  // ── agent surface (driven by this backend) ────────────────────────────────
  "function agentExecute(address token, address to, uint256 amount, string reason)",
  "function agentSwap(address sellToken, address buyToken, uint256 sellAmount, uint256 minOut, string reason)",
  "function submitForApproval(address token, address to, uint256 amount, uint8 riskScore, string reason)",
  "function logRejection(bytes32 reasonHash, uint8 category)",
  // ── owner surface ─────────────────────────────────────────────────────────
  "function approveTx(uint256 id)",
  "function rejectTx(uint256 id)",
  "function executeApprovedTx(uint256 id)",
  "function pauseAgent()",
  "function resumeAgent()",
  "function revokeAgent()",
  "function setAgent(address newAgent)",
  "function setWhitelist(address who, string label, bool allowed)",
  "function setTokenPolicy(address token, uint256 maxPerTx, uint256 dailyLimit)",
  "function ownerWithdraw(address token, address to, uint256 amount)",
  "function owner() view returns (address)",
  "function transferOwnership(address newOwner)",
  // ── views ─────────────────────────────────────────────────────────────────
  "function agent() view returns (address)",
  "function agentStatus() view returns (uint8)",
  "function spentInWindow(address token) view returns (uint256)",
  "function windowState(address token) view returns (uint256 liveEntries, uint256 capacity)",
  "function getPolicy(address token) view returns (uint256 maxPerTx, uint256 dailyLimit)",
  "function getWhitelist() view returns (address[])",
  "function whitelisted(address) view returns (bool)",
  "function whitelistLabel(address) view returns (string)",
  "function whitelistCount() view returns (uint256)",
  "function queueLength() view returns (uint256)",
  "function getTx(uint256 id) view returns (tuple(address token, address to, uint256 amount, address proposedBy, uint8 riskScore, string reason, uint64 createdAt, uint8 status))",
  "function rejectionCount() view returns (uint256)",
  "function getRejection(uint256 index) view returns (tuple(address actor, bytes32 reasonHash, uint8 category, uint64 at))",
  "function NATIVE() view returns (address)",
  "function swapVenue() view returns (address)",
  // ── events (for the audit-trail poller) ───────────────────────────────────
  "event AgentExecuted(uint256 seq, address indexed token, address indexed to, uint256 amount, uint256 spentInWindow, string reason, bytes32 indexed rationaleHash)",
  "event AgentSwapped(uint256 seq, address indexed sellToken, address indexed buyToken, uint256 sellAmount, uint256 outAmount, uint256 minOut, uint256 spentInWindow, string reason, bytes32 indexed rationaleHash)",
  "event TxQueued(uint256 indexed id, address token, address indexed to, uint256 amount, uint8 riskScore, string reason, bytes32 indexed rationaleHash)",
  "event TxApproved(uint256 indexed id, address token, address to, uint256 amount)",
  "event TxRejected(uint256 indexed id)",
  "event ApprovedTxExecuted(uint256 indexed id, address token, address to, uint256 amount)",
  "event RejectionLogged(uint256 indexed seq, address indexed actor, bytes32 indexed reasonHash, uint8 category, uint64 at)",
  "event WhitelistUpdated(address indexed who, string label, bool allowed)",
  "event VaultDeployed(address indexed owner, address indexed agent)",
  "event TokenPolicyUpdated(address indexed token, uint256 oldMaxPerTx, uint256 newMaxPerTx, uint256 oldDailyLimit, uint256 newDailyLimit)",
  "event SwapVenueUpdated(address indexed oldVenue, address indexed newVenue)",
  "event AgentUpdated(address indexed oldAgent, address indexed newAgent)",
  "event AgentPaused(uint256 at)",
  "event AgentResumed(uint256 at)",
  "event AgentRevoked(uint256 at)",
  "event Deposited(address indexed token, address indexed from, uint256 amount)",
  "event OwnerWithdrawal(address indexed token, address indexed to, uint256 amount)",
  // ── custom errors (so explainRevert can decode the REAL revert reason —
  //    without these every revert surfaces as "unknown custom error") ────────
  "error Aegis__NotOwner(address caller)",
  "error Aegis__NotAgent(address caller)",
  "error Aegis__AgentPaused()",
  "error Aegis__AgentRevoked()",
  "error Aegis__InvalidRecipient()",
  "error Aegis__InvalidAmount()",
  "error Aegis__RecipientNotWhitelisted(address recipient)",
  "error Aegis__ExceedsPerTxLimit(address token, uint256 requested, uint256 cap)",
  "error Aegis__ExceedsDailyLimit(address token, uint256 spent, uint256 requested, uint256 cap)",
  "error Aegis__InsufficientBalance(address token, uint256 available, uint256 needed)",
  "error Aegis__EthTransferFailed()",
  "error Aegis__InvalidAgentStatus(uint8 current)",
  "error Aegis__InvalidTxId(uint256 id)",
  "error Aegis__TxNotQueued(uint256 id, uint8 current)",
  "error Aegis__TxNotApproved(uint256 id, uint8 current)",
  "error Aegis__TxNotRejectable(uint256 id, uint8 current)",
  "error Aegis__AmountTooLargeToMeter(uint256 amount)",
  "error Aegis__DailyWindowUncertain(address token)",
  "error Aegis__SwapVenueNotSet()",
  "error Aegis__InvalidSwap(address sellToken, address buyToken)",
  "error Aegis__SwapBelowMinOut(uint256 received, uint256 minimum)",
  "error Aegis__NotAuthorizedToLog(address caller)",
];

export const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  // OpenZeppelin v5 custom errors — these bubble up through the vault's
  // ERC-20 calls (the venue pulls the sell asset from the vault and pays out
  // the buy asset from its own inventory), so decoding them names an
  // inventory shortfall instead of "unknown custom error"
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
];

export const VENUE_ABI = [
  "function quote(address sellToken, address buyToken, uint256 sellAmount) view returns (uint256)",
  "function setRate(address sellToken, address buyToken, uint256 num, uint256 den)",
  // MockSwap's own reverts, mirrored from contracts/src/mocks/MockSwap.sol.
  // Without these in any interface the agent knows, every venue failure
  // surfaced as an opaque "unknown custom error": the pre-flight correctly
  // rejected the doomed swap but could not say WHY. With them the revert
  // names the real cause (e.g. MockSwap__EthPayoutFailed = the venue has no
  // ETH inventory left to pay out). Keep in sync with the contract.
  "error MockSwap__NotOwner(address caller)",
  "error MockSwap__RateNotSet(address sellToken, address buyToken)",
  "error MockSwap__BelowMinOut(uint256 outAmount, uint256 minOut)",
  "error MockSwap__BadMsgValue(uint256 got, uint256 want)",
  "error MockSwap__EthPayoutFailed()",
];

/** RejectionCategory enum from AegisVault.sol — mirrored off-chain. */
export const REJECTION_CATEGORY = {
  Uncategorised: 0,
  CapPerTx: 1,
  CapWindow: 2,
  Whitelist: 3,
  AgentInactive: 4,
  OwnerRejected: 5,
  RiskEngine: 6,
  Slippage: 7,
  Balance: 8,
};
export const CATEGORY_NAME = Object.fromEntries(
  Object.entries(REJECTION_CATEGORY).map(([k, v]) => [v, k])
);

export const AGENT_STATUS = ["None", "Active", "Paused", "Revoked"];
export const TX_STATUS = ["Queued", "Approved", "Rejected", "Executed"];
