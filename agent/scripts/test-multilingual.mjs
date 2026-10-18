// Multilingual + code-mixing battery for the rules intent parser.
// Runs the real parser (agent/src/intent.js) against the eval fixture
// whitelist and asserts action + recipient + amount for every supported
// language family, plus the English from-phrase regression cases and
// cross-lingual guardrails.
// Usage: npm run test:multilingual   (from agent/, no chain and no LLM key)
import { parseIntentRules } from "../src/intent.js";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync(new URL("../eval/fixture-state.json", import.meta.url), "utf8"));
const wl = fixture.whitelist; // Savings Wallet | Rent - Landlord | Mom | Payroll - Acme Corp

let pass = 0, fail = 0;
const t = (name, text, exp) => {
  const r = parseIntentRules(text, wl, { USDC: { available: true } });
  const got = {
    action: r.action,
    recipient: r.recipient ? r.recipient.value : null,
    amount: r.amount ?? null,
  };
  let ok = got.action === exp.action;
  if (exp.recipient !== undefined) ok = ok && got.recipient === exp.recipient;
  if (exp.amount !== undefined) ok = ok && got.amount === exp.amount;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(26)} ${JSON.stringify(text)} -> ${got.action} ${got.recipient ?? ""} ${got.amount ?? ""}`);
};

// ── English regression (the from-phrase fix + corpus anchors) ──────────────
t("EN from-phrase (fixed)", "send 50 dollars from savings to mom", { action: "transfer", recipient: "Mom", amount: 50 });
t("EN trailing from (fixed)", "pay mom 50 from savings", { action: "transfer", recipient: "Mom", amount: 50 });
t("EN classic", "send $50 to mom", { action: "transfer", recipient: "Mom", amount: 50 });
t("EN sweep", "sweep 300 dollars to my savings wallet", { action: "transfer", recipient: "Savings Wallet", amount: 300 });
t("EN word amount", "pay mom eighty dollars", { action: "transfer", recipient: "Mom", amount: 80 });
t("EN no recipient -> ask", "move 50 from savings", { action: "clarify", recipient: null });

// ── South Asian ─────────────────────────────────────────────────────────────
t("Banglish", "tui amr savings theke landlord ke 50 dollar patha", { action: "transfer", recipient: "Rent - Landlord", amount: 50 });
t("Hinglish", "savings se landlord ko 50 dollar bhejo", { action: "transfer", recipient: "Rent - Landlord", amount: 50 });
t("Hindi (Devanagari)", "माँ को 50 रुपये भेजो", { action: "transfer", recipient: "Mom", amount: 50 });
t("Bengali script mixed", "savings থেকে landlord কে ৫০ ডলার পাঠাও", { action: "transfer", recipient: "Rent - Landlord", amount: 50 });
t("Bengali+EN payee mix", "savings থেকে mom কে 50 dollars পাঠাও", { action: "transfer", recipient: "Mom", amount: 50 });
t("Urdu", "ام کو 50 روپیہ بھیجو", { action: "transfer", recipient: "Mom", amount: 50 });
t("Tamil", "அம்மாவிற்கு 50 ரூபாய் அனுப்பு", { action: "transfer", recipient: "Mom", amount: 50 });

// ── East / Southeast Asian ──────────────────────────────────────────────────
t("Chinese mixed", "从savings转50美元给landlord", { action: "transfer", recipient: "Rent - Landlord", amount: 50 });
t("Chinese verb-first", "给妈妈转50美元", { action: "transfer", recipient: "Mom", amount: 50 });
t("Pinyin mixed", "cong savings zhuan 50 meiyuan gei landlord", { action: "transfer", recipient: "Rent - Landlord", amount: 50 });
t("Japanese", "ママに50ドル送って", { action: "transfer", recipient: "Mom", amount: 50 });
t("Korean", "엄마에게 50달러 보내줘", { action: "transfer", recipient: "Mom", amount: 50 });
t("Thai", "โอน 50 บาท ให้แม่", { action: "transfer", recipient: "Mom", amount: 50 });
t("Vietnamese", "gửi 50 đô cho mom", { action: "transfer", recipient: "Mom", amount: 50 });
t("Indonesian", "kirim 50 dollar ke landlord", { action: "transfer", recipient: "Rent - Landlord", amount: 50 });
t("Tagalog", "padala ng 50 dollar kay mom", { action: "transfer", recipient: "Mom", amount: 50 });

// ── European ────────────────────────────────────────────────────────────────
t("Spanish", "envía 50 dólares de savings a landlord", { action: "transfer", recipient: "Rent - Landlord", amount: 50 });
t("Spanish mama", "manda 30 dolares a mama", { action: "transfer", recipient: "Mom", amount: 30 });
t("Portuguese", "envia 50 dolares de savings para o casero", { action: "transfer", recipient: "Rent - Landlord", amount: 50 });
t("French", "envoie 50 euros de savings à maman", { action: "transfer", recipient: "Mom", amount: 50 });
t("French donne", "donne 50 euros à maman", { action: "transfer", recipient: "Mom", amount: 50 });
t("German", "schicke 50 euro von savings an landlord", { action: "transfer", recipient: "Rent - Landlord", amount: 50 });
t("Turkish", "mom'a 50 dolar gönder", { action: "transfer", recipient: "Mom", amount: 50 });
t("Russian", "отправь 50 долларов маме", { action: "transfer", recipient: "Mom", amount: 50 });

// ── Middle East / Africa ────────────────────────────────────────────────────
t("Arabic", "أرسل 50 دولار إلى mom", { action: "transfer", recipient: "Mom", amount: 50 });
t("Arabic full", "أرسل 50 دولار من savings إلى landlord", { action: "transfer", recipient: "Rent - Landlord", amount: 50 });
t("Hebrew", "שלח 50 שקל לאמא", { action: "transfer", recipient: "Mom", amount: 50 });
t("Swahili", "tuma 50 kwa mama", { action: "transfer", recipient: "Mom", amount: 50 });

// ── guardrails stay language-proof ─────────────────────────────────────────
t("FR guard: not a payee", "donne 50 euros de savings à papa", { action: "clarify", recipient: null });
t("HI query", "मेरा balance कितना है?", { action: "query" });
t("ES query", "cuánto dinero tengo?", { action: "query" });
t("ZH query", "余额还有多少", { action: "query" });
t("ZH swap", "把50美元换成ETH", { action: "swap", amount: 50 });
t("ES swap", "convierte 50 dolares a eth", { action: "swap", amount: 50 });
t("EN address", "send 50 dollars to 0x1234567890abcdef1234567890abcdef12345678", { action: "transfer", recipient: "0x1234567890abcdef1234567890abcdef12345678", amount: 50 });

// ── v3.4: deposit / "bring money in" verbs ─────────────────────────────────
t("BD deposit ano", "amr savings e 10 usd ano", { action: "transfer", recipient: "Savings Wallet", amount: 10 });
t("BD deposit daalo", "50 taka savings e daalo", { action: "transfer", recipient: "Savings Wallet", amount: 50 });
t("BD deposit rakho", "savings e 100 taka rakho", { action: "transfer", recipient: "Savings Wallet", amount: 100 });
t("EN deposit put", "put 100 dollars into my savings wallet", { action: "transfer", recipient: "Savings Wallet", amount: 100 });
t("EN deposit deposit", "deposit 50 to savings wallet", { action: "transfer", recipient: "Savings Wallet", amount: 50 });
t("EN top up", "top up my savings wallet with 25 dollars", { action: "transfer", recipient: "Savings Wallet", amount: 25 });
t("EN load", "load 80 dollars into savings wallet", { action: "transfer", recipient: "Savings Wallet", amount: 80 });
t("EN add", "add 40 dollars to savings wallet", { action: "transfer", recipient: "Savings Wallet", amount: 40 });
t("doller typo", "100 doller amr saving e pathao", { action: "transfer", recipient: "Savings Wallet", amount: 100 });
t("RU top-up", "сбережения пополни на 100 долларов", { action: "transfer", recipient: "Savings Wallet", amount: 100 });
t("HI daalo", "savings me 50 rupaye daalo", { action: "transfer", recipient: "Savings Wallet", amount: 50 });
t("ZH deposit", "存入100美元到savings", { action: "transfer", recipient: "Savings Wallet", amount: 100 });
t("ES deposit", "deposita 50 dolares en savings", { action: "transfer", recipient: "Savings Wallet", amount: 50 });
t("PT deposit", "coloca 50 dolares na savings", { action: "transfer", recipient: "Savings Wallet", amount: 50 });
t("deposit EN from-phrase", "put 100 dollars from savings into mom", { action: "transfer", recipient: "Mom", amount: 100 });

// ── v3.4: greetings get a warm reply, never hijack commands ────────────────
t("BD greeting", "kire ki khobor", { action: "clarify", recipient: null });
t("EN greeting", "hello", { action: "clarify", recipient: null });
t("ES greeting", "hola", { action: "clarify", recipient: null });
t("KR greeting", "안녕하세요", { action: "clarify", recipient: null });
t("greeting+command = command", "hi, please send 50 dollars to mom", { action: "transfer", recipient: "Mom", amount: 50 });
t("hello+deposit = deposit", "hello can you put 100 dollars into savings wallet", { action: "transfer", recipient: "Savings Wallet", amount: 100 });

// greeting message content checks (opener in kind + payees listed)
{
  const g = parseIntentRules("kire ki khobor", wl, { USDC: { available: true } });
  const okG = g.action === "clarify" && /Ki khobor!/.test(g.clarify || "") && /Your payees:/.test(g.clarify || "");
  okG ? pass++ : fail++;
  console.log(`${okG ? "PASS" : "FAIL"}  greeting reply content     -> ${(g.clarify || "").slice(0, 90)}`);
  const h = parseIntentRules("hola que tal", wl, { USDC: { available: true } });
  const okH = h.action === "clarify" && /Hola!/.test(h.clarify || "");
  okH ? pass++ : fail++;
  console.log(`${okH ? "PASS" : "FAIL"}  greeting matches language  -> ${(h.clarify || "").slice(0, 90)}`);
}

// ── v3.4: fresh account (Savings only) — clarify TEACHES the payees ────────
{
  const fresh = [{ address: "0x" + "ab".repeat(20), label: "Savings" }];
  const r = parseIntentRules("amr savings theke 10 usd landlord ke pathao", fresh, { USDC: { available: true } });
  const okF = r.action === "clarify" && /Your payees: Savings/.test(r.clarify || "") && /could not determine/i.test(r.clarify || "");
  okF ? pass++ : fail++;
  console.log(`${okF ? "PASS" : "FAIL"}  fresh-account payee hint    -> ${(r.clarify || "").slice(0, 110)}`);
  const r2 = parseIntentRules("amr savings e 10 usd ano", fresh, { USDC: { available: true } });
  const okF2 = r2.action === "transfer" && r2.recipient?.value === "Savings" && r2.amount === 10;
  okF2 ? pass++ : fail++;
  console.log(`${okF2 ? "PASS" : "FAIL"}  fresh-account deposit works -> ${r2.action} ${r2.recipient?.value} ${r2.amount}`);
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
