// Deterministic intent parser — the always-available fallback the plan
// demands ("degrades but never hallucinates parameters").
//
// Emits the SAME strict JSON schema as the LLM path:
//   { action, token, recipient:{type,value}, amount, amountWord, rationale,
//     confidence }
// action ∈ transfer | swap | query | clarify
//
// The parser receives the live whitelist labels so "savings" resolves to the
// whitelisted "Savings Wallet" — recipients are matched against the REAL
// on-chain whitelist, never guessed.
//
// ── Multilingual + code-mixing ──────────────────────────────────────────────
// Commands work in the world's most-spoken languages — native script OR
// romanized (Hinglish, Banglish, Taglish, Arabizi…) — and in sentences that
// MIX several languages at once ("savings থেকে landlord কে ৫০ ডলার পাঠাও").
//
// How: every matcher runs on `flatten(text)` — an index-preserving lowercase
// copy where accented Latin chars lose their diacritics (é→e, ü→u, gửi→gui)
// and non-ASCII digits become ASCII (৫০→50, ٥٠→50, ５０→50). Latin words match
// with word boundaries; non-Latin scripts (CJK, Devanagari, Bengali, Arabic,
// Cyrillic, Thai, …) match as substrings on the same flattened copy, so
// positions always agree.
//
// Recipient resolution is MARKER-driven, which is what makes code-mixing safe:
//   • a payee next to a "to"-marker wins — to/into/a/para/ko/ke/kache/cho/
//     给/到/को/কে/に/에게/إلى/ל/ให้… (recipient AFTER the marker for
//     prepositions, BEFORE it for postpositions like ko/ke/に)
//   • a payee next to a "from"-marker — from/theke/se/de/desde/da/min/
//     से/থেকে/从/から/에서/من/из… — is the SOURCE of funds and can NEVER be
//     the recipient. This is what stops "send 50 dollars from savings to mom"
//     from routing to Savings.
// Only when no marker is present does the parser fall back to whole-sentence
// label scoring (the classic English behavior).

// ── flatten: 1 code point in → 1 char out (indices preserved) ──────────────
const DIGIT_BLOCKS = [
  [0x0660, 0x0669], // arabic-indic       ٠١٢…
  [0x06f0, 0x06f9], // eastern arabic     ۰۱۲…
  [0x0966, 0x096f], // devanagari         ०१२…
  [0x09e6, 0x09ef], // bengali            ০১২…
  [0x0e50, 0x0e59], // thai               ๐๑๒…
  [0xff10, 0xff19], // fullwidth          ０１２…
];
const CHAR_FIX = { ø: "o", đ: "d", ł: "l", æ: "a", œ: "o" };
const FLAT_CACHE = new Map();
function stripChar(ch) {
  if (FLAT_CACHE.has(ch)) return FLAT_CACHE.get(ch);
  const cp = ch.codePointAt(0);
  let out = ch;
  for (const [base, end] of DIGIT_BLOCKS) {
    if (cp >= base && cp <= end) { out = String.fromCharCode(48 + (cp - base)); break; }
  }
  if (out === ch) {
    const nfd = ch.normalize("NFD");
    if (nfd.length > 1) {
      // keep the base letter, drop combining marks (é → e, ộ → o)
      const bases = [...nfd].filter((c) => !/[\u0300-\u036f\u0483-\u0489\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20f0\u302a-\u302f\u3099-\u309a\ufe20-\ufe2f]/.test(c));
      // keep the base letter ONLY when decomposition is base+marks (é→e);
      // multi-base decompositions (Hangul jamo, ligatures) keep the original
      // char so the copy stays 1:1 with the input
      out = bases.length === 1 ? bases[0] : ch;
    }
  }
  out = CHAR_FIX[out] || out;
  FLAT_CACHE.set(ch, out);
  return out;
}
export function flatten(text) {
  let s = "";
  for (const ch of String(text)) s += stripChar(ch);
  return s.toLowerCase();
}

// index of `word` standing alone (Latin); supports multi-word phrases
function findWord(flat, word) {
  const m = flat.match(new RegExp("(^|[^a-z0-9])(" + word + ")(?![a-z0-9])", "i"));
  return m ? m.index + m[1].length : -1;
}
const hasAny = (flat, words) => words.some((w) => flat.includes(w));

// ── verbs / intents, per language family ───────────────────────────────────
// English forms are kept EXACTLY as the historical regex had them; the new
// alternatives are appended so English behavior is unchanged.
const TRANSFER_VERBS_LATIN =
  /\b(?:sweep|sweeping|pay|pays|paying|paid|send|sends|sending|sent|move|moves|moved|moving|transfer|transfers|transferring|wire|wiring|wired|forward|forwarding|forwards|fund|funding|give|gives|giving|gave|push|pushing|route|routing|stash|stashing|tuck|tucking|park|parking|patha\w*|bhej\w*|bhij\w*|diya|diye|dena|envia\w*|envie\w*|envio\w*|enviar|envoie|envoye|envoyer|manda\w*|mandar|kirim\w*|padala|ipadala|bayar\w*|tuma\w*|gonder|schick\w*|senden|uberweis\w*|virement|vire|otprav\w*|pereved\w*|arsel\w*|arsil|irsil|yolla|donne|donner|donnez|gui|chuyen|zhuan|ano|lao|dao|daal\w*|rakh\w*|dhuka\w*|bharo|jama|put|puts|putting|load|loads|loading|deposit\w*|topup|top\s?-?up\w*|recharge|cash\s?in|add|adds|adding|mete|meter|ingresa\w*|deposita\w*|coloca\w*|depose\w*|deposer|versez|verser|versa\w*|yatin|yatar|setor\w*|ilagay|ideposito|magdeposito|nap\w*|popolni)\b/i;
