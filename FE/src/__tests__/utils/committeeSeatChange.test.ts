import { describe, expect, it } from 'vitest';
import { parseCommitteeSeatChangeDraft } from '@/app/utils/committeeSeatChange';

const baseDraft = {
  oldSeat: '0x1111111111111111111111111111111111111111',
  newSeat: '0x2222222222222222222222222222222222222222',
  role: 1,
  committeeEpoch: '3',
  deadline: '4000000000',
  chainId: '80002',
  signatures: [{ signer: '0x3333333333333333333333333333333333333333', nonce: '7', deadline: '4000000000', signature: '0xabcdef' }]
};

describe('committeeSeatChange draft parser', () => {
  it('normalizes a valid cross-wallet EIP-712 draft before signing or relaying', () => {
    const draft = parseCommitteeSeatChangeDraft(JSON.stringify(baseDraft));
    expect(draft.oldSeat).toBe(baseDraft.oldSeat);
    expect(draft.signatures).toHaveLength(1);
  });

  it('rejects tampered drafts with a duplicate signer or a signature deadline different from the typed payload', () => {
    const duplicateSigner = { ...baseDraft, signatures: [...baseDraft.signatures, { ...baseDraft.signatures[0], nonce: '8' }] };
    const deadlineMismatch = { ...baseDraft, signatures: [{ ...baseDraft.signatures[0], deadline: '4000000001' }] };

    expect(() => parseCommitteeSeatChangeDraft(JSON.stringify(duplicateSigner))).toThrow('trùng người ký');
    expect(() => parseCommitteeSeatChangeDraft(JSON.stringify(deadlineMismatch))).toThrow('Chữ ký trong draft không hợp lệ');
  });

  it('rejects an expired draft before requesting a wallet signature', () => {
    const expired = { ...baseDraft, deadline: '1', signatures: [] };
    expect(() => parseCommitteeSeatChangeDraft(JSON.stringify(expired))).toThrow('đã hết hạn');
  });
});
