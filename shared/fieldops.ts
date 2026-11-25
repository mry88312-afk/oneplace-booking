export const FIELDOPS_BASE_URL = "https://fieldops.oneplace.com.tw";

export function isFieldopsInboxUrl(url: string): boolean {
  const match = /^(https:\/\/[^/]+)\/inbox\?uid=U[0-9a-f]{32}$/i.exec(url);
  const origin = match?.[1].toLowerCase();
  return origin === FIELDOPS_BASE_URL || origin === "https://fieldops.zeabur.app";
}
