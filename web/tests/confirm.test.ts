import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmAction } from "../src/confirm.ts";

test("confirmation only approves an explicit confirm response", async () => {
  class Element {
    children: Element[] = [];
    value = "";
    returnValue = "";
    textContent = "";
    removed = false;
    onClose = () => {};
    setAttribute() {}
    append(...children: Element[]) { this.children.push(...children); }
    addEventListener(_name: string, callback: () => void) { this.onClose = callback; }
    showModal() {}
    remove() { this.removed = true; }
    close(value = "") { this.returnValue = value; this.onClose(); }
  }
  const body = new Element();
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", { configurable: true, value: { body, createElement: () => new Element() } });
  try {
    for (const [response, expected] of [["confirm", true], ["cancel", false], ["", false]] as const) {
      const answer = confirmAction("Attention");
      const dialog = body.children.at(-1)!;
      assert.equal(dialog.children[0].children[0].textContent, "Attention");
      dialog.close(response);
      assert.equal(await answer, expected);
      assert.equal(dialog.removed, true);
    }
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  }
});
