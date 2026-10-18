// FinBERT sentiment — plan component #5. ADVISORY ONLY.
// Annotates each decision with the sentiment of the instruction text; it can
// never auto-approve or auto-execute anything. Without HF_TOKEN it reports
// unavailable and the decision pipeline is unaffected.

export async function sentimentAdvisory(text, hfToken) {
  if (!hfToken) return { available: false, advisory: "HF_TOKEN not set, sentiment signal skipped" };
  try {
    const res = await fetch(
      "https://api-inference.huggingface.co/models/ProsusAI/finbert",
      {
        method: "POST",
        headers: { authorization: `Bearer ${hfToken}`, "content-type": "application/json" },
        body: JSON.stringify({ inputs: text.slice(0, 512), options: { wait_for_model: true } }),
        signal: AbortSignal.timeout(6000),
      }
    );
    if (!res.ok) throw new Error(`HF ${res.status}`);
    const data = await res.json();
    const rows = Array.isArray(data[0]) ? data[0] : data;
    const top = rows.reduce((a, b) => (b.score > a.score ? b : a), rows[0]);
    return {
      available: true,
      label: top.label,          // positive | negative | neutral
      score: +top.score.toFixed(3),
      advisory: `advisory only: instruction sentiment reads ${top.label} (${(top.score * 100).toFixed(0)}%), never auto-approves anything`,
    };
  } catch (err) {
    return { available: false, advisory: `sentiment signal unavailable: ${String(err.message).slice(0, 60)}` };
  }
}
