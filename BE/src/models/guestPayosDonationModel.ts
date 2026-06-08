/**
 * Schema cho collection guest_payos_donations — lưu trạng thái quyên góp qua PayOS cho guest users.
 * Mỗi record đại diện một giao dịch: tạo QR → thanh toán → mint token → relay donation tự động.
 */
import mongoose, { Schema } from 'mongoose';

export type GuestPayosDonationStatus =
  | 'PENDING_PAYMENT'
  | 'PAYMENT_CONFIRMED'
  | 'MINTING'
  | 'RELAYING'
  | 'COMPLETED'
  | 'FAILED';

export type GuestPayosDonation = {
  id: string;
  orderCode: string;
  guestSessionId: string;
  walletAddress: string;
  projectId: string;
  amount: number;
  status: GuestPayosDonationStatus;
  payosTransactionId: string | null;
  paymentUrl: string;
  returnUrl: string;
  mintTxHash: string | null;
  relayTxHash: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const guestPayosDonationSchema = new Schema<GuestPayosDonation>(
  {
    id: { type: String, required: true, unique: true },
    orderCode: { type: String, required: true, unique: true, index: true },
    guestSessionId: { type: String, required: true, index: true },
    walletAddress: { type: String, required: true },
    projectId: { type: String, required: true },
    amount: { type: Number, required: true },
    status: { type: String, required: true, index: true },
    payosTransactionId: { type: String, default: null },
    paymentUrl: { type: String, required: true },
    returnUrl: { type: String, required: true },
    mintTxHash: { type: String, default: null },
    relayTxHash: { type: String, default: null },
    errorMessage: { type: String, default: null },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true }
  },
  { timestamps: false }
);

guestPayosDonationSchema.index({ guestSessionId: 1, createdAt: -1 });
guestPayosDonationSchema.index({ status: 1 });

export const GuestPayosDonationModel = mongoose.model<GuestPayosDonation>(
  'GuestPayosDonation',
  guestPayosDonationSchema
);