const TRANSFER_VERBS_SCRIPT =
  /(?:发送|发到|发给|转账|转给|转帐|汇款|汇给|付给|支付|转|付|汇|给|送っ|振り込|送金|보내|송금|भेज|पाठव|पाठा|पाठाओ|بھیج|পাঠা|ਭੇਜ|அனுப்ப|పంపి|ಕಳುಹ|അയക്ക|મોકલ|أرسل|ارسل|حول|تحويل|ارسال|إرسال|ส่ง|โอน|ផ្ទេר|שלח|отправ|перевед|перевод|посыл|存入|存进|存到|放入|放进|充值|入金|入れて|입금|넣어|넣으|আনো|আনেন|রাখো|রাখ|দাও|ঢোকাও|জমা|ডালো|ডাল|डालो|डाल|रखो|रख|दाओ|जमा|أودع|اودع|إيداع|ايداع|ضع|пополни|пополн|положи|внеси|ส่งเข้า)/;

const SWAP_VERBS =
  /\b(?:swap|swapping|convert|converts|converting|exchange|exchanging|trade|trading|rebalance|rebalancing|turn|turning|convierte|convertir|converte|converter|trocar|troca|cambia|cambiar|tausch\w*|wechsl\w*|echang\w*|obmeni\w*|tukar\w*|palitan|badal)\b/i;
const SWAP_VERBS_SCRIPT = /(?:兑换|換成|换成|转换|轉換|変換|交換|바꿔|교환|بدل|تبديل|बदल|বদল)/;

