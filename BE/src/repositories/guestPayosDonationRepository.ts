/**
 * Repository cho GuestPayosDonation model.
 * Cung cấp các thao tác CRUD trên collection guest_payos_donations.
 */
import {
  GuestPayosDonationModel,
  type GuestPayosDonation,
  type GuestPayosDonationStatus
} from '../models/guestPayosDonationModel';

export type CreateGuestPayosDonationInput = {
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

export async function createGuestPayosDonation(
  donation: CreateGuestPayosDonationInput
): Promise<GuestPayosDonation> {
  const created = await GuestPayosDonationModel.create(donation);
  return created.toObject() as GuestPayosDonation;
}

export async function findGuestPayosDonationByOrderCode(
  orderCode: string
): Promise<GuestPayosDonation | null> {
  return GuestPayosDonationModel.findOne({ orderCode })
    .lean<GuestPayosDonation>()
    .exec();
}

export async function findLatestGuestPayosDonationBySession(
  guestSessionId: string
): Promise<GuestPayosDonation | null> {
  return GuestPayosDonationModel.findOne({ guestSessionId })
    .sort({ createdAt: -1 })
    .lean<GuestPayosDonation>()
    .exec();
}

export async function updateGuestPayosDonation(
  filter: { orderCode: string },
  update: Partial<GuestPayosDonation> & { updatedAt?: Date }
): Promise<GuestPayosDonation | null> {
  return GuestPayosDonationModel.findOneAndUpdate(
    filter,
    { ...update, updatedAt: new Date() },
    { returnDocument: 'after' }
  )
    .lean<GuestPayosDonation>()
    .exec();
}
