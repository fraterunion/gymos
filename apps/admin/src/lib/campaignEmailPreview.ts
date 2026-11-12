/** Same limits the API enforces on email-preview; past them a request could only fail. */
const SUBJECT_MAX = 200;
const BODY_MAX = 10_000;

export type EmailPreviewViewport = "desktop" | "mobile";

export const EMAIL_PREVIEW_VIEWPORTS: ReadonlyArray<{ id: EmailPreviewViewport; label: string; width: number | null }> = [
  { id: "desktop", label: "Escritorio", width: null },
  // Narrower than the email's 620px breakpoint, so the iframe shows the real phone layout.
  { id: "mobile", label: "Móvil", width: 390 },
];

/** The composer content worth rendering, or null while there is nothing valid to show yet. */
export function emailPreviewRequest(subject: string, bodyText: string): { subject: string; bodyText: string } | null {
  if (!subject.trim() || !bodyText.trim()) return null;
  if (subject.length > SUBJECT_MAX || bodyText.length > BODY_MAX) return null;
  return { subject, bodyText };
}
