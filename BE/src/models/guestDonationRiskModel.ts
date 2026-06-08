/**
 * Schema cho collection guest_donation_risks — lưu trữ kết quả đánh giá risk
 * cho từng phiên guest wallet. Risk score ảnh hưởng trực tiếp đến trustMultiplier
 * trong QF calculation và quyết định dùng Free Paymaster hay Token Paymaster.
 */
import mongoose, { Schema } from 'mongoose';

export type RiskLevel = 'SAFE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type RiskFactors = {
  walletAgeScore: number;
  ipBurstScore: number;
  fingerprintReuseScore: number;
  donationPatternScore: number;
  sessionVelocityScore: number;
};

export type GuestDonationRisk = {
  _id?: mongoose.Types.ObjectId;
  sessionId: string;
  walletAddress: string;
  riskScore: number;
  riskLevel: RiskLevel;
  trustMultiplier: number;
  factors: RiskFactors;
  blocked: boolean;
  blockedAt: Date | null;
  blockedReason: string | null;
  clusterSuspect: boolean;
  clusterId: string | null;
  lastEvaluatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const riskFactorsSchema = new Schema<RiskFactors>(
  {
    walletAgeScore: { type: Number, required: true, default: 0 },
    ipBurstScore: { type: Number, required: true, default: 0 },
    fingerprintReuseScore: { type: Number, required: true, default: 0 },
    donationPatternScore: { type: Number, required: true, default: 0 },
    sessionVelocityScore: { type: Number, required: true, default: 0 }
  },
  { _id: false }
);

const guestDonationRiskSchema = new Schema<GuestDonationRisk>(
  {
    sessionId: { type: String, required: true },
    walletAddress: { type: String, required: true },
    riskScore: { type: Number, required: true, default: 0, min: 0, max: 100 },
    riskLevel: {
      type: String,
      required: true,
      enum: ['SAFE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      default: 'SAFE'
    },
    trustMultiplier: {
      type: Number,
      required: true,
      default: 1.0,
      min: 0,
      max: 1
    },
    factors: { type: riskFactorsSchema, required: true },
    blocked: { type: Boolean, required: true, default: false },
    blockedAt: { type: Date, default: null },
    blockedReason: { type: String, default: null },
    clusterSuspect: { type: Boolean, required: true, default: false },
    clusterId: { type: String, default: null },
    lastEvaluatedAt: { type: Date, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true }
  },
  { timestamps: false }
);

guestDonationRiskSchema.index({ sessionId: 1 }, { unique: true });
guestDonationRiskSchema.index({ walletAddress: 1 });
guestDonationRiskSchema.index({ clusterId: 1 });
guestDonationRiskSchema.index({ riskScore: 1 });
guestDonationRiskSchema.index({ clusterSuspect: 1 });

export const GuestDonationRiskModel = mongoose.model<GuestDonationRisk>(
  'GuestDonationRisk',
  guestDonationRiskSchema
);
