const key = process.env.GEMINI_API_KEY;
const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=200`);
const json = await res.json();
if (!res.ok) { console.error(JSON.stringify(json).slice(0, 500)); process.exit(1); }
const rows = (json.models ?? [])
  .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
  .map((m) => m.name.replace(/^models\//, ''))
  .sort();
console.log(rows.join('\n'));
