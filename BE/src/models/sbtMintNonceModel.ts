import mongoose, { Schema } from 'mongoose';

/** Bản ghi allocator nonce theo signer EOA và network đã cấu hình. */
type SbtMintNonceRecord = {
  networkScope: string;
  signerAddress: string;
  nextNonce: number;
  createdAt: Date;
  updatedAt: Date;
};

const sbtMintNonceSchema = new Schema<SbtMintNonceRecord>(
  {
    networkScope: { type: String, required: true, index: true },
    signerAddress: { type: String, required: true, index: true },
    nextNonce: { type: Number, required: true, min: 0 }
  },
  { timestamps: true }
);
// Cùng EOA có thể được dùng trên nhiều chain; nonce allocator phải tách namespace network.
sbtMintNonceSchema.index({ networkScope: 1, signerAddress: 1 }, { unique: true });

const SbtMintNonceMongoModel = mongoose.models.SbtMintNonce
  ?? mongoose.model<SbtMintNonceRecord>('SbtMintNonce', sbtMintNonceSchema, 'sbt_mint_nonces');

/** Reserve atomically nonce kế tiếp, tự đồng bộ theo pending nonce đọc từ RPC khi allocator mới hoặc lag. */
export async function reserveNextSbtMintNonce(
  signerAddress: string,
  chainPendingNonce: number
): Promise<number> {
  const networkScope = process.env.BLOCKCHAIN_CHAIN_ID?.trim() || 'unknown-chain';
  const record = await SbtMintNonceMongoModel.findOneAndUpdate(
    { networkScope, signerAddress: signerAddress.toLowerCase() },
    [
      {
        $set: {
          nextNonce: {
            $add: [
              { $max: [{ $ifNull: ['$nextNonce', 0] }, Math.max(0, chainPendingNonce)] },
              1
            ]
          },
          createdAt: { $ifNull: ['$createdAt', '$$NOW'] },
          updatedAt: '$$NOW'
        }
      }
    ],
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  ).lean().exec();

  if (!record) {
    throw new Error('Không reserve được nonce cho SBT mint signer.');
  }
  return record.nextNonce - 1;
}
