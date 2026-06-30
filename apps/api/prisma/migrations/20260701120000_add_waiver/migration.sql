-- CreateEnum
CREATE TYPE "WaiverAcceptanceMethod" AS ENUM ('SELF', 'STAFF_ATTESTED');

-- CreateTable
CREATE TABLE "studio_waiver_documents" (
    "id" TEXT NOT NULL,
    "studio_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body_markdown" TEXT NOT NULL,
    "effective_at" TIMESTAMP(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" TEXT,

    CONSTRAINT "studio_waiver_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waiver_acceptances" (
    "id" TEXT NOT NULL,
    "studio_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "waiver_document_id" TEXT NOT NULL,
    "waiver_version" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" "WaiverAcceptanceMethod" NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "attested_by_user_id" TEXT,
    "attestation_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waiver_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "studio_waiver_documents_studio_id_is_active_idx" ON "studio_waiver_documents"("studio_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "studio_waiver_documents_studio_id_version_key" ON "studio_waiver_documents"("studio_id", "version");

-- CreateIndex
CREATE INDEX "waiver_acceptances_studio_id_user_id_idx" ON "waiver_acceptances"("studio_id", "user_id");

-- CreateIndex
CREATE INDEX "waiver_acceptances_waiver_document_id_idx" ON "waiver_acceptances"("waiver_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "waiver_acceptances_studio_id_user_id_waiver_document_id_key" ON "waiver_acceptances"("studio_id", "user_id", "waiver_document_id");

-- AddForeignKey
ALTER TABLE "studio_waiver_documents" ADD CONSTRAINT "studio_waiver_documents_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio_waiver_documents" ADD CONSTRAINT "studio_waiver_documents_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waiver_acceptances" ADD CONSTRAINT "waiver_acceptances_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waiver_acceptances" ADD CONSTRAINT "waiver_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waiver_acceptances" ADD CONSTRAINT "waiver_acceptances_waiver_document_id_fkey" FOREIGN KEY ("waiver_document_id") REFERENCES "studio_waiver_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waiver_acceptances" ADD CONSTRAINT "waiver_acceptances_attested_by_user_id_fkey" FOREIGN KEY ("attested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
