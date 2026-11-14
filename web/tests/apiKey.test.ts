import { strict as assert } from "node:assert";
import { test } from "node:test";
import { getGoogleApiKey, removeGoogleApiKey, saveGoogleApiKey } from "../src/apiKey.ts";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  },
});

test("the API key is trimmed, validated and removable", () => {
  assert.equal(getGoogleApiKey(), "");
  assert.throws(() => saveGoogleApiKey("   "));
  assert.throws(() => saveGoogleApiKey("k".repeat(513)));
  saveGoogleApiKey("  key  ");
  assert.equal(getGoogleApiKey(), "key");
  removeGoogleApiKey();
  assert.equal(getGoogleApiKey(), "");
});
