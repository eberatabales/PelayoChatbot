-- AlterTable
ALTER TABLE "inbound_messages" ADD COLUMN "claim_recovery_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "whatsapp_status_events" ADD COLUMN "reconcile_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "next_reconcile_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "last_error" TEXT,
ADD COLUMN "abandoned" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "whatsapp_status_events_reconciled_abandoned_next_reconcile_at_idx" ON "whatsapp_status_events"("reconciled", "abandoned", "next_reconcile_at");
