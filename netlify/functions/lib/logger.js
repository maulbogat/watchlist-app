const { Axiom } = require("@axiomhq/js");

const AXIOM_TOKEN = process.env.AXIOM_TOKEN || "";
const AXIOM_DATASET = process.env.AXIOM_DATASET || "movie-trailer-site";

let axiomClient = null;
if (AXIOM_TOKEN) {
  try {
    axiomClient = new Axiom({ token: AXIOM_TOKEN });
  } catch {
    axiomClient = null;
  }
}

function safeConsoleLog(event) {
  try {
    console.log(JSON.stringify(event));
  } catch {
    // logging must never break flow
  }
}

function createFunctionLogger(functionName) {
  return function logEvent(event) {
    try {
      const payload = {
        timestamp: new Date().toISOString(),
        environment: process.env.CONTEXT || process.env.NODE_ENV || "unknown",
        function: functionName,
        ...event,
      };

      if (!AXIOM_TOKEN || !axiomClient) {
        safeConsoleLog(payload);
        return;
      }

      Promise.resolve(axiomClient.ingest(AXIOM_DATASET, payload)).catch(() => {
        safeConsoleLog(payload);
      });
    } catch {
      // logging must never break flow
    }
  };
}

module.exports = {
  createFunctionLogger,
};
