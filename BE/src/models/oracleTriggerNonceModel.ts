import mongoose, { Schema } from 'mongoose';

type OracleTriggerNonceRecord = {
  nonce: string;
  expiresAt: Date;
  createdAt: Date;
};

const oracleTriggerNonceSchema = new Schema<OracleTriggerNonceRecord>(
  {
    nonce: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    createdAt: { type: Date, required: true, default: Date.now }
  },
  { versionKey: false }
);

const OracleTriggerNonceMongoModel = mongoose.models.OracleTriggerNonce
  || mongoose.model<OracleTriggerNonceRecord>('OracleTriggerNonce', oracleTriggerNonceSchema, 'oracle_trigger_nonces');

/** Atomically consume nonce Oracle để ngăn replay cùng một chữ ký trong thời gian hiệu lực. */
export async function consumeOracleTriggerNonce(nonce: string, expiresAt: Date): Promise<boolean> {
  try {
    await OracleTriggerNonceMongoModel.create({ nonce, expiresAt, createdAt: new Date() });
    return true;
  } catch (error) {
    if ((error as { code?: number })?.code === 11000) return false;
    throw error;
  }
}
