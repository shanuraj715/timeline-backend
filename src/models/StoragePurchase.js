import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// Ledger of storage add-on purchases — Timeline.purchasedStorageBytes is
// the running total of bytesGranted here; this collection exists for the
// audit trail. No plan reference: a "plan" is just PlatformSettings' rate
// (storageUnitBytes/storageUnitPriceCredits) at the moment of purchase, not
// a stored catalog entry, so both sides of the deal are snapshotted
// directly on each row instead of pointing at something that can change.
const StoragePurchaseSchema = new Schema(
  {
    timelineId: { type: Schema.Types.ObjectId, ref: "Timeline", required: true, index: true },
    bytesGranted: { type: Number, required: true },
    creditsSpent: { type: Number, required: true },
    purchasedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

StoragePurchaseSchema.index({ timelineId: 1, createdAt: -1 });

export default models.StoragePurchase || model("StoragePurchase", StoragePurchaseSchema);
