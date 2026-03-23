import { Axiom } from "@axiomhq/js";

type LogValue = string | number | boolean | null | undefined;
type LogEventPayload = {
  type: string;
  uid?: string | null;
} & Record<string, LogValue>;

const token = import.meta.env.VITE_AXIOM_TOKEN as string | undefined;
const dataset = import.meta.env.VITE_AXIOM_DATASET as string | undefined;
const appVersion = (import.meta.env.VITE_APP_VERSION as string | undefined) || "unknown";
const environment = import.meta.env.MODE || "unknown";

let axiomClient: Axiom | null = null;
if (token && dataset) {
  try {
    axiomClient = new Axiom({ token });
  } catch {
    axiomClient = null;
  }
}

function devConsoleFallback(event: Record<string, unknown>) {
  if (!import.meta.env.DEV) return;
  try {
    console.log("[axiom]", event);
  } catch {
    // logging must never break flow
  }
}

export async function logEvent(payload: LogEventPayload): Promise<void> {
  try {
    const event = {
      timestamp: new Date().toISOString(),
      environment,
      appVersion,
      ...payload,
    };

    if (!axiomClient || !dataset) {
      devConsoleFallback(event);
      return;
    }

    Promise.resolve(axiomClient.ingest(dataset, event)).catch(() => {
      devConsoleFallback(event);
    });
  } catch {
    // logging must never break flow
  }
}
