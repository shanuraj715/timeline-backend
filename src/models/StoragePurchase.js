import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

// Ledger of storage add-on purchases — Timeline.storageQuotaBytes is the
// running total (free tier + every bytesGranted here); this collection
// exists for the audit trail, same relationship ThemeUnlock has to
// Theme-driven timeline state.
const StoragePurchaseSchema = new Schema(
  {
    timelineId: { type: Schema.Types.ObjectId, ref: "Timeline", required: true, index: true },
    storagePlanId: { type: Schema.Types.ObjectId, ref: "StoragePlan", required: true },
    bytesGranted: { type: Number, required: true },
    creditsSpent: { type: Number, required: true },
    purchasedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

StoragePurchaseSchema.index({ timelineId: 1, createdAt: -1 });

export default models.StoragePurchase || model("StoragePurchase", StoragePurchaseSchema);
