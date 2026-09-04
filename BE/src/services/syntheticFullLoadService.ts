import crypto from 'crypto';
import jsonWebToken, { SignOptions } from 'jsonwebtoken';
import { getJsonWebTokenConfig, getJsonWebTokenSecret } from '../config/jsonWebToken';
import { AuthUserModel, type AuthUser } from '../models/authModel';
import {
  createOrganizationKycSubmission,
  updateOrganizationKycSubmissionReview,
  type OrganizationKycFile
} from '../models/organizationKycModel';
import {
  createProjectRecord,
  updateProjectByProjectId
} from '../models/projectModel';
import {
  aggregateDonationSummaryByProjectId,
  countDonations
} from '../models/donationModel';
import {
  createDisbursementRecord,
  updateDisbursementByRequestId
} from '../models/disbursementModel';
import {
  createDisbursementCommitteeVote,
  DisbursementCommitteeVoteMongoModel,
  type DisbursementCommitteeSnapshotMember,
  type DisbursementCommitteeVote
} from '../models/disbursementCommitteeVoteModel';
import { createSyntheticUsers } from './syntheticE2eService';

const DEFAULT_DONATION_REQUEST_COUNT = 20_000;
const DEFAULT_DONATION_AMOUNT_PER_REQUEST = 100;
const DEFAULT_DISBURSEMENT_AMOUNT = 10_000;
const MAX_DONATION_REQUEST_COUNT = 25_000;

export type SyntheticFullLoadInput = {
  donationRequestCount?: number;
  donationAmountPerRequest?: number;
  disbursementAmount?: number;
};

export type SyntheticFullLoadBootstrapResult = {
  synthetic: true;
  runId: string;
  projectId: string;
  organizationId: string;
  donorUserId: string;
  donorAccessToken: string;
  donationRequestCount: number;
  donationAmountPerRequest: number;
  disbursementAmount: number;
  bootstrapDurationMs: number;
  status: {
    kyc: 'APPROVED';
    bankAccount: 'APPROVED';
    project: 'ACTIVE';
  };
};

export type SyntheticFullLoadFinalizeResult = {
  synthetic: true;
  runId: string;
  projectId: string;
  donationRequestCount: number;
  donationAmountPerRequest: number;
  donationTotalAmount: number;
  disbursementAmount: number;
  totalDurationMs: number;
  stages: Array<{
    name: string;
    startedAt: string;
    completedAt: string;
    durationMs: number;
  }>;
  records: {
    organizationId: string;
    kycSubmissionId: string;
    bankSubmissionId: string;
    projectId: string;
    disbursementRequestId: string;
    committeeVoteId: string;
  };
  finalStatus: {
    kyc: 'APPROVED';
    bankAccount: 'APPROVED';
    project: 'ACTIVE';
    donation: 'INDEXED';
    disbursement: 'COMPLETED';
    payosTransfer: 'SUCCESS';
  };
};

type SyntheticStage = SyntheticFullLoadFinalizeResult['stages'][number];

type SyntheticFullLoadContext = {
  runId: string;
  organizationUser: AuthUser;
  donorUser: AuthUser;
  regulatoryUser: AuthUser;
  committeeUsers: AuthUser[];
  organizationName: string;
  legalRegistrationNumber: string;
  bankAccount: {
    bankName: string;
    bankAccountNumber: string;
    accountHolderName: string;
    branchName: string;
  };
  kycSubmissionId: string;
  bankSubmissionId: string;
  projectId: string;
  donationRequestCount: number;
  donationAmountPerRequest: number;
  disbursementAmount: number;
  startedAt: number;
  stages: SyntheticStage[];
};

const activeRuns = new Map<string, SyntheticFullLoadContext>();

function validateInput(input: SyntheticFullLoadInput): Required<SyntheticFullLoadInput> {
  const donationRequestCount = input.donationRequestCount ?? DEFAULT_DONATION_REQUEST_COUNT;
  const donationAmountPerRequest = input.donationAmountPerRequest ?? DEFAULT_DONATION_AMOUNT_PER_REQUEST;
  const disbursementAmount = input.disbursementAmount ?? DEFAULT_DISBURSEMENT_AMOUNT;

  if (!Number.isSafeInteger(donationRequestCount) || donationRequestCount < 1 || donationRequestCount > MAX_DONATION_REQUEST_COUNT) {
    throw new Error(`donationRequestCount phải trong khoảng 1-${MAX_DONATION_REQUEST_COUNT}.`);
  }
  if (!Number.isSafeInteger(donationAmountPerRequest) || donationAmountPerRequest <= 0) {
    throw new Error('donationAmountPerRequest phải là số nguyên dương.');
  }
  const totalDonationAmount = donationRequestCount * donationAmountPerRequest;
  if (!Number.isSafeInteger(totalDonationAmount)) {
    throw new Error('Tổng giá trị donation vượt quá giới hạn số an toàn.');
  }
  if (!Number.isSafeInteger(disbursementAmount) || disbursementAmount <= 0 || disbursementAmount > totalDonationAmount) {
    throw new Error('disbursementAmount phải là số nguyên dương và không vượt tổng donation.');
  }

  return { donationRequestCount, donationAmountPerRequest, disbursementAmount };
}

