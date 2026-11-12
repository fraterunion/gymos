import assert from "node:assert/strict";
import test from "node:test";

import { EMAIL_PREVIEW_VIEWPORTS, emailPreviewRequest } from "./campaignEmailPreview.ts";

test("nothing is rendered until both subject and message have content", () => {
  assert.equal(emailPreviewRequest("", "Hola"), null);
  assert.equal(emailPreviewRequest("Aviso", "   \n "), null);
  assert.deepEqual(emailPreviewRequest("Aviso", "Hola\n\nequipo"), { subject: "Aviso", bodyText: "Hola\n\nequipo" });
});

test("content the API would reject is not requested", () => {
  assert.equal(emailPreviewRequest("a".repeat(201), "Hola"), null);
  assert.equal(emailPreviewRequest("Aviso", "a".repeat(10_001)), null);
  assert.notEqual(emailPreviewRequest("a".repeat(200), "a".repeat(10_000)), null);
});

test("the phone preview is narrower than the email's 620px breakpoint", () => {
  const mobile = EMAIL_PREVIEW_VIEWPORTS.find((viewport) => viewport.id === "mobile");
  assert.ok(mobile?.width && mobile.width < 620);
});
