const { GoogleGenerativeAI } = require("@google/generative-ai");

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  throw new Error("GEMINI_API_KEY is not set");
}

const genAI = new GoogleGenerativeAI(API_KEY);
const MODEL_NAME = process.env.GEMINI_MODEL_NAME || "gemini-2.5-flash";

async function analyzeFailure({ jobName, logs }) {
  const model = genAI.getGenerativeModel({ model: MODEL_NAME });

  const prompt = `
You are an expert DevOps CI/CD assistant. Analyze these sanitized CI logs and respond ONLY with valid JSON:

{
  "stage": "<pipeline stage or job name>",
  "root_cause": "<one sentence explanation>",
  "suggested_fix": "<short fix steps>",
  "confidence": <0.0 - 1.0>,
  "explain": "<2-3 sentence explanation>"
}

Logs:
${logs}
  `;

  // call the model
  const result = await model.generateContent(prompt);
  const text = result.response.text();

  // Defensive parsing: always define `cleaned`
  let cleaned = typeof text === "string" ? text.replace(/```/g, "").trim() : "";

  try {
    const parsed = JSON.parse(cleaned);
    return parsed;
  } catch (e) {
    // Try to extract a JSON block from the text if the AI returned commentary + JSON
    const m = cleaned.match(/{[\s\S]*}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch (e2) {
        // fallthrough to safe fallback
      }
    }
    // Safe fallback: return structured object, do NOT reference undefined variables
    return {
      stage: jobName || "unknown",
      root_cause: "unparseable response",
      suggested_fix: "manual review required",
      confidence: 0,
      explain: cleaned || text || "no content"
    };
  }
}

module.exports = { analyzeFailure };
