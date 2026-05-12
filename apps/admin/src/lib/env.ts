export function getPublicApiOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL;
  if (!raw || typeof raw !== "string") return "";
  return raw.replace(/\/+$/, "");
}

export function getApiV1Base(): string {
  const o = getPublicApiOrigin();
  if (!o) return "";
  return `${o}/api/v1`;
}
