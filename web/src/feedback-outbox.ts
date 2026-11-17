import { localDatabase } from "./storage";
import { feedbackLock } from "./feedback-lock";
import { validateReport, type FeedbackReport } from "./feedback-report";
const key = "feedbackOutbox";
export interface Outbox {
  epoch: number;
  revision: number;
  reports: FeedbackReport[];
  retryAt: number;
  error?: string;
}
export async function readOutbox(): Promise<Outbox> {
  const db = await localDatabase.open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("state");
    const reports = tx.objectStore("state").get(key);
    const epoch = tx.objectStore("state").get("feedbackEpoch");
    tx.oncomplete = () =>
      resolve({
        epoch: epoch.result ?? 0,
        revision: reports.result?.revision ?? 0,
        reports: (reports.result?.reports ?? []).map(
          (
            r: FeedbackReport & {
              image?: { bytes: ArrayBuffer; mime: string };
            },
          ) => ({
            ...r,
            image: r.image
              ? new Blob([r.image.bytes], { type: r.image.mime })
              : undefined,
          }),
        ),
        retryAt: reports.result?.retryAt ?? 0,
        error: reports.result?.error,
      });
    tx.onabort = () => reject(tx.error);
  });
}
/** Caller holds feedbackLock, so no transaction spans a network await. */
async function writeOutbox(value: Outbox) {
  const stored = await Promise.all(
    value.reports.map(async (r) => ({
      ...r,
      image: r.image
        ? { bytes: await r.image.arrayBuffer(), mime: r.image.type }
        : undefined,
    })),
  );
  const db = await localDatabase.open();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("state", "readwrite");
    const state = tx.objectStore("state");
    const current = state.get(key),
      epoch = state.get("feedbackEpoch");
    epoch.onsuccess = () => {
      if (
        (current.result?.revision ?? 0) !== value.revision ||
        (epoch.result ?? 0) !== value.epoch
      ) {
        tx.abort();
        return;
      }
      state.put(
        {
          reports: stored,
          retryAt: value.retryAt,
          error: value.error,
          revision: value.revision + 1,
        },
        key,
      );
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}
export function enqueue(report: FeedbackReport, epoch: number) {
  validateReport(report);
  return feedbackLock(async () => {
    const value = await readOutbox();
    if (value.epoch !== epoch)
      throw new Error(
        "Lokale Daten wurden gelöscht. Bitte einen neuen Bericht erstellen.",
      );
    if (value.reports.length >= 5)
      throw new Error(
        "Fünf Meldungen warten bereits. Bitte zuerst senden oder löschen.",
      );
    if (value.reports.some((r) => r.id === report.id))
      throw new Error("Diese Meldung wurde bereits vorgemerkt.");
    value.reports.push(report);
    await writeOutbox(value);
  });
}
export function deleteFeedback(id: string) {
  return feedbackLock(async () => {
    const value = await readOutbox();
    value.reports = value.reports.filter((r) => r.id !== id);
    await writeOutbox(value);
  });
}
export async function drainFeedback(
  send: (report: FeedbackReport) => Promise<void>,
  _force = false,
) {
  if (!navigator.locks) return;
  while (navigator.onLine && !document.hidden) {
    const more = await feedbackLock(async () => {
      const value = await readOutbox();
      if (!value.reports.length || value.retryAt > Date.now()) return false;
      if (!navigator.onLine || document.hidden) return false;
      const report = value.reports[0];
      try {
        await send(report);
      } catch (error) {
        value.retryAt =
          Date.now() + (error instanceof FeedbackRetry ? error.delay : 60_000);
        value.error = error instanceof Error ? error.message : String(error);
        await writeOutbox(value);
        throw error;
      }
      value.reports = value.reports.filter((r) => r.id !== report.id);
      value.retryAt = 0;
      value.error = undefined;
      await writeOutbox(value);
      return true;
    });
    if (!more) return;
    // Yield the lock between messages: queued Delete/Clear/Restore takes precedence.
  }
}
export class FeedbackRetry extends Error {
  constructor(public delay: number) {
    super("Versand vorübergehend begrenzt. Meldung bleibt vorgemerkt.");
  }
}
