-- CreateTable
CREATE TABLE "studio_day_pass_settings" (
    "id" TEXT NOT NULL,
    "studio_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL DEFAULT 'Day Pass',
    "price_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'mxn',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "stripe_product_id" TEXT,
    "stripe_price_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "studio_day_pass_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "studio_day_pass_settings_studio_id_key" ON "studio_day_pass_settings"("studio_id");

-- AddForeignKey
ALTER TABLE "studio_day_pass_settings" ADD CONSTRAINT "studio_day_pass_settings_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