async function measureStage<T>(stages: SyntheticStage[], name: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = new Date();
  const result = await operation();
  const completedAt = new Date();
  stages.push({
    name,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime()
  });
  return result;
}

function createDonorAccessToken(user: AuthUser): string {
  const config = getJsonWebTokenConfig();
  return jsonWebToken.sign(
    {
      userId: user.id,
      email: user.email,
      walletAddress: user.walletAddress,
      role: user.role,
      authVersion: user.authVersion ?? 1
    },
    getJsonWebTokenSecret(),
    {
      issuer: config.issuer,
      audience: config.audience,
      expiresIn: config.accessTokenExpiresIn as SignOptions['expiresIn']
    }
  );
}

/** Chuẩn bị KYC, ngân hàng và project ACTIVE cho test 20.000 request. */
export async function bootstrapSyntheticFullLoad(input: SyntheticFullLoadInput = {}): Promise<SyntheticFullLoadBootstrapResult> {
  const { donationRequestCount, donationAmountPerRequest, disbursementAmount } = validateInput(input);
  const runId = crypto.randomUUID();
  const stages: SyntheticStage[] = [];
  const startedAt = Date.now();
  const users = await measureStage(stages, 'registration', () => createSyntheticUsers(runId));
  const organizationName = `Synthetic Organization ${runId}`;
  const legalRegistrationNumber = `SYN-${runId}`;
  const now = new Date();
  const kycSubmissionId = crypto.randomUUID();
  const kycFile: OrganizationKycFile = {
    cid: `bafy-synthetic-${runId}-kyc`,
    fileName: 'registration.pdf',
    mimeType: 'application/pdf',
    fileSize: 8,
    documentType: 'LEGAL_REGISTRATION',
    version: 1,
    uploadedBy: users.organizationUser.id,
    uploadedAt: now,
    reviewStatus: 'PENDING_REVIEW',
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: null
  };

  await measureStage(stages, 'kyc_submission', () => createOrganizationKycSubmission({
    submissionId: kycSubmissionId,
    organizationId: users.organizationUser.id,
    organizationName,
    legalRegistrationNumber,
    officialWebsite: 'https://example.org',
    organizationDescription: 'Synthetic full-system performance test.',
    organizationCategory: 'NGO',
    version: 1,
    status: 'PENDING_REVIEW',
    submittedBy: users.organizationUser.id,
    submittedAt: now,
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: null,
    beneficiaryBankAccount: null,
    files: [kycFile]
  }));

  await measureStage(stages, 'kyc_approval', async () => {
    const reviewedAt = new Date();
    const updatedSubmission = await updateOrganizationKycSubmissionReview(kycSubmissionId, {
      status: 'APPROVED',
      reviewedBy: users.regulatoryUser.id,
      reviewedAt,
      rejectionReason: null,
      files: [{ ...kycFile, reviewStatus: 'APPROVED', reviewedBy: users.regulatoryUser.id, reviewedAt }]
    });
    if (!updatedSubmission) throw new Error('Không thể duyệt hồ sơ KYC synthetic.');
    await AuthUserModel.updateOne(
      { id: users.organizationUser.id },
      { $set: { role: 'organizations', accountStatus: 'ACTIVE', organizationName, legalRegistrationNumber } }
    ).exec();
  });

  const bankAccount = {
    bankName: 'Synthetic Bank',
    bankAccountNumber: `97${runId.replaceAll('-', '').slice(0, 10)}`,
    accountHolderName: 'DCP SYNTHETIC TEST',
    branchName: 'Sandbox'
  };
  const bankSubmissionId = crypto.randomUUID();
  await measureStage(stages, 'beneficiary_bank_submission', () => createOrganizationKycSubmission({
    submissionId: bankSubmissionId,
    organizationId: users.organizationUser.id,
    organizationName,
    legalRegistrationNumber,
    officialWebsite: null,
    organizationDescription: 'Synthetic beneficiary bank account.',
    organizationCategory: 'NGO',
    version: 2,
    status: 'PENDING_REVIEW',
    submittedBy: users.organizationUser.id,
    submittedAt: new Date(),
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: null,
    beneficiaryBankAccount: bankAccount,
    files: []
  }));

  await measureStage(stages, 'beneficiary_bank_approval', async () => {
    const reviewedAt = new Date();
    const updatedSubmission = await updateOrganizationKycSubmissionReview(bankSubmissionId, {
      status: 'APPROVED',
      reviewedBy: users.regulatoryUser.id,
      reviewedAt,
      rejectionReason: null,
      files: []
    });
    if (!updatedSubmission) throw new Error('Không thể duyệt tài khoản ngân hàng synthetic.');
  });

  const projectId = `SYNTHETIC-FULL-PROJECT-${runId}`;
  const totalDonationAmount = donationRequestCount * donationAmountPerRequest;
  await measureStage(stages, 'project_creation', () => createProjectRecord({
    projectId,
    organizationId: users.organizationUser.id,
    name: `Synthetic Full Load Project ${runId}`,
    description: 'Synthetic project for full-system performance measurement.',
    goalAmount: totalDonationAmount,
    deadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    status: 'PENDING_APPROVAL',
    evidenceCids: [`bafy-synthetic-${runId}-evidence`],
    evidenceFiles: [],
    submittedAt: new Date(),
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: null,
    milestonePlan: [{ milestoneIndex: 1, milestoneKey: 'M1_ADVANCE', percentage: 100, description: 'Synthetic milestone.' }],
    listedAt: null,
    activationEligibleAt: null,
    activationState: 'NOT_STARTED',
    activationAttemptCount: 0,
    activationLastAttemptAt: null,
    activationLastError: null,
    listingRound: 1,
    closureState: 'NOT_REQUIRED',
    createdAt: new Date(),
    updatedAt: new Date()
  }));

  await measureStage(stages, 'project_approval', async () => {
    const updatedProject = await updateProjectByProjectId(projectId, {
      status: 'PENDING_ACTIVATION',
      reviewedAt: new Date(),
      reviewedBy: users.regulatoryUser.id
    });
    if (!updatedProject) throw new Error('Không thể duyệt project synthetic.');
  });

  await measureStage(stages, 'project_activation', async () => {
    const updatedProject = await updateProjectByProjectId(projectId, {
      status: 'ACTIVE',
      listedAt: new Date(),
      activationEligibleAt: new Date(),
      activationState: 'SYNCED',
      activationAttemptCount: 1,
      activationLastAttemptAt: new Date()
    });
    if (!updatedProject) throw new Error('Không thể kích hoạt project synthetic.');
  });

  activeRuns.set(runId, {
    runId,
    organizationUser: users.organizationUser,
    donorUser: users.donorUser,
    regulatoryUser: users.regulatoryUser,
    committeeUsers: users.committeeUsers,
    organizationName,
    legalRegistrationNumber,
    bankAccount,
    kycSubmissionId,
    bankSubmissionId,
    projectId,
    donationRequestCount,
    donationAmountPerRequest,
    disbursementAmount,
    startedAt,
    stages
  });

  return {
    synthetic: true,
    runId,
    projectId,
    organizationId: users.organizationUser.id,
    donorUserId: users.donorUser.id,
    donorAccessToken: createDonorAccessToken(users.donorUser),
    donationRequestCount,
    donationAmountPerRequest,
    disbursementAmount,
    bootstrapDurationMs: Date.now() - startedAt,
    status: { kyc: 'APPROVED', bankAccount: 'APPROVED', project: 'ACTIVE' }
  };
}

