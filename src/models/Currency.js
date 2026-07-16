import mongoose from "mongoose";

const { Schema, models, model } = mongoose;

const CurrencySchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 3 },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    symbol: { type: String, required: true, trim: true, maxlength: 10 },
    isEnabled: { type: Boolean, default: false, index: true },
    isDefault: { type: Boolean, default: false },
    order: { type: Number, default: 0, index: true },
  },
  { timestamps: true }
);

export default models.Currency || model("Currency", CurrencySchema);