const QUERY_WORDS =
  /\b(?:how\s+much|what(?:'s| is|’s)|show\s+(?:me\s+)?(?:the|my)|status|balance\??|did\s+you|did\s+(?:the|anything|i)|have\s+you|am\s+i|is\s+the|remind\s+me|tell\s+me|list\b|who\s+is|rejections?\b|cuanto\w*|cuantos|combien|quanto|wie\s+viel|wieviel|skolko|kitna\w*|koto|berapa|magkano|bao\s+nhieu|koliko|saldo|solde|balans)\b/i;
const QUERY_WORDS_SCRIPT =
  /(?:多少|余额|餘額|查询|查一下|查查|残高|잔액|얼마|いくら|كم|رصيد|शेष|बैलेंस|ব্যালেন্স|இருப்பு|సంతులనం|ಸಮತೋಲನ)/;

const FUTURE_WORDS =
  /\b(?:tomorrow|next\s+(?:week|month|monday|friday|payday)|later\s+today|on\s+monday|schedule\b|scheduled|recurring|every\s+(?:week|month|day|friday)|manana|domani|morgen|amanha|zavtra|prossim\w*|prochain\w*|proxim\w*|siguiente|nachste|sleduyushch\w*)\b/i;
const FUTURE_WORDS_SCRIPT =
  /(?:明天|明日|明後日|来週|下周|下週|次の|次週|다음|내일|غدا|بكرة|आगामी|আগামী|আগামীকাল|நாளை|రేపు|ನಾಳೆ|ਕੱਲ੍ਹ|നാളെ|མང་ཉིན?)/;

// revert/undo words: cancel what is pending, or reverse what just happened.
// Checked AFTER queries ("what did you revert?") and BEFORE transfers, so a
// compound "revert everything and send all to 0x..." still lands here with
// the transfer slots attached as partial (the executor continues that part).
const REVERT_LATIN =
  /\b(?:revert|reverting|undo|undone|rollback|roll\s?back|reverse|reversing|void|fire\s?(?:de|dao|din|diben|dien)|pherot|ferot|wapas|devuelv\w*|devolver|annul\w*|annuler|otmeni\w*)\b/i;
const REVERT_SCRIPT = /(?:取り消|取消|撤销|撤銷|취소|отмен|باطل|إلغاء|الغاء|वापस|बातिल|ফেরত)/;

// ── greetings, any language ────────────────────────────────────────────────────
// Consulted ONLY when nothing financial matched and the message is short.
// A greeting never carries a verb + amount, so it cannot hijack a command.
const GREETING_LATIN =
  /\b(?:hi|hii+|hello+|hey+|heyy+|howdy|sup|whats\s?up|what'?s\s?up|wassup|wasup|how\s?are\s?you|hows\s?it\s?going|good\s?morning|good\s?evening|good\s?afternoon|good\s?night|shubho\s?shokal|hola|buenas|buenos\s?dias|buenas\s?tardes|buenas\s?noches|ola|bom\s?dia|boa\s?tarde|boa\s?noite|bonjour|bonsoir|salut|coucou|ciao|buongiorno|hallo|servus|gruezi|privet|zdravstvuy|namaste|namaskar|salam|salaam|assalam\w*|marhaba|ahlan|merhaba|selam|kire|khobor|kem\w*n\s?ach\w*|kemon\s?acen\w*|ki\s?obostha|obostha|kya\s?haal|kaise\s?ho|kaise\s?hain|kaisi\s?ho|kya\s?hal|ohayo|annyeong\w*|anyoung\w*|nihao|ni\s?hao|min\s?ga\s?lar\s?par|xin\s?chao|magandang\s+(?:umaga|hapon|gabi|araw)|kumusta|kamusta|musta|mabuhay|hoy)\b/i;
const GREETING_SCRIPT =
  /(?:你好|您好|嗨|哈喽|哈囉|こんにちは|こんちわ|おはよう|안녕|مرحبا|أهلا|اهلا|السلام|سلام|हैलो|नमस्ते|नमस्कार|হ্যালো|আসসালামু|সালাম|কেমন আছ|কি খবর|ਸਤ ਸ੍ਰੀ|வணக்கம்|నమస్తే|ನಮಸ್ಕಾರ|નમસ્તે|നമസ്കാരം|สวัสดี|မင်္ဂလာ)/;

/** Echo the greeting in the user's own language when we can tell it apart. */
function greetingOpener(flat) {
  if (/magandang\s+umaga/.test(flat)) return "Magandang umaga! 👋";
  if (/magandang/.test(flat)) return "Magandang araw! 👋";
  if (/kumusta|kamusta|\bmusta\b|mabuhay|\bhoy\b/.test(flat)) return "Kumusta! 👋";
  if (/(kire|khobor|kemon|obostha|assalam|salaam)/.test(flat)) return "Ki khobor! 👋";
  if (/(kya haal|kaise|kaisi|namaste|namaskar)/.test(flat)) return "Namaste! 👋";
  if (/hola|buenas|buenos/.test(flat)) return "¡Hola! 👋";
  if (/ola|bom dia|boa/.test(flat)) return "Olá! 👋";
  if (/bonjour|bonsoir|salut/.test(flat)) return "Bonjour ! 👋";
  if (/ciao|buongiorno/.test(flat)) return "Ciao! 👋";
  if (/hallo|servus|gruezi/.test(flat)) return "Hallo! 👋";
  if (/privet|zdravstvuy/.test(flat)) return "Привет! 👋";
  if (/merhaba|selam/.test(flat)) return "Merhaba! 👋";
  if (/marhaba|ahlan|السلام|مرحبا/.test(flat)) return "أهلا! 👋";
  if (/안녕|annyeong|anyoung/.test(flat)) return "안녕! 👋";
  if (/こんにちは|おはよう|ohayo/.test(flat)) return "こんにちは! 👋";
  if (/你好|您好|nihao/.test(flat)) return "你好! 👋";
  if (/สวัสดี/.test(flat)) return "สวัสดี! 👋";
  if (/xin chao/.test(flat)) return "Xin chào! 👋";
  return "Hey there! 👋";
}

// ── recipient markers ───────────────────────────────────────────────────────
const PRE_TO_LATIN = /\b(?:into|onto|para|cho|den|toi|vao|kay|kwa|gei|dao|aux|au|an|to|a)\b/gi; // recipient AFTER marker
const POST_TO_LATIN = /\b(?:kache|ko|ke|e)\b/gi; // recipient BEFORE marker (e = Bangla locative "savings e")
// from-markers are DIRECTIONAL: prepositions put the source AFTER them
// (from/de/desde/cong/从/من…), postpositions put it BEFORE (theke/se/থেকে/से…)
const FROM_PRE_LATIN = /\b(?:from|desde|de|da|dai|dal|dalla|aus|min|cua|cong|von|van|fra)\b/gi;
const FROM_POST_LATIN = /\b(?:theke|theka|se)\b/gi;
const PRE_TO_SCRIPT = ["给", "給", "到", "إلى", "الى", "ให้", "ل", "אל"]; // recipient after
const POST_TO_SCRIPT = ["को", "के लिए", "कে", "কাছে", "কোল", "에게", "께", "한테", "に", "へ", "க்கு", "కు", "ಗೆ", "ਨੂੰ", "ക്ക്", "کو", "کے لیے"]; // recipient before
const FROM_PRE_SCRIPT = ["من", "از", "из", "从", "從", "จาก", "मधून", "પાસેથી", "இருந்து", "నుండి", "ಿಂದ", "ਤੋਂ", "നിന്ന്"];
const FROM_POST_SCRIPT = ["থেকে", "से", "から", "에서"];
const FROM_RAW = ["từ"]; // checked against the un-flattened text (diacritics matter)

// window sizes around a marker when hunting for the payee
const AFTER_WIN = 15; // chars after a preposition ("to …", "给…")
const BEFORE_WIN = 17; // chars before a postposition ("… ko", "… কে")
const FROM_WIN = 18; // exclusion zone around a from-marker

// ── payee aliases, per whitelist label root ────────────────────────────────
// `when` activates the group for a label containing any of those words;
// `latin` matches flattened text as standalone words; `script` matches the
// flattened text as substrings; `raw` matches the original text.
const ALIAS_GROUPS = [
  {
    when: ["savings", "saving"],
    latin: ["savings", "saving", "ahorro", "ahorros", "bachat", "khata", "epargne", "risparmio", "tabungan", "spaarrekening", "economia", "economias", "sberezheniya", "ipon"],
    script: ["存款", "储蓄", "貯金", "저축", "توفير", "बचत", "संचय", "সঞ্চয়", "சேமிப்பு", "పొదుపు", "ಉಳಿತಾಯ", "બચત", "ലാഭം", "ਬੱਚਤ", "сбережени", "копилк"],
    raw: [],
  },
  {
    when: ["rent", "landlord", "landlady"],
    latin: ["rent", "landlord", "landlady", "casero", "casera", "alquiler", "aluguel", "loyer", "miete", "affitto", "arenda", "kiraya", "kira", "sewa"],
    script: ["ভাড়া", "বাড়িওয়ালা", "房租", "房东", "房東", "家賃", "임대료", "إيجار", "किराया", "भाड़ा", "అద్దె", "ಗುತ್ತಿಗೆ", "ค่าเช่า"],
    raw: [],
  },
  {
    when: ["salary", "payroll", "employer"],
    latin: ["salary", "payroll", "employer", "salario", "sueldo", "nomina", "salaire", "gehalt", "stipendio", "zarplata", "gaji"],
    script: ["工资", "薪水", "薪資", "薪酬", "給料", "月給", "월급", "راتب", "वेतन", "বেতন", "சம்பளம்", "జీతం", "ಸಂಬಳ", "ਤਨਖਾਹ", "ശമ്പളം"],
    raw: [],
  },
  {
    when: ["internet", "isp", "broadband", "wifi"],
    latin: ["internet", "isp", "broadband", "wifi"],
    script: ["网费", "网络", "宽带", "ネット", "인터넷", "انترنت", "इंटरनेट", "ইন্টারনেট"],
    raw: [],
  },
  {
    when: ["emergency"],
    latin: ["emergency", "urgencia", "urgence", "notfall", "emergenza", "acil", "darurat"],
    script: ["紧急", "緊急", "비상", "طارئ", "आपात", "জরুরি"],
    raw: [],
  },
  {
    when: ["mom", "mother", "mama", "mum"],
    latin: ["mom", "mother", "mama", "mum", "mommy", "maa", "madre", "mae", "maman", "mutter", "matka", "ammi", "nanay", "ina", "ibu", "emak", "ma mere"],
    script: ["妈妈", "媽媽", "母亲", "母親", "お母さん", "おかあさん", "ママ", "엄마", "어머니", "أم", "أمي", "امي", "माँ", "मां", "মা", "অম্মু", "мама", "маме", "ام", "అమ్మ", "ಅಮ್ಮ", "મા", "അമ്മ", "ਮਾਂ", "அம்மா", "แม่", "אמא"],
    raw: ["mẹ"],
  },
  {
    when: ["dad", "father", "papa"],
    latin: ["dad", "father", "papa", "daddy", "padre", "pai", "papi", "pere", "vater", "tatay", "baba", "abbu", "appa", "bapak"],
    script: ["爸爸", "父亲", "父親", "お父さん", "おとうさん", "パパ", "아빠", "아버지", "أب", "أبي", "ابي", "पिता", "पापा", "বাবা", "папа", "నాయన", "ಅಪ್ಪ", "ਪਿਤਾ", "அப்பா", "พ่อ", "אבא"],
    raw: ["bố"],
  },
];

// ── money / token words ─────────────────────────────────────────────────────
const MONEY_LATIN =
  /\b(?:usdc|usd|dollars?|dollers?|dolar|dolares|bucks?|taka|tk|rupees?|rupaye|rupaya|rupiah|rp|ringgit|rm|pesos?|euro|euros|yuan|kuai|rmb|meiyuan|won|yen|baht|dong|dirham|riyal|rials?|dinar|dinars?|francs?|rand|lira|shillings?|shilingi|zloty|krona|krone|kroner|forint|leu|lev|montos?)/i;
const MONEY_SCRIPT = ["美元", "美金", "块钱", "卢比", "টাকা", "ডলার", "रुपया", "रुपये", "روبية", "ルピー", "ドル", "달러", "ดอลลาร์", "บาท", "เงิน", "שקל", "₹", "€", "£", "¥", "₩", "доллар", "рубл", "روپیہ", "ரூபாய்"];
const MONEY_RAW = ["đô"];
const ETH_SCRIPT = ["以太坊", "イーサリアム", "이더리움", "إيثيريوم"];

// full-balance words: "sob usdc", "send everything", "sab paisa", "todo".
// A number in the same message still wins (explicit beats vague).
const ALL_AMOUNT_LATIN =
  /\b(?:all|everything|entire|entirely|whole|full\s?(?:balance|amount)|sob\w*|shob\w*|sabai|sab|saara|sara|poora|todo|toda|todos|tudo|tout|toute|tutto|alle|alles|hepsi|semua|lahat|hamma|kullu|vse|fse)\b/i;
const ALL_AMOUNT_SCRIPT = ["全部", "所有", "全額", "すべて", "전부", "전체", "الكُل", "كلّ", "كل ", "सब", "सारा", "सबकुछ", "সব", "সবগুলো", "টাকার সব", "ทั้งหมด", "всё", "все"];

// contiguous runs of number-words ("twelve hundred", "two hundred fifty")
const NUM_WORD_LIST =
  "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand";
const NUM_WORD =
  new RegExp(`\\b((?:${NUM_WORD_LIST})(?:[\\s-]+(?:${NUM_WORD_LIST})){0,4})\\b`, "i");

const WORD_NUMBERS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};

function wordToNumber(str) {
  const parts = str.toLowerCase().split(/[\s-]+/).filter(Boolean);
  if (parts.some((p) => !(p in WORD_NUMBERS) && p !== "hundred" && p !== "thousand")) return null;
  let total = 0, current = 0;
  for (const p of parts) {
    if (p === "hundred") current = (current || 1) * 100;
    else if (p === "thousand") { current = (current || 1) * 1000; total += current; current = 0; }
    else current += WORD_NUMBERS[p];
  }
  return total + current;
}

/** Extract the amount: digits ($800, 1,200.50, 0.05, 1.5k), word-runs, or a
 *  full-balance word ("all", "sob", "everything"). kind: number|words|all. */
export function extractAmount(text) {
  const flat = flatten(text);
  // numeric forms (with optional $, commas, k suffix, decimals)
  const num = flat.match(
    /(?:\$|\busd\s*)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,6})?|\d+(?:\.\d{1,6})?)\s*(k\b)?/i
  );
  if (num) {
    let v = Number(num[1].replace(/,/g, ""));
    if (num[2]) v *= 1000;
    if (Number.isFinite(v) && v > 0) return { amount: v, kind: "number" };
  }
  // word-number runs: "eighty dollars", "twelve hundred dollars", "two hundred fifty to mom"
  const runRe = new RegExp(NUM_WORD.source, "gi");
  const runs = [];
  let m;
  while ((m = runRe.exec(flat)) !== null) runs.push({ word: m[1], after: flat.slice(m.index + m[0].length, m.index + m[0].length + 14) });
  if (runs.length > 0) {
    // prefer a run directly followed by a money word, else the last run
    const moneyRun = runs.find((r) => /^\s*(?:dollars?|usdc|eth|ether|usd|bucks?)/i.test(r.after));
    const chosen = moneyRun || runs[runs.length - 1];
    const v = wordToNumber(chosen.word);
    if (v && v > 0) return { amount: v, kind: "words" };
  }
  // full-balance words: "sob usdc", "send everything", "sab paisa"
  if (ALL_AMOUNT_LATIN.test(flat) || ALL_AMOUNT_SCRIPT.some((w) => flat.includes(w))) {
    return { amount: "all", kind: "all" };
  }
  return null;
}

