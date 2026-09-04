import crypto from 'crypto';
import {
  AuthUserModel,
  type AuthUser
} from '../models/authModel';
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
  upsertDonationByTransactionHash
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

const DEFAULT_DONATION_AMOUNT = 20_000;
const DEFAULT_DISBURSEMENT_AMOUNT = 10_000;
const SYNTHETIC_BLOCK_NUMBER = 1;

export type SyntheticE2eStage = {
  name: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
};

export type SyntheticE2eInput = {
  donationAmount?: number;
  disbursementAmount?: number;
};

export type SyntheticE2eResult = {
  synthetic: true;
  runId: string;
  donationAmount: number;
  disbursementAmount: number;
  totalDurationMs: number;
  stages: SyntheticE2eStage[];
  records: {
    organizationId: string;
    kycSubmissionId: string;
    bankSubmissionId: string;
    projectId: string;
    donationTransactionHash: string;
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

/** Tạo mã định danh ổn định cho bản ghi synthetic mà không dùng khóa hoặc giao dịch thật. */
export function createSyntheticAddress(runId: string, role: string): string {
  return `0x${crypto.createHash('sha256').update(`${runId}:${role}`).digest('hex').slice(0, 40)}`;
}

/** Đo một bước tuần tự trong luồng E2E để báo cáo được thời gian từng chặng. */
async function measureStage<T>(
  stages: SyntheticE2eStage[],
  name: string,
  operation: () => Promise<T>
): Promise<T> {
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

/** Tạo user synthetic tối thiểu để mô phỏng các vai trò tham gia vào một hồ sơ E2E. */
export function buildSyntheticUser(runId: string, role: string, index: number, overrides: Partial<AuthUser> = {}): AuthUser {
  const userId = `synthetic-${role}-${runId}-${index}`;
  const walletAddress = createSyntheticAddress(runId, `${role}:${index}`);
  return {
    id: userId,
    email: `${userId}@synthetic.dcp.local`,
    fullName: `Synthetic ${role} ${index}`,
    role,
    walletAddress,
    governanceWalletAddress: role.startsWith('executive_') ? walletAddress : null,
    governanceSeatSlot: role === 'executive_chair' ? 1 : role === 'executive_member' ? index : null,
    isRootAdminWallet: false,
    smartAccountOwnerAddress: null,
    smartAccountOwnerEncryptedPrivateKey: null,
    socialProvider: 'synthetic',
    socialAccountId: userId,
    isEmailVerified: true,
    accountStatus: 'ACTIVE',
    suspendedReasonCode: null,
    organizationName: role === 'organizations' ? `Synthetic Organization ${runId}` : null,
    legalRegistrationNumber: role === 'organizations' ? `SYN-${runId}` : null,
    isSybil: false,
    lastLoginAt: null,
    lastLoginIp: null,
    lastLoginUserAgent: null,
    correlationId: crypto.randomUUID(),
    fcmDeviceToken: null,
    phoneNumber: null,
    authVersion: 1,
    ...overrides
  };
}

/** Tạo và ghi các user synthetic dùng chung cho toàn bộ vòng đời KYC đến giải ngân. */
export async function createSyntheticUsers(runId: string): Promise<{
  organizationUser: AuthUser;
  donorUser: AuthUser;
  regulatoryUser: AuthUser;
  committeeUsers: AuthUser[];
}> {
  const organizationUser = buildSyntheticUser(runId, 'donor', 1, {
    accountStatus: 'INACTIVE_PENDING_KYC',
    organizationName: null,
    legalRegistrationNumber: null
  });
  const donorUser = buildSyntheticUser(runId, 'donors', 1);
  const regulatoryUser = buildSyntheticUser(runId, 'regulatory', 1);
  const committeeUsers = [
    buildSyntheticUser(runId, 'executive_chair', 1, { governanceWalletAddress: null, governanceSeatSlot: null }),
    buildSyntheticUser(runId, 'executive_member', 2, { governanceWalletAddress: null, governanceSeatSlot: null }),
    buildSyntheticUser(runId, 'executive_member', 3, { governanceWalletAddress: null, governanceSeatSlot: null }),
    buildSyntheticUser(runId, 'executive_member', 4, { governanceWalletAddress: null, governanceSeatSlot: null }),
    buildSyntheticUser(runId, 'executive_member', 5, { governanceWalletAddress: null, governanceSeatSlot: null })
  ];
  await AuthUserModel.insertMany([organizationUser, donorUser, regulatoryUser, ...committeeUsers], { ordered: true });
  return { organizationUser, donorUser, regulatoryUser, committeeUsers };
}

/** Chạy toàn bộ vòng đời synthetic KYC → donation 20.000 → committee → PayOS SUCCESS. */
export async function runSyntheticKycToDisbursement(input: SyntheticE2eInput = {}): Promise<SyntheticE2eResult> {
  const donationAmount = input.donationAmount ?? DEFAULT_DONATION_AMOUNT;
  const disbursementAmount = input.disbursementAmount ?? DEFAULT_DISBURSEMENT_AMOUNT;
  if (!Number.isInteger(donationAmount) || donationAmount <= 0) throw new Error('donationAmount phải là số nguyên dương.');
  if (!Number.isInteger(disbursementAmount) || disbursementAmount <= 0 || disbursementAmount > donationAmount) {
    throw new Error('disbursementAmount phải là số nguyên dương và không vượt donationAmount.');
  }

  const runId = crypto.randomUUID();
  const stages: SyntheticE2eStage[] = [];
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
    organizationDescription: 'Synthetic KYC-to-disbursement performance test.',
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
    const reviewedFile: OrganizationKycFile = {
      ...kycFile,
      reviewStatus: 'APPROVED',
      reviewedBy: users.regulatoryUser.id,
      reviewedAt
    };
    const updatedSubmission = await updateOrganizationKycSubmissionReview(kycSubmissionId, {
      status: 'APPROVED',
      reviewedBy: users.regulatoryUser.id,
      reviewedAt,
      rejectionReason: null,
      files: [reviewedFile]
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

  const projectId = `SYNTHETIC-PROJECT-${runId}`;
  await measureStage(stages, 'project_creation', () => createProjectRecord({
    projectId,
    organizationId: users.organizationUser.id,
    name: `Synthetic E2E Project ${runId}`,
    description: 'Synthetic project for KYC-to-disbursement performance measurement.',
    goalAmount: donationAmount,
    deadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    status: 'PENDING_APPROVAL',
    evidenceCids: [`bafy-synthetic-${runId}-evidence`],
    evidenceFiles: [],
    submittedAt: new Date(),
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: null,
    milestonePlan: [
      { milestoneIndex: 1, milestoneKey: 'M1_ADVANCE', percentage: 100, description: 'Synthetic milestone.' }
    ],
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

  const activeProject = await measureStage(stages, 'project_activation', async () => {
    const updatedProject = await updateProjectByProjectId(projectId, {
      status: 'ACTIVE',
      listedAt: new Date(),
      activationEligibleAt: new Date(),
      activationState: 'SYNCED',
      activationAttemptCount: 1,
      activationLastAttemptAt: new Date()
    });
    if (!updatedProject) throw new Error('Không thể kích hoạt project synthetic.');
    return updatedProject;
  });

  const donationTransactionHash = `0x${crypto.createHash('sha256').update(`${runId}:donation`).digest('hex')}`;
  const donation = await measureStage(stages, 'donation_indexed', () => upsertDonationByTransactionHash({
    transactionHash: donationTransactionHash,
    projectId,
    donorAddress: users.donorUser.walletAddress,
    amount: donationAmount,
    timestamp: new Date(),
    isAnonymous: false,
    blockNumber: SYNTHETIC_BLOCK_NUMBER,
    donationStatus: 'INDEXED',
    onChainConfirmedAt: new Date(),
    indexedAt: new Date(),
    correlationId: crypto.randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date()
  }));

  const requestId = crypto.randomUUID();
  await measureStage(stages, 'disbursement_requested', () => createDisbursementRecord({
    requestId,
    onChainRequestId: Number.parseInt(runId.replaceAll('-', '').slice(0, 8), 16),
    projectId,
    onChainProjectId: 1,
    organizationId: users.organizationUser.id,
    requestMode: 'NORMAL',
    emergencyReason: null,
    requiredApprovals: 3,
    raisedRatioBpsAtCreation: 10000,
    beneficiaryWalletAddress: users.organizationUser.walletAddress,
    beneficiaryBankAccount: bankAccount,
    amount: disbursementAmount,
    usagePurpose: 'Synthetic E2E performance test.',
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
    transferIdempotencyKey: `synthetic-${runId}`,
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

  const snapshot: DisbursementCommitteeSnapshotMember[] = [users.committeeUsers[0], ...users.committeeUsers.slice(1)].map(user => ({
    userId: user.id,
    role: user.role as 'executive_chair' | 'executive_member',
    fullName: user.fullName,
    walletAddress: user.walletAddress,
    governanceWalletAddress: user.governanceWalletAddress || null
  }));
  const votes: DisbursementCommitteeVote[] = users.committeeUsers.slice(0, 3).map(user => ({
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
  const committeeVote = await measureStage(stages, 'committee_approval', () => createDisbursementCommitteeVote({
    requestId,
    status: 'APPROVED',
    committeeSnapshot: snapshot,
    requiredMemberVotes: 2,
    openedAt: new Date(),
    deadlineAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  }));
  await DisbursementCommitteeVoteMongoModel.updateOne(
    { committeeVoteId: committeeVote.committeeVoteId },
    { $set: { votes, executionStatus: 'COMPLETED', resolvedAt: new Date(), onChainDecisionStatus: 'RECORDED', onChainDecisionTxHash: `0x${crypto.createHash('sha256').update(`${runId}:committee`).digest('hex')}` } }
  ).exec();

  const completedDisbursement = await measureStage(stages, 'disbursement_completed', async () => {
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
    return updatedDisbursement;
  });

  const totalDurationMs = Date.now() - startedAt;
  return {
    synthetic: true,
    runId,
    donationAmount,
    disbursementAmount,
    totalDurationMs,
    stages,
    records: {
      organizationId: users.organizationUser.id,
      kycSubmissionId,
      bankSubmissionId,
      projectId: activeProject.projectId,
      donationTransactionHash: donation.transactionHash,
      disbursementRequestId: completedDisbursement.requestId,
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
}