/** Kiểm tra 20.000 donation request và chạy committee/disbursement sau cùng một run. */
export async function finalizeSyntheticFullLoad(runId: string): Promise<SyntheticFullLoadFinalizeResult> {
  const context = activeRuns.get(runId.trim());
  if (!context) throw new Error('Không tìm thấy synthetic full-load run hoặc run đã hết hạn.');

  const donationSummary = await aggregateDonationSummaryByProjectId(context.projectId);
  const donationCount = await countDonations(context.projectId);
  if (donationCount !== context.donationRequestCount) {
    throw new Error(`Donation chưa đủ: nhận ${donationCount}/${context.donationRequestCount} request.`);
  }

  const requestId = crypto.randomUUID();
  await measureStage(context.stages, 'disbursement_requested', () => createDisbursementRecord({
    requestId,
    onChainRequestId: Number.parseInt(runId.replaceAll('-', '').slice(0, 8), 16),
    projectId: context.projectId,
    onChainProjectId: 1,
    organizationId: context.organizationUser.id,
    requestMode: 'NORMAL',
    emergencyReason: null,
    requiredApprovals: 3,
    raisedRatioBpsAtCreation: 10000,
    beneficiaryWalletAddress: context.organizationUser.walletAddress,
    beneficiaryBankAccount: context.bankAccount,
    amount: context.disbursementAmount,
    usagePurpose: 'Synthetic full-system performance test.',
    evidenceCid: `bafy-synthetic-${runId}-disbursement`,
    evidencePhotos: [],
    status: 'PENDING',
    approvals: [],
    rejection: null,
    timeoutDeadline: null,
    payosTransferId: null,
    payosTransferStatus: null,
    payosTransferAttemptCount: 0,
    payosTransferLastError: null,
    transferIdempotencyKey: `synthetic-full-${runId}`,
    creationTransactionHash: `0x${crypto.createHash('sha256').update(`${runId}:create`).digest('hex')}`,
    transactionHash: null,
    finalizeTransactionHash: null,
    finalizeClaimId: null,
    finalizeClaimedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    expiredAt: null,
    completedAt: null
  }));

  const snapshot: DisbursementCommitteeSnapshotMember[] = context.committeeUsers.map(user => ({
    userId: user.id,
    role: user.role as 'executive_chair' | 'executive_member',
    fullName: user.fullName,
    walletAddress: user.walletAddress,
    governanceWalletAddress: user.governanceWalletAddress || null
  }));
  const votes: DisbursementCommitteeVote[] = context.committeeUsers.slice(0, 3).map(user => ({
    voterUserId: user.id,
    voterRole: user.role as 'executive_chair' | 'executive_member',
    decision: 'APPROVE',
    reason: 'Synthetic committee approval.',
    votedAt: new Date(),
    signature: null,
    signedPayloadHash: null,
    reasonCommitment: null,
    nonce: null,
    deadline: null,
    committeeEpoch: null
  }));
  const committeeVote = await measureStage(context.stages, 'committee_approval', () => createDisbursementCommitteeVote({
    requestId,
    status: 'APPROVED',
    committeeSnapshot: snapshot,
    requiredMemberVotes: 2,
    openedAt: new Date(),
    deadlineAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  }));
  await DisbursementCommitteeVoteMongoModel.updateOne(
    { committeeVoteId: committeeVote.committeeVoteId },
    {
      $set: {
        votes,
        executionStatus: 'COMPLETED',
        resolvedAt: new Date(),
        onChainDecisionStatus: 'RECORDED',
        onChainDecisionTxHash: `0x${crypto.createHash('sha256').update(`${runId}:committee`).digest('hex')}`
      }
    }
  ).exec();

  await measureStage(context.stages, 'disbursement_completed', async () => {
    const updatedDisbursement = await updateDisbursementByRequestId(requestId, {
      status: 'COMPLETED',
      payosTransferId: `synthetic-transfer-${runId}`,
      payosTransferStatus: 'SUCCESS',
      payosTransferAttemptCount: 1,
      transactionHash: `0x${crypto.createHash('sha256').update(`${runId}:burn`).digest('hex')}`,
      finalizeTransactionHash: `0x${crypto.createHash('sha256').update(`${runId}:finalize`).digest('hex')}`,
      completedAt: new Date()
    });
    if (!updatedDisbursement) throw new Error('Không thể chuyển disbursement synthetic sang COMPLETED.');
  });

  const result: SyntheticFullLoadFinalizeResult = {
    synthetic: true,
    runId: context.runId,
    projectId: context.projectId,
    donationRequestCount: donationCount,
    donationAmountPerRequest: context.donationAmountPerRequest,
    donationTotalAmount: donationSummary.totalAmount,
    disbursementAmount: context.disbursementAmount,
    totalDurationMs: Date.now() - context.startedAt,
    stages: context.stages,
    records: {
      organizationId: context.organizationUser.id,
      kycSubmissionId: context.kycSubmissionId,
      bankSubmissionId: context.bankSubmissionId,
      projectId: context.projectId,
      disbursementRequestId: requestId,
      committeeVoteId: committeeVote.committeeVoteId
    },
    finalStatus: {
      kyc: 'APPROVED',
      bankAccount: 'APPROVED',
      project: 'ACTIVE',
      donation: 'INDEXED',
      disbursement: 'COMPLETED',
      payosTransfer: 'SUCCESS'
    }
  };
  activeRuns.delete(context.runId);
  return result;
}
