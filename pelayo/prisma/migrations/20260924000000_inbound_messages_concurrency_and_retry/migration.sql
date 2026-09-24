-- AlterTable
ALTER TABLE "inbound_messages" ADD COLUMN "processing_started_at" TIMESTAMP(3),
ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "max_attempts" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN "next_retry_at" TIMESTAMP(3),
ADD COLUMN "outbound_message_id" TEXT,
ADD COLUMN "delivery_uncertain" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "inbound_messages_status_next_retry_at_idx" ON "inbound_messages"("status", "next_retry_at");
