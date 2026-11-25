ALTER TABLE "CartLine" ADD COLUMN "fingerprint" TEXT;
CREATE UNIQUE INDEX "CartLine_customerId_fingerprint_key" ON "CartLine"("customerId", "fingerprint");
ALTER TABLE "Order" ADD COLUMN "cartLineIds" JSONB;
