import { ethers } from 'ethers';

export type CommitteeDecisionRelayerSignature = {
  signer: string;
  nonce: string;
  deadline: string;
  signature: string;
};

export type CommitteeDecisionSignatureSelection =
  | { status: 'READY'; signatures: CommitteeDecisionRelayerSignature[]; committeeEpoch: string }
  | { status: 'WAITING_SIGNATURES' }
  | { status: 'NEEDS_RESIGN' };

type CommitteeDecisionSnapshotMember = {
  userId: string;
  role: string;
  walletAddress: string;
  governanceWalletAddress?: string | null;
};

type CommitteeDecisionVoteSignature = {
  voterUserId: string;
  decision: string;
  signature?: string | null;
  nonce?: string | null;
  deadline?: Date | null;
  committeeEpoch?: string | null;
};

/** Chọn bộ Chair và hai Member hợp lệ để relay, đồng thời phân biệt thiếu chữ ký với chữ ký cần làm mới. */
export function selectCommitteeDecisionThresholdSignatures(
  snapshot: CommitteeDecisionSnapshotMember[],
  votes: CommitteeDecisionVoteSignature[],
  winningDecision: string
): CommitteeDecisionSignatureSelection {
  const now = new Date();
  const winningVotes = votes.filter(vote => vote.decision === winningDecision && vote.signature && vote.nonce && vote.deadline);
  const hasExpiredSignature = winningVotes.some(vote => (vote.deadline as Date) <= now);
  const voteByUserId = new Map(votes
    .filter(vote => vote.decision === winningDecision && vote.signature && vote.nonce && vote.deadline && vote.deadline > now)
    .map(vote => [vote.voterUserId, vote]));
  const selected = snapshot.flatMap(member => {
    const vote = voteByUserId.get(member.userId);
    const signer = member.governanceWalletAddress || member.walletAddress;
    if (!vote || !vote.signature || !vote.nonce || !vote.deadline || !ethers.isAddress(signer)) return [];
    return [{
      role: member.role,
      signer: ethers.getAddress(signer),
      nonce: vote.nonce,
      deadline: Math.floor(vote.deadline.getTime() / 1000).toString(),
      signature: vote.signature,
      committeeEpoch: vote.committeeEpoch
    }];
  });
  const chair = selected.find(item => item.role === 'executive_chair');
  const members = selected.filter(item => item.role === 'executive_member');
  if (!chair || members.length < 2) return hasExpiredSignature ? { status: 'NEEDS_RESIGN' } : { status: 'WAITING_SIGNATURES' };
  const selectedVotes = [chair, ...members];
  const committeeEpochs = new Set(selectedVotes.map(item => item.committeeEpoch).filter(Boolean));
  if (committeeEpochs.size !== 1) return { status: 'NEEDS_RESIGN' };
  return {
    status: 'READY',
    committeeEpoch: [...committeeEpochs][0] as string,
    signatures: selectedVotes.map(({ signer, nonce, deadline, signature }) => ({ signer, nonce, deadline, signature }))
  };
}
