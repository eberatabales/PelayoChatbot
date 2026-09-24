-- CreateTable
CREATE TABLE "inbound_messages" (
    "id" TEXT NOT NULL,
    "external_message_id" TEXT NOT NULL,
    "from_phone" TEXT NOT NULL,
    "message_type" TEXT NOT NULL,
    "content" TEXT,
    "raw_payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "response_sent" BOOLEAN NOT NULL DEFAULT false,
    "response_payload" TEXT,
    "error_message" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "inbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inbound_messages_external_message_id_key" ON "inbound_messages"("external_message_id");

-- CreateIndex
CREATE INDEX "inbound_messages_from_phone_idx" ON "inbound_messages"("from_phone");

-- CreateIndex
CREATE INDEX "inbound_messages_status_idx" ON "inbound_messages"("status");