/** A 0x-prefixed string that is NOT a well-formed address (40 hex chars).
 *  "0xjnsdjkfbsdj" / "0xxcvxcvxcvxcvxcv" are user INTENT to give an
 *  address, but malformed: better to say so than to silently ask "who?". */
export function detectInvalidAddress(text) {
  const m = String(text || "").match(/0x[0-9a-zA-Z]{3,}/);
  if (!m) return null;
  return /^0x[0-9a-fA-F]{40}$/.test(m[0]) ? null : m[0];
}

export function extractToken(text) {
  const flat = flatten(text);
  if (/\b(?:eth|ether|ethereum)\b/i.test(flat) || hasAny(flat, ETH_SCRIPT)) return "ETH";
  // any fiat word in any supported language means the demo's USDC balance
  if (MONEY_LATIN.test(flat) || hasAny(flat, MONEY_SCRIPT) || MONEY_RAW.some((w) => String(text).toLowerCase().includes(w))) return "USDC";
  return null; // undecided — caller decides default vs clarify
}

// all start-indices of a global latin regex + script needles in flat
function markerPositions(flat, latinRe, scriptList) {
  const out = [];
  const re = new RegExp(latinRe.source, latinRe.flags.includes("g") ? latinRe.flags : latinRe.flags + "g");
  let m;
  while ((m = re.exec(flat)) !== null) out.push({ start: m.index, end: m.index + m[0].length });
  for (const s of scriptList) {
    let i = flat.indexOf(s);
    while (i !== -1) { out.push({ start: i, end: i + s.length }); i = flat.indexOf(s, i + 1); }
  }
  return out;
}

