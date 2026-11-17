import { FeedbackRetry } from "./feedback-outbox";
import type { FeedbackReport } from "./feedback-report";
/** Isolated client: no global scope, auto-instrumentation, sessions or background telemetry. */
export async function sendFeedback(report: FeedbackReport) {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn)
    throw new Error(
      "Feedback-Versand ist noch nicht eingerichtet. Meldung bleibt auf diesem Gerät.",
    );
  const { BrowserClient, Scope } = await import("@sentry/browser");
  const { serializeEnvelope } = await import("@sentry/core");
  const url = new URL(dsn);
  const project = url.pathname.split("/").filter(Boolean).at(-1)!;
  const endpoint = `${url.origin}/api/${project}/envelope/?sentry_key=${encodeURIComponent(url.username)}&sentry_version=7`;
  const attachments: {
    filename: string;
    data: Uint8Array;
    contentType: string;
  }[] = [];
  if (report.context !== undefined)
    attachments.push({
      filename: "diagnose.json",
      data: new TextEncoder().encode(JSON.stringify(report.context)),
      contentType: "application/json",
    });
  if (report.image)
    attachments.push({
      filename: "ansicht.png",
      data: new Uint8Array(await report.image.arrayBuffer()),
      contentType: "image/png",
    });
  let accepted = false;
  let delivery: Promise<unknown> = Promise.resolve();
  const client = new BrowserClient({
    dsn,
    stackParser: () => [],
    integrations: [],
    release: report.release,
    environment: report.environment,
    sendClientReports: false,
    transport: () => ({
      flush: async () => {
        await delivery.catch(() => {});
        return accepted;
      },
      send: async (envelope) => {
        const items = envelope[1];
        if (
          items.filter((item) => item[0].type === "attachment").length !==
            attachments.length ||
          !items.some((item) => item[0].type === "feedback")
        )
          throw new Error(
            "Unvollständiges Feedbackpaket; Meldung bleibt vorgemerkt.",
          );
        if (document.hidden || !navigator.onLine)
          throw new Error(
            "Versand pausiert. Bitte App mit Internet geöffnet lassen.",
          );
        const response = await fetch(endpoint, {
          method: "POST",
          body: serializeEnvelope(envelope) as BodyInit,
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(30_000),
        });
        const limits = response.headers.get("X-Sentry-Rate-Limits");
        const delay = Math.max(
          0,
          ...(limits ?? "").split(",").map((value) => {
            const [seconds, categories] = value.trim().split(":");
            return !categories ||
              categories
                .split(";")
                .some((c) => ["feedback", "attachment", "default"].includes(c))
              ? Number(seconds) * 1000 || 0
              : 0;
          }),
        );
        if (delay > 0) throw new FeedbackRetry(delay);
        if (response.status === 429) {
          const retry = response.headers.get("Retry-After");
          const seconds = Number(retry);
          throw new FeedbackRetry(
            retry && Number.isFinite(seconds)
              ? Math.max(1000, seconds * 1000)
              : Math.max(60_000, Date.parse(retry ?? "") - Date.now() || 0),
          );
        }
        if (!response.ok)
          throw new Error(
            `Feedback konnte nicht gesendet werden (HTTP ${response.status}).`,
          );
        accepted = true;
        return { statusCode: response.status };
      },
    }),
  });
  const scope = new Scope();
  scope.setClient(client);
  let failure: unknown;
  // SDK reports transport failures via flush/outcomes; own transport retains the actual error.
  const transport = client.getTransport()!;
  const original = transport.send.bind(transport);
  transport.send = (envelope) => {
    const sending = Promise.resolve(original(envelope)).catch((error) => {
      failure = error;
      throw error;
    });
    delivery = sending;
    return sending;
  };
  scope.captureEvent(
    {
      type: "feedback",
      event_id: report.id,
      timestamp: Date.parse(report.capturedAt) / 1000,
      contexts: {
        feedback: {
          message: report.message,
          source: "custom",
          url: location.origin + location.pathname,
        },
      },
    },
    { attachments, event_id: report.id },
  );
  await client.flush(31_000);
  await client.close(1000);
  if (!accepted)
    throw (
      failure ??
      new Error("Versand nicht bestätigt. Meldung bleibt vorgemerkt.")
    );
}
