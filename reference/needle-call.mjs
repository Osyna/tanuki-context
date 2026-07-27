import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
const key = process.env.ANTHROPIC_API_KEY;
const models = (process.env.NEEDLE_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean);
const OUT = "reference/needles";
const prompt = readFileSync(path.join(OUT, "prompt.txt"), "utf8");
const densities = ["normal", "tiny"];
let totIn = 0, totOut = 0;
for (const model of models) {
  const transcript = {};
  for (const d of densities) {
    const dir = path.join(OUT, d);
    const pages = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
    const content = pages.map((p) => ({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: readFileSync(path.join(dir, p)).toString("base64") },
    }));
    content.push({ type: "text", text: prompt });
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 16000, messages: [{ role: "user", content }] }),
    });
    const j = await r.json();
    if (j.error) { console.error(`${model}/${d} ERROR ${JSON.stringify(j.error)}`); transcript[d] = ""; continue; }
    // count a needle read anywhere the model wrote it - text OR thinking (most generous)
    const text = (j.content ?? []).map((c) => c.text ?? c.thinking ?? "").join("\n");
    const u = j.usage ?? {};
    totIn += u.input_tokens || 0; totOut += u.output_tokens || 0;
    console.error(`${model}/${d}: stop=${j.stop_reason} chars=${text.length} in=${u.input_tokens} out=${u.output_tokens}`);
    transcript[d] = text;
  }
  const f = `${OUT}/transcript-${model}.json`;
  writeFileSync(f, JSON.stringify(transcript, null, 2));
  console.log(`\n##### needle read-back: ${model} #####`);
  console.log(execSync(`node reference/needle-report.mjs score ${f}`, { encoding: "utf8" }));
}
console.error(`\n[usage] input=${totIn} output=${totOut} tokens across ${models.length} model(s)`);