/** All whitelist labels that appear in a flattened segment, with score + pos. */
function matchLabels(flatSeg, whitelist) {
  const hits = [];
  for (const w of whitelist) {
    const labelFlat = flatten(w.label);
    const labelTokens = labelFlat.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    // alias groups: any group whose `when` word appears in the LABEL
    for (const g of ALIAS_GROUPS) {
      if (!g.when.some((a) => labelFlat.includes(a))) continue;
      for (const a of g.latin) {
        const p = findWord(flatSeg, a);
        if (p >= 0) hits.push({ w, score: 1, pos: p, via: "alias" });
      }
      for (const a of g.script) {
        const p = flatSeg.indexOf(a);
        if (p >= 0) hits.push({ w, score: 1, pos: p, via: "alias" });
      }
    }
    // label-token scoring (partial matches, e.g. "savings" of "Savings Wallet")
    let matched = 0, firstPos = -1;
    for (const t of labelTokens) {
      const p = findWord(flatSeg, t);
      if (p >= 0) { matched++; if (firstPos < 0) firstPos = p; }
    }
    if (labelTokens.length > 0 && matched > 0) {
      hits.push({ w, score: matched / labelTokens.length, pos: firstPos, via: "tokens" });
    }
    // typo pass: one edit (insert/delete/replace/swap) from an alias or label
    // token — "sovings"→"savings", "landlrod"→"landlord". Weaker than any
    // exact hit (0.75) and only for words ≥5 chars, so a single slip can
    // never turn one short word into another payee.
    const fuzzyTargets = [];
    for (const g of ALIAS_GROUPS) {
      if (g.when.some((a) => labelFlat.includes(a))) fuzzyTargets.push(...g.latin);
    }
    fuzzyTargets.push(...labelTokens);
    const fh = fuzzyWordHit(flatSeg, fuzzyTargets);
    if (fh) hits.push({ w, score: 0.75, pos: fh.pos, via: "fuzzy" });
  }
  // dedupe per label, keep the strongest hit
  const byLabel = new Map();
  for (const h of hits) {
    const prev = byLabel.get(h.w.label);
    if (!prev || h.score > prev.score) byLabel.set(h.w.label, h);
  }
  return [...byLabel.values()];
}

