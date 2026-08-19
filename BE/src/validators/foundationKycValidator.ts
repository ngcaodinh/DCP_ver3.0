import { z } from 'zod';
import { FOUNDATION_KYC_SUPPORTED_BANK_NAMES } from '../constants/foundationKycPolicy';

const foundationKycSupportedBankNameSet = new Set<string>(FOUNDATION_KYC_SUPPORTED_BANK_NAMES);

/** Schema xác thực payload KYC FOUNDATION public tại boundary HTTP. */
export const foundationKycSubmitSchema = z.object({
  organizationName: z.string().trim().min(3).max(200),
  legalRegistrationNumber: z.string().trim().min(5).max(50).regex(/^[A-Za-z0-9.\-\s]+$/),
  taxIdentificationNumber: z.string().trim().regex(/^\d{10}(?:-?\d{3})?$/),
  officialWebsite: z.union([
    z.string().trim().url().max(500),
    z.literal('')
  ]).optional(),
  organizationDescription: z.string().trim().min(20).max(2000),
  legalDocument: z.object({
    fileName: z.string().trim().min(1).max(255),
    mimeType: z.enum(['application/pdf', 'image/png', 'image/jpeg']),
    base64Content: z.string().min(1)
  }),
  bankName: z.string().trim().min(2).max(200).refine(
    bankName => foundationKycSupportedBankNameSet.has(bankName),
    'Ngân hàng chưa được payOS hỗ trợ liên kết cho tài khoản doanh nghiệp.'
  ),
  bankAccountNumber: z.string().trim().regex(/^[0-9]{8,20}$/),
  accountHolderName: z.string().trim().min(2).max(200),
  branchName: z.union([
    z.string().trim().max(200),
    z.literal('')
  ]).optional(),
  recaptchaToken: z.string().trim().min(1),
  additionalEmail: z.string().trim().max(320).optional()
});

export type FoundationKycSubmitPayload = z.infer<typeof foundationKycSubmitSchema>;
