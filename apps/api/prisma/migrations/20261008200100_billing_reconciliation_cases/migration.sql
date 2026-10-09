-- Billing reliability: durable reconciliation cases + detection runs. ADDITIVE ONLY.
-- Creates five enum types and two new tables; no existing table, column, index or row is changed.
-- Lock impact: CREATE TABLE/TYPE take no locks on existing tables; each ADD CONSTRAINT ... FOREIGN KEY
-- takes a brief SHARE ROW EXCLUSIVE lock on the referenced table (studios, users, subscriptions,
-- payments) while validating an EMPTY referencing table — milliseconds, no rewrite.
-- Rollback: the previous API build never reads these objects; they can stay in place or be dropped
-- with `DROP TABLE billing_reconciliation_cases, billing_reconciliation_runs; DROP TYPE ...`.

-- CreateEnum
CREATE TYPE "BillingCaseCategory" AS ENUM ('STRIPE_CANCELED_LOCAL_ALIVE', 'LOCAL_CANCELED_STRIPE_ALIVE', 'PAID_WITHOUT_ENTITLEMENT', 'STALE_RENEWAL_PERIOD', 'OVERLAPPING_ENTITLEMENT_CYCLES', 'WEBHOOK_DEAD_LETTER', 'WEBHOOK_BACKLOG', 'CANCELLATION_REASON_MISMATCH', 'OPEN_INVOICE_ON_ENDED_SUBSCRIPTION', 'REPEATED_PAYMENT_FAILURES', 'SUBSCRIPTION_IDENTITY_MISMATCH', 'PAYMENT_REFUNDED_OR_DISPUTED');

-- CreateEnum
CREATE TYPE "BillingCaseSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "BillingCaseStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "BillingReconciliationRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "BillingReconciliationRunTrigger" AS ENUM ('CRON', 'MANUAL');

-- CreateTable
CREATE TABLE "billing_reconciliation_cases" (
    "id" TEXT NOT NULL,
    "studio_id" TEXT,
    "issue_key" TEXT NOT NULL,
    "category" "BillingCaseCategory" NOT NULL,
    "severity" "BillingCaseSeverity" NOT NULL,
    "status" "BillingCaseStatus" NOT NULL DEFAULT 'OPEN',
    "reason_code" TEXT,
    "user_id" TEXT,
    "subscription_id" TEXT,
    "payment_id" TEXT,
    "stripe_subscription_id" TEXT,
    "stripe_invoice_id" TEXT,
    "stripe_customer_id" TEXT,
    "stripe_event_id" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "suggested_action" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "history" JSONB NOT NULL DEFAULT '[]',
    "first_detected_at" TIMESTAMP(3) NOT NULL,
    "last_observed_at" TIMESTAMP(3) NOT NULL,
    "observation_count" INTEGER NOT NULL DEFAULT 1,
    "occurrence_count" INTEGER NOT NULL DEFAULT 1,
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by_user_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolved_by_user_id" TEXT,
    "resolution_note" TEXT,
    "dismissed_at" TIMESTAMP(3),
    "dismissed_by_user_id" TEXT,
    "dismiss_reason" TEXT,
    "last_alerted_at" TIMESTAMP(3),
    "alert_count" INTEGER NOT NULL DEFAULT 0,
    "escalated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_reconciliation_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_reconciliation_runs" (
    "id" TEXT NOT NULL,
    "studio_id" TEXT,
    "run_scope" TEXT NOT NULL DEFAULT '*',
    "trigger" "BillingReconciliationRunTrigger" NOT NULL,
    "status" "BillingReconciliationRunStatus" NOT NULL DEFAULT 'RUNNING',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "stats" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_reconciliation_cases_issue_key_key" ON "billing_reconciliation_cases"("issue_key");

-- CreateIndex
CREATE INDEX "billing_reconciliation_cases_studio_id_status_severity_idx" ON "billing_reconciliation_cases"("studio_id", "status", "severity");

-- CreateIndex
CREATE INDEX "billing_reconciliation_cases_studio_id_user_id_status_idx" ON "billing_reconciliation_cases"("studio_id", "user_id", "status");

-- CreateIndex
CREATE INDEX "billing_reconciliation_cases_studio_id_category_status_idx" ON "billing_reconciliation_cases"("studio_id", "category", "status");

-- CreateIndex
CREATE INDEX "billing_reconciliation_cases_status_severity_last_alerted_a_idx" ON "billing_reconciliation_cases"("status", "severity", "last_alerted_at");

-- CreateIndex
CREATE INDEX "billing_reconciliation_runs_studio_id_started_at_idx" ON "billing_reconciliation_runs"("studio_id", "started_at");

-- CreateIndex
CREATE INDEX "billing_reconciliation_runs_status_started_at_idx" ON "billing_reconciliation_runs"("status", "started_at");

-- Overlap guard (not expressible in schema.prisma, like the subscriptions partial unique indexes):
-- at most one RUNNING run per scope, so a second cron/manual trigger fails fast with a unique
-- violation instead of scanning Stripe twice.
CREATE UNIQUE INDEX "billing_reconciliation_runs_one_running_per_scope_idx"
    ON "billing_reconciliation_runs"("run_scope")
    WHERE "status" = 'RUNNING';

-- AddForeignKey
ALTER TABLE "billing_reconciliation_cases" ADD CONSTRAINT "billing_reconciliation_cases_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_reconciliation_cases" ADD CONSTRAINT "billing_reconciliation_cases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_reconciliation_cases" ADD CONSTRAINT "billing_reconciliation_cases_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_reconciliation_cases" ADD CONSTRAINT "billing_reconciliation_cases_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_reconciliation_cases" ADD CONSTRAINT "billing_reconciliation_cases_acknowledged_by_user_id_fkey" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_reconciliation_cases" ADD CONSTRAINT "billing_reconciliation_cases_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_reconciliation_cases" ADD CONSTRAINT "billing_reconciliation_cases_dismissed_by_user_id_fkey" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_reconciliation_runs" ADD CONSTRAINT "billing_reconciliation_runs_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