// ── typo tolerance (edit distance 1) ─────────────────────────────────────────
// Damerau-Levenshtein (swapped letters count as ONE edit — "landlrod"→
// "landlord" is a transposition, the single most common fat-finger) with an
// early exit once a whole DP row exceeds `max`.
function withinEditDistance(a, b, max = 1) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > max) return false;
  const m = a.length, n = b.length;
  let prev2 = null;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1); // transposition
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return false;
    prev2 = prev;
    prev = cur;
  }
  return prev[n] <= max;
}

// generic tokens that must never fuzzy-match (too many labels share them)
const FUZZY_STOPWORDS = new Set(["wallet", "account", "acct", "bank", "payee"]);

/** First word in `flatSeg` within one edit of any target ≥5 chars, or null. */
function fuzzyWordHit(flatSeg, targets) {
  let best = null;
  const re = /[a-z]{4,}/g; // candidates ≥4 chars (target ≥5, distance 1)
  let m;
  while ((m = re.exec(flatSeg)) !== null) {
    const cand = m[0];
    for (const t of targets) {
      if (t.length < 5 || FUZZY_STOPWORDS.has(t) || cand === t) continue;
      if (withinEditDistance(cand, t, 1) && (!best || m.index < best.pos)) {
        best = { pos: m.index, target: t, cand };
      }
    }
  }
  return best;
}

/** Best hit, but a FUZZY tie between two different labels is genuinely
 *  ambiguous ("savimgs" could be either) — return null so the caller
 *  clarifies instead of guessing a payee. */
function pickTop(hits) {
  if (!hits.length) return null;
  const top = hits.reduce((a, b) => (b.score > a.score ? b : a));
  if (
    top.via === "fuzzy" &&
    hits.some((h) => h.via === "fuzzy" && h.score === top.score && h.w.label !== top.w.label)
  )
    return null;
  return top;
}

/** Is a hit at `pos` inside the exclusion zone of a from-marker?
 *  `toMarkers` caps each zone: the source phrase ends where the next
 *  "to"-marker begins ("de savings A landlord" — landlord is past "a"). */
function nearFromMarker(pre, post, pos, toMarkers = []) {
  // preposition from-markers: the source sits right AFTER the marker
  for (const f of pre) {
    let zoneEnd = f.end + 11;
    for (const t of toMarkers) {
      if (t.start > f.start && t.start < zoneEnd) zoneEnd = t.start;
    }
    if (pos >= f.end && pos < zoneEnd) return true;
  }
  // postposition from-markers: the source sits right BEFORE the marker
  if (post.some((f) => pos >= f.start - 12 && pos <= f.start)) return true;
  return false;
}

/**
 * Resolve the recipient against the live whitelist, in any language.
 * Marker-driven: payees beside "to"-markers win; payees beside "from"-markers
 * are sources and can never be the recipient.
 */
export function extractRecipient(text, whitelist) {
  // explicit address always wins (it will be screened by policy + risk).
  // .address is stamped here so every consumer downstream (policy, risk
  // codesize screening, executor agentExecute/submitForApproval encoding)
  // sees a concrete address — a missing .address reaches ethers as undefined
  // and dies with the cryptic "unsupported addressable value" INVALID_ARGUMENT.
  const addr = text.match(/0x[0-9a-fA-F]{40}/);
  if (addr) return { type: "address", value: addr[0], address: addr[0] };
  if (!whitelist || whitelist.length === 0) return null;

  const flat = flatten(text);
  const rawLower = String(text).toLowerCase();
  const fromPre = markerPositions(flat, FROM_PRE_LATIN, FROM_PRE_SCRIPT);
  const fromPost = markerPositions(flat, FROM_POST_LATIN, FROM_POST_SCRIPT);
  for (const w of FROM_RAW) {
    let i = rawLower.indexOf(w);
    while (i !== -1) { fromPre.push({ start: i, end: i + w.length }); i = rawLower.indexOf(w, i + 1); }
  }
  const toMarkers = [
    ...markerPositions(flat, PRE_TO_LATIN, PRE_TO_SCRIPT),
    ...markerPositions(flat, POST_TO_LATIN, POST_TO_SCRIPT),
  ];
  const isSource = (absPos) => nearFromMarker(fromPre, fromPost, absPos, toMarkers);

  // marker-driven pick: the first "to"-marker window (prepositions first,
  // then postpositions) that contains a non-source payee wins
  const markerPick = (() => {
    for (const m of markerPositions(flat, PRE_TO_LATIN, PRE_TO_SCRIPT)) {
      const seg = flat.slice(m.end, m.end + AFTER_WIN);
      const hits = matchLabels(seg, whitelist).filter((h) => !isSource(h.pos + m.end));
      const top = pickTop(hits);
      if (top) return { type: "label", value: top.w.label, address: top.w.address };
    }
    for (const m of markerPositions(flat, POST_TO_LATIN, POST_TO_SCRIPT)) {
      const seg = flat.slice(Math.max(0, m.start - BEFORE_WIN), m.start);
      const base = Math.max(0, m.start - BEFORE_WIN);
      const hits = matchLabels(seg, whitelist).filter((h) => !isSource(h.pos + base));
      const top = pickTop(hits);
      if (top) return { type: "label", value: top.w.label, address: top.w.address };
    }
    return null;
  })();
  if (markerPick) return markerPick;

  // 3 — no to-marker matched: score the whole sentence, but a payee beside a
  //     from-marker is the SOURCE, never the recipient
  const wholeHits = matchLabels(flat, whitelist);
  const aliasHits = wholeHits.filter((h) => h.via === "alias" && !isSource(h.pos));
  if (aliasHits.length > 0) {
    const first = whitelist.find((w) => aliasHits.some((h) => h.w.label === w.label));
    const hit = aliasHits.find((h) => h.w.label === first.label);
    return { type: "label", value: hit.w.label, address: hit.w.address };
  }
  const tokenHits = wholeHits.filter((h) => h.via === "tokens" && !isSource(h.pos));
  if (tokenHits.length > 0) {
    const top = tokenHits.reduce((a, b) => (b.score > a.score || (b.score === a.score && b.pos < a.pos) ? b : a));
    if (top.score >= 0.5) return { type: "label", value: top.w.label, address: top.w.address };
  }
  // last tier: a UNIQUE one-edit typo of a payee name still routes — "move
  // 100usd sovings" (no marker at all) should not bounce to a clarify
  const fuzzyHits = wholeHits.filter((h) => h.via === "fuzzy" && !isSource(h.pos));
  if (fuzzyHits.length > 0) {
    const top = pickTop(fuzzyHits);
    if (top) return { type: "label", value: top.w.label, address: top.w.address };
  }
  // 4 — from-markers present but nothing else matched: the only payee found is
  //     the source, so the recipient is genuinely unknown -> caller clarifies
  return null;
}

