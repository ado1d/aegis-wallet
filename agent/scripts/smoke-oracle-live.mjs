// Live smoke: run the REAL oracle module against the REAL Sepolia feed and
// the REAL venue rate (read-only: eth_call only, no transactions, no keys).
// Verifies the exact path the deployed agent will execute on every swap.
import { ethers } from "ethers";
import { ethUsdPrice, venueRateSanity, oracleDisclosure } from "../src/oracle.js";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const provider = new ethers.JsonRpcProvider(RPC);

const VENUE = "0x579C95774d25Cc0364B098603F20296d96020e01";
const USDC = "0xD02cB73d9dBeE60747805C23C33d2DB41F831Dd4";
const VENUE_ABI = ["function quote(address,address,uint256) view returns (uint256)", "function rate(address,address,uint256) view returns (uint256)"];

const venue = new ethers.Contract(VENUE, VENUE_ABI, provider);

const o = await ethUsdPrice(provider);
console.log("oracle:", JSON.stringify(o));

const q50 = await venue.quote(USDC, ethers.ZeroAddress, 50_000000n);
const expectedOutHuman = Number(q50) / 1e18;
console.log("venue quote: 50 USDC ->", expectedOutHuman, "ETH (implied $" + (50 / expectedOutHuman).toFixed(2) + "/ETH)");

const s = venueRateSanity({ sellSymbol: "USDC", buySymbol: "ETH", sellAmountHuman: 50, expectedOutHuman }, o.priceUsd);
console.log("sanity:", JSON.stringify(s));
console.log("disclosure:", JSON.stringify(oracleDisclosure(s)));

// the 10x case: what the guard is really for
const bad = venueRateSanity({ sellSymbol: "USDC", buySymbol: "ETH", sellAmountHuman: 50, expectedOutHuman: expectedOutHuman / 10 }, o.priceUsd);
console.log("10x-off rate:", JSON.stringify(bad));

if (!o.priceUsd || !s.ok || !bad.verdict.includes("off-market") || !oracleDisclosure(s).includes("Chainlink")) {
  console.error("SMOKE FAILED");
  process.exit(1);
}
console.log("SMOKE OK");
