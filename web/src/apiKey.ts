const STORAGE_KEY = "patient-dispatch-planner.google-api-key";

export function getGoogleApiKey(): string {
  try {
    return (localStorage.getItem(STORAGE_KEY) ?? "").trim();
  } catch {
    return "";
  }
}

export function saveGoogleApiKey(apiKey: string) {
  const value = apiKey.trim();
  if (!value || value.length > 512) throw new Error("invalid_key");
  localStorage.setItem(STORAGE_KEY, value);
}

export function removeGoogleApiKey() {
  localStorage.removeItem(STORAGE_KEY);
}