/**
 * Parse a natural-language command into the strict intent schema.
 * @param {string} text raw user command (any language, any script, mixed)
 * @param {Array<{address:string,label:string}>} whitelist live on-chain whitelist
 * @param {{symbol:string,decimals:number,address:string,available:boolean}} tokenInfo
 */
export function parseIntentRules(text, whitelist = [], tokenInfo = null) {
  const intent = {
    action: "clarify",
    token: null,
    recipient: null,
    amount: null,
    amountWord: null,
    rationale: text.trim().slice(0, 180),
    confidence: 0.5,
    parser: "rules",
  };

  const flat = flatten(text);
  // greetings are short by nature; a long message with a greeting word
  // plus a real request ("hi, please send 50 to mom") has already
  // matched a verb above and never reaches the greeting branch
  const isShort = flat.trim().length <= 48 && flat.trim().split(/\s+/).length <= 7;
  const hasAmount = !!extractAmount(flat);
  const hasTransfer = TRANSFER_VERBS_LATIN.test(flat) || TRANSFER_VERBS_SCRIPT.test(flat);
  const looksSwap = SWAP_VERBS.test(flat) || SWAP_VERBS_SCRIPT.test(flat);
  const looksQuery =
    (QUERY_WORDS.test(flat) || QUERY_WORDS_SCRIPT.test(flat)) && !looksSwap &&
    !(hasTransfer && hasAmount); // "did you pay the landlord?" has no amount -> question
  const looksTransfer = hasTransfer;
  const looksRevert = REVERT_LATIN.test(flat) || REVERT_SCRIPT.test(flat);

  // scheduling is out of scope — never guess a future action, ask instead
  if ((FUTURE_WORDS.test(flat) || FUTURE_WORDS_SCRIPT.test(flat)) && looksTransfer) {
    return {
      ...intent,
      action: "clarify",
      clarify: "I only execute immediate transfers; I don't have a scheduler. Say it in the present tense (e.g. 'pay mom 50 dollars now') and I'll take care of it.",
      noSlotFill: true, // scheduler reply must not be mistaken for a slot answer
      confidence: 0.75,
    };
  }

  if (looksQuery) {
    return {
      ...intent,
      action: "query",
      confidence: 0.8,
      question: text.trim().slice(0, 180),
    };
  }

  // revert/undo: cancel pending approvals, or explain what can and cannot
  // be reversed. Runs before swap/transfer so compound messages
  // ("revert everything and send all to 0x...") keep their transfer slots.
  if (looksRevert) {
    const amount = extractAmount(flat);
    const recipient = extractRecipient(text, whitelist);
    return {
      ...intent,
      action: "revert",
      confidence: 0.75,
      partial: {
        token: extractToken(flat),
        amount: amount?.amount ?? null,
        recipient,
      },
    };
  }

  if (looksSwap) {
    const amount = extractAmount(flat);
    const token = extractToken(flat) || (tokenInfo?.USDC?.available !== false ? "USDC" : null);
    // swap direction: "X dollars to ETH" => sell USDC buy ETH
    const sell = /\b(?:eth|ether)\b[\s\S]{0,30}\b(?:to|into|for)\b[\s\S]{0,30}\b(?:usdc|dollars?)\b/i.test(flat)
      ? "ETH" : "USDC";
    const buy = sell === "USDC" ? "ETH" : "USDC";
    if (!amount) {
      return { ...intent, action: "clarify", clarify: "How much exactly should I convert?", confidence: 0.55 };
    }
    return {
      ...intent,
      action: "swap",
      token: sell,
      buyToken: buy,
      amount: amount.amount,
      amountWord: amount.kind === "words" ? "words" : null,
      confidence: amount.kind === "words" ? 0.7 : 0.9,
    };
  }

  if (looksTransfer) {
    // negation guard: "don't send 50 to mom" must NEVER execute. If a clear
    // negation word sits within a couple of words BEFORE the transfer verb,
    // ask instead of act. (Typos AFTER the verb — "move dont 100usd to
    // sovings" — are not negations and parse normally; "never mind" is a
    // retraction of the PREVIOUS message, not a negation of this one.)
    const vm = TRANSFER_VERBS_LATIN.exec(flat);
    if (vm) {
      const before = flat.slice(Math.max(0, vm.index - 28), vm.index);
      if (
        /(?:\bdo\s*not\b|\bdon'?t\b|\bnever\b(?!\s+mind\b)|\bstop\b|\bcancel\b|\babort\b)\s+(?:\w+\s+){0,2}$/i.test(
          before
        )
      ) {
        return {
          ...intent,
          action: "clarify",
          clarify:
            "I read a “don’t/stop” in your message, so I did nothing. If you DO want this sent, say it without the negation, for example “move 100 dollars to Savings”.",
          noSlotFill: true, // a refused command never becomes pending slots
          confidence: 0.7,
        };
      }
    }
    const amount = extractAmount(flat);
    const token = extractToken(flat) || "USDC"; // primary asset default
    // recipient resolution is marker-driven (see extractRecipient): a payee
    // next to "from/theke/se/从/من…" is the source and can never receive.
    const recipient = extractRecipient(text, whitelist);
    const missing = [];
    if (!amount) missing.push("amount");
    if (!recipient) missing.push("recipient");
    if (missing.length > 0) {
      const payeeHint = whitelist.length > 0 ? ` Your payees: ${whitelist.map((w) => w.label).join(", ")} (add more in the Payees tab).` : "";
      return {
        ...intent,
        action: "clarify",
        clarify: `I want to be careful: I could not determine the ${missing.join(" and ")} unambiguously. Could you rephrase? (Any language works: English, Banglish, Hinglish, 中文, Español, العربية… )${payeeHint}`,
        partial: { token, amount: amount?.amount ?? null, recipient },
        confidence: 0.5,
      };
    }
    let confidence = 0.85;
    if (amount.kind === "words") confidence -= 0.1;
    if (recipient.type === "address") confidence -= 0.05;
    return {
      ...intent,
      action: "transfer",
      token,
      recipient,
      amount: amount.amount,
      amountWord: amount.kind === "words" ? "words" : null,
      confidence,
    };
  }

  // greetings ("kire ki khobor", "hola", "你好"…) — nothing financial matched
  // and the message is short, so greet back warmly instead of dumping the
  // canned menu. Never hijacks real commands: this branch is only reached
  // when there is no transfer verb, no swap verb and no query word.
  if (isShort && (GREETING_LATIN.test(flat) || GREETING_SCRIPT.test(flat))) {
    const payeeList = whitelist.map((w) => w.label).join(", ");
    return {
      ...intent,
      action: "clarify",
      greeting: true,
      noSlotFill: true, // a greeting is small talk, not a slot answer
      clarify:
        `${greetingOpener(flat)} I'm Aegis, your on-chain money agent. I can pay your payees, move money to savings, swap USDC and ETH, and report balances, in any language.` +
        (payeeList ? ` Your payees: ${payeeList} (add more in the Payees tab).` : "") +
        ` Try "savings e 100 dollar pathao" or "how much can I spend today?"`,
      confidence: 0.6,
    };
  }

  // generic clarify: teach the user WHO they can pay (their live payees)
  const payeeList = whitelist.map((w) => w.label).join(", ");
  return {
    ...intent,
    action: "clarify",
    clarify: payeeList
      ? `I can help with payments, sweeps, swaps and balance questions, in any language or mix of languages. Your payees: ${payeeList} (add more in the Payees tab). What would you like me to do?`
      : "I can help with payments, sweeps, swaps and balance questions, in any language or mix of languages. What would you like me to do?",
    confidence: 0.4,
  };
}

