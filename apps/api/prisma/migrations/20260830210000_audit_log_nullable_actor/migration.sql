-- Allow AuditLog rows without a human actor (Stripe-external renewal changes).
ALTER TABLE "audit_logs" ALTER COLUMN "actor_user_id" DROP NOT NULL;
