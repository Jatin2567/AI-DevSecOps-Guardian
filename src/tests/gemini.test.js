// backend/test/gemini-test.js
const { analyzeFailure } = require("../services/aiService");

async function run() {
  try {
    const sampleLogs = `
ERROR: Test suite failed
TypeError: Cannot read property 'map' of undefined
at src/index.js:42:10
    `;

    const res = await analyzeFailure({
      projectId: "demo",
      pipelineId: "1",
      jobId: "1",
      jobName: "test-job",
      logs: sampleLogs
    });

    console.log("=== Gemini AI Analysis ===");
    console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    console.error("AI ERROR:", err);
    throw err; // rethrow so CI / Jest sees the failure
  }
}

(async () => {
  try {
    await run();
    // finished successfully
    // process.exit(0); // not required; let Node exit naturally
  } catch (err) {
    // ensure the error surface and exit non-zero
    console.error('AI ERROR (test):', err);
    process.exit(2);
  }
})();
