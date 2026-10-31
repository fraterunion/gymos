import assert from "node:assert/strict";
import test from "node:test";

import { campaignAction, campaignStateLabel, formatSender } from "./campaignDelivery.ts";

const base = { failedCount: 0, sentCount: 0, recipientCount: 3 };

test("SENDING campaigns read as active, paused or stopped", () => {
  assert.equal(campaignStateLabel({ ...base, status: "SENDING", deliveryState: "ACTIVE", sentCount: 1 }).label, "Enviando · 1/3 enviados");
  assert.equal(campaignStateLabel({ ...base, status: "SENDING", deliveryState: "PAUSED", pendingCount: 3 }).label, "En pausa · envíos desactivados · 3 pendientes");
  assert.equal(campaignStateLabel({ ...base, status: "SENDING", deliveryState: "STALE", pendingCount: 2 }).label, "Detenida · requiere reanudar · 2 pendientes");
  assert.equal(campaignStateLabel({ ...base, status: "DRAFT" }).label, "Borrador · no enviada");
  assert.equal(campaignStateLabel({ ...base, status: "PARTIAL", failedCount: 1, sentCount: 2 }).tone, "danger");
});

test("no action is offered while delivery is paused", () => {
  for (const status of ["DRAFT", "SENDING", "PARTIAL", "FAILED"]) {
    assert.equal(campaignAction({ ...base, status, deliveryState: "STALE", failedCount: 1 }, false), null);
  }
});

test("one explicit action per state when delivery is active", () => {
  assert.equal(campaignAction({ ...base, status: "DRAFT" }, true), "CONFIRM");
  assert.equal(campaignAction({ ...base, status: "SENDING", deliveryState: "STALE" }, true), "RESUME");
  assert.equal(campaignAction({ ...base, status: "SENDING", deliveryState: "ACTIVE" }, true), null);
  assert.equal(campaignAction({ ...base, status: "PARTIAL", failedCount: 1 }, true), "RETRY_FAILED");
  assert.equal(campaignAction({ ...base, status: "COMPLETED", sentCount: 3 }, true), null);
});

test("sender line matches the From header", () => {
  assert.equal(formatSender("ARES Training Club", "fernando@arestrainingclub.com"), "ARES Training Club <fernando@arestrainingclub.com>");
  assert.equal(formatSender(null, "no-reply@arestrainingclub.com"), "no-reply@arestrainingclub.com");
  assert.equal(formatSender(null, null), "—");
});
