import { z } from 'zod';
import { PROJECT_EVENT_TYPES } from '../constants/projectEventTypes';

const nullableString = z.string().trim().min(1).nullable().optional();
const nullableAmount = z.number().finite().nonnegative().nullable().optional();
const MAX_SYBIL_RISK_SCORE = 100;
const commonFields = {
  projectId: nullableString,
  walletAddress: nullableString,
  amount: nullableAmount,
  correlationId: nullableString,
  organizationId: nullableString,
  timestamp: z.date(),
  payload: z.record(z.unknown()).default({})
};

const donationConfirmedSchema = z.object({
  ...commonFields,
  eventType: z.literal('DONATION_CONFIRMED'),
  projectId: z.string().trim().min(1),
  walletAddress: z.string().trim().min(1),
  amount: z.number().finite().positive(),
  correlationId: z.string().trim().min(1),
  payload: z.object({
    transactionHash: z.string().trim().min(1),
    blockNumber: z.number().int().nonnegative(),
    isAnonymous: z.boolean()
  }).passthrough()
});

const sbtMintedSchema = z.object({
  ...commonFields,
  eventType: z.literal('SBT_MINTED'),
  projectId: z.string().trim().min(1),
  walletAddress: z.string().trim().min(1),
  payload: z.object({
    tokenId: z.number().int().nonnegative(),
    milestone: z.number().int().nonnegative(),
    beneficiaryCount: z.number().int().nonnegative(),
    sbtId: z.string().trim().min(1),
    transactionHash: z.string().trim().min(1)
  }).passthrough()
});

const sybilFlaggedSchema = z.object({
  ...commonFields,
  eventType: z.literal('SYBIL_FLAGGED'),
  projectId: z.null().optional(),
  walletAddress: z.string().trim().min(1),
  payload: z.object({
    riskScore: z.number().finite().min(0).max(MAX_SYBIL_RISK_SCORE).nullable(),
    flagReason: z.string().trim().min(1)
  }).passthrough()
});

const genericEventSchemas = PROJECT_EVENT_TYPES
  .filter(eventType => !['DONATION_CONFIRMED', 'SBT_MINTED', 'SYBIL_FLAGGED'].includes(eventType))
  .map(eventType => z.object({
    ...commonFields,
    eventType: z.literal(eventType),
    payload: z.record(z.unknown()).default({})
  }));

/** Schema discriminated union bảo đảm ba event trọng yếu luôn đủ dữ liệu phân tích. */
export const projectEventLogInputSchema = z.discriminatedUnion('eventType', [
  donationConfirmedSchema,
  sbtMintedSchema,
  sybilFlaggedSchema,
  ...genericEventSchemas
]);

export type ValidatedProjectEventLogInput = z.infer<typeof projectEventLogInputSchema>;
