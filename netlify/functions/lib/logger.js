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
      const hasToken = Boolean(AXIOM_TOKEN);
      const hasDataset = Boolean(AXIOM_DATASET);
      const eventType = event && typeof event === "object" ? event.type || "unknown" : "unknown";
      const usesFallback = !AXIOM_TOKEN || !axiomClient;
      console.log(
        JSON.stringify({
          type: "axiom.debug.attempt",
          function: functionName,
          eventType,
          hasAxiomToken: hasToken,
          hasAxiomDataset: hasDataset,
          mode: usesFallback ? "console-fallback" : "axiom-ingest",
        })
      );

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

      Promise.resolve(axiomClient.ingest(AXIOM_DATASET, payload))
        .then((result) => {
          try {
            console.log(
              JSON.stringify({
                type: "axiom.debug.ingest.result",
                function: functionName,
                eventType,
                status: result && typeof result === "object" ? result.status || null : null,
              })
            );
          } catch {
            // debug logging must never break flow
          }
        })
        .catch((err) => {
          try {
            console.log(
              JSON.stringify({
                type: "axiom.debug.ingest.error",
                function: functionName,
                eventType,
                error: err instanceof Error ? err.message : String(err || ""),
              })
            );
          } catch {
            // debug logging must never break flow
          }
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
