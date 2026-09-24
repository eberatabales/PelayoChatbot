-- AlterTable
ALTER TABLE "inbound_messages" ADD COLUMN "claim_token" TEXT;

-- CreateTable
CREATE TABLE "whatsapp_send_attempts" (
    "id" TEXT NOT NULL,
    "inbound_message_id" TEXT NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "claim_token" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "initiated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "outbound_message_id" TEXT,
    "response_payload" TEXT,
    "result_classification" TEXT,
    "error_message" TEXT,

    CONSTRAINT "whatsapp_send_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_status_events" (
    "id" TEXT NOT NULL,
    "status_id" TEXT NOT NULL,
    "external_message_id" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "timestamp" TEXT NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reconciled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "whatsapp_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatsapp_send_attempts_inbound_message_id_idx" ON "whatsapp_send_attempts"("inbound_message_id");

-- CreateIndex
CREATE INDEX "whatsapp_send_attempts_outbound_message_id_idx" ON "whatsapp_send_attempts"("outbound_message_id");

-- CreateIndex
CREATE INDEX "whatsapp_send_attempts_status_idx" ON "whatsapp_send_attempts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_status_events_status_id_key" ON "whatsapp_status_events"("status_id");

-- CreateIndex
CREATE INDEX "whatsapp_status_events_external_message_id_idx" ON "whatsapp_status_events"("external_message_id");

-- CreateIndex
CREATE INDEX "whatsapp_status_events_recipient_id_idx" ON "whatsapp_status_events"("recipient_id");

-- AddForeignKey
ALTER TABLE "whatsapp_send_attempts" ADD CONSTRAINT "whatsapp_send_attempts_inbound_message_id_fkey" FOREIGN KEY ("inbound_message_id") REFERENCES "inbound_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