/** Validate any intent object (LLM or rules) against the strict schema. */
export function validateIntent(intent, whitelist = [], knownTokens = ["USDC", "ETH"]) {
  const problems = [];
  if (!intent || typeof intent !== "object") return { valid: false, problems: ["not an object"] };
  if (!["transfer", "swap", "query", "clarify", "revert"].includes(intent.action))
    problems.push(`bad action '${intent.action}'`);
  if (intent.token && !knownTokens.includes(intent.token))
    problems.push(`unknown token '${intent.token}'`);
  if (intent.action === "transfer") {
    if (!intent.recipient || !intent.recipient.type) problems.push("missing recipient");
    else if (intent.recipient.type === "label") {
      const hit = whitelist.find(
        (w) => w.label.toLowerCase() === String(intent.recipient.value).toLowerCase()
      );
      if (!hit) problems.push(`label '${intent.recipient.value}' not in whitelist`);
      else intent.recipient.address = hit.address;
    } else if (!/^0x[0-9a-fA-F]{40}$/.test(intent.recipient.value || "")) {
      problems.push("malformed address");
    } else {
      // valid raw address (LLM path): stamp .address so the executor encodes
      // a real address; without it ethers receives undefined for the `to`
      // parameter and throws "unsupported addressable value"
      intent.recipient.address = intent.recipient.value;
    }
    // "all" is a real amount: the executor resolves it to the full vault
    // balance of that token before policy evaluates it
    if (!(intent.amount > 0) && intent.amount !== "all") problems.push("amount must be > 0 or 'all'");
  }
  if (intent.action === "swap") {
    if (!(intent.amount > 0)) problems.push("amount must be > 0");
    if (!knownTokens.includes(intent.token || "")) problems.push("bad sell token");
    if (intent.token === intent.buyToken) problems.push("sell == buy");
  }
  return { valid: problems.length === 0, problems };
}
