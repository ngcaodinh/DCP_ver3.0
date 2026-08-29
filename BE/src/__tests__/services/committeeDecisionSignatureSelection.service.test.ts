import { describe, expect, it } from 'vitest';
import { selectCommitteeDecisionThresholdSignatures } from '../../services/committeeDecisionSignatureSelection.service';

const FUTURE_DEADLINE = new Date('2030-01-01T00:00:00.000Z');
const EXPIRED_DEADLINE = new Date('2020-01-01T00:00:00.000Z');
type SnapshotOverrides = {
  chairWallet?: string;
  chairGovernanceWallet?: string;
  memberTwoWallet?: string;
};
type VoteOverrides = {
  chairDeadline?: Date;
  memberOneEpoch?: string;
  memberTwoEpoch?: string;
};

/** Tạo snapshot tối thiểu gồm Chair và hai Member để kiểm tra quy tắc ngưỡng relay. */
function createSnapshot(overrides: SnapshotOverrides = {}) {
  return [
    {
      userId: 'chair',
      role: 'executive_chair',
      walletAddress: overrides.chairWallet || '0x1111111111111111111111111111111111111111',
      governanceWalletAddress: overrides.chairGovernanceWallet || '0x4444444444444444444444444444444444444444'
    },
    { userId: 'member-1', role: 'executive_member', walletAddress: '0x2222222222222222222222222222222222222222' },
    { userId: 'member-2', role: 'executive_member', walletAddress: overrides.memberTwoWallet || '0x3333333333333333333333333333333333333333' }
  ];
}

/** Tạo ba chữ ký cùng phía để từng test chỉ thay đổi đúng điều kiện cần kiểm tra. */
function createVotes(overrides: VoteOverrides = {}) {
  return [
    { voterUserId: 'chair', decision: 'APPROVE', signature: '0xchair', nonce: '1', deadline: overrides.chairDeadline ?? FUTURE_DEADLINE, committeeEpoch: '7' },
    { voterUserId: 'member-1', decision: 'APPROVE', signature: '0xmember-1', nonce: '2', deadline: FUTURE_DEADLINE, committeeEpoch: overrides.memberOneEpoch ?? '7' },
    { voterUserId: 'member-2', decision: 'APPROVE', signature: '0xmember-2', nonce: '3', deadline: FUTURE_DEADLINE, committeeEpoch: overrides.memberTwoEpoch ?? '7' }
  ];
}

describe('selectCommitteeDecisionThresholdSignatures', () => {
  it('trả READY với Chair và hai Member hợp lệ, ưu tiên governance wallet của Chair', () => {
    expect(selectCommitteeDecisionThresholdSignatures(createSnapshot(), createVotes(), 'APPROVE')).toEqual({
      status: 'READY',
      committeeEpoch: '7',
      signatures: [
        { signer: '0x4444444444444444444444444444444444444444', nonce: '1', deadline: '1893456000', signature: '0xchair' },
        { signer: '0x2222222222222222222222222222222222222222', nonce: '2', deadline: '1893456000', signature: '0xmember-1' },
        { signer: '0x3333333333333333333333333333333333333333', nonce: '3', deadline: '1893456000', signature: '0xmember-2' }
      ]
    });
  });

  it('trả WAITING_SIGNATURES khi thiếu một Member dù các chữ ký hiện có còn hạn', () => {
    expect(selectCommitteeDecisionThresholdSignatures(createSnapshot(), createVotes().slice(0, 2), 'APPROVE'))
      .toEqual({ status: 'WAITING_SIGNATURES' });
  });

  it('trả NEEDS_RESIGN khi thiếu ngưỡng vì chữ ký cùng phía đã hết hạn', () => {
    expect(selectCommitteeDecisionThresholdSignatures(
      createSnapshot(),
      createVotes({ chairDeadline: EXPIRED_DEADLINE }).slice(0, 2),
      'APPROVE'
    )).toEqual({ status: 'NEEDS_RESIGN' });
  });

  it('trả NEEDS_RESIGN khi các chữ ký đạt ngưỡng thuộc nhiều committee epoch', () => {
    expect(selectCommitteeDecisionThresholdSignatures(
      createSnapshot(),
      createVotes({ memberTwoEpoch: '8' }),
      'APPROVE'
    )).toEqual({ status: 'NEEDS_RESIGN' });
  });

  it('không chọn signer có địa chỉ ví không hợp lệ dù vote chứa đủ dữ liệu EIP-712', () => {
    expect(selectCommitteeDecisionThresholdSignatures(
      createSnapshot({ memberTwoWallet: 'not-an-address' }),
      createVotes(),
      'APPROVE'
    )).toEqual({ status: 'WAITING_SIGNATURES' });
  });
});
