export const feedbackLimit = 5 * 1024 * 1024;
export interface FeedbackReport {
  version: 1;
  id: string;
  capturedAt: string;
  release: string;
  environment: string;
  imageAt?: string;
  message: string;
  context?: unknown;
  image?: Blob;
}
export function feedbackBytes(report: FeedbackReport) {
  return (
    new Blob([JSON.stringify({ ...report, image: undefined })]).size +
    (report.image?.size ?? 0)
  );
}
export function validateReport(report: FeedbackReport) {
  if (
    report.version !== 1 ||
    !/^[a-f0-9]{32}$/.test(report.id) ||
    !report.message.trim() ||
    report.message.length > 5000 ||
    !Number.isFinite(Date.parse(report.capturedAt))
  )
    throw new Error("Bitte das Problem beschreiben (höchstens 5000 Zeichen).");
  if (feedbackBytes(report) > feedbackLimit)
    throw new Error(
      "Bericht überschreitet 5 MiB. Bitte Bild oder Diagnose abwählen.",
    );
}
