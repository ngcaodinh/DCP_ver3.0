import { expect } from 'chai';
import { network } from 'hardhat';

const SEAT_ROLE = { None: 0, Chair: 1, Member: 2 };
const KIND = { Disbursement: 0, Arbitration: 1 };
const FAR_DEADLINE = 4000000000n;
const SUBJECT_A = '0x1111111111111111111111111111111111111111111111111111111111111111';
const SUBJECT_B = '0x3333333333333333333333333333333333333333333333333333333333333333';
const REASON = '0x2222222222222222222222222222222222222222222222222222222222222222';

/** Dựng contract với một Chủ tịch và bốn Ủy viên đã bootstrap sẵn. */
async function deployFixture() {
  const { ethers } = await network.create();
  const [admin, chair, m1, m2, m3, m4, relayer] = await ethers.getSigners();
  const factory = await ethers.getContractFactory('CommitteeGovernance');
  const gov = await factory.deploy(admin.address);
  await gov.waitForDeployment();
  await gov.connect(admin).bootstrapSeats(
    [chair.address, m1.address, m2.address, m3.address, m4.address],
    [SEAT_ROLE.Chair, SEAT_ROLE.Member, SEAT_ROLE.Member, SEAT_ROLE.Member, SEAT_ROLE.Member]
  );
  return { ethers, gov, admin, chair, m1, m2, m3, m4, relayer };
}

/** Tạo domain EIP-712 khớp với contract đã deploy. */
async function domainOf(gov, ethers) {
  return {
    name: 'CommitteeGovernance',
    version: '1',
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await gov.getAddress()
  };
}

/** Ký một phiếu quyết định theo đúng struct Vote của contract. */
async function signVote(gov, ethers, signer, input) {
  const types = {
    Vote: [
      { name: 'kind', type: 'uint8' },
      { name: 'subjectId', type: 'bytes32' },
      { name: 'approved', type: 'bool' },
      { name: 'reasonHash', type: 'bytes32' },
      { name: 'committeeEpoch', type: 'uint64' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }
    ]
  };
  const value = {
    kind: input.kind,
    subjectId: input.subjectId,
    approved: input.approved,
    reasonHash: input.reasonHash,
    committeeEpoch: input.epoch,
    nonce: input.nonce,
    deadline: FAR_DEADLINE
  };
  const signature = await signer.signTypedData(await domainOf(gov, ethers), types, value);
  return { signer: signer.address, nonce: input.nonce, deadline: FAR_DEADLINE, signature };
}

/** Ký một đề xuất thay ghế theo đúng struct SeatChange của contract. */
async function signSeatChange(gov, ethers, signer, input) {
  const types = {
    SeatChange: [
      { name: 'oldSeat', type: 'address' },
      { name: 'newSeat', type: 'address' },
      { name: 'role', type: 'uint8' },
      { name: 'committeeEpoch', type: 'uint64' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }
    ]
  };
  const value = {
    oldSeat: input.oldSeat,
    newSeat: input.newSeat,
    role: input.role,
    committeeEpoch: input.epoch,
    nonce: input.nonce,
    deadline: FAR_DEADLINE
  };
  const signature = await signer.signTypedData(await domainOf(gov, ethers), types, value);
  return { signer: signer.address, nonce: input.nonce, deadline: FAR_DEADLINE, signature };
}

/** Ký thao tác pause theo đúng struct EmergencyPause của contract. */
async function signPause(gov, ethers, signer, input) {
  const types = {
    EmergencyPause: [
      { name: 'shouldPause', type: 'bool' },
      { name: 'pauseContext', type: 'uint40' },
      { name: 'committeeEpoch', type: 'uint64' },
      { name: 'pauseSequence', type: 'uint64' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }
    ]
  };
  const value = {
    shouldPause: input.shouldPause,
    pauseContext: input.pauseContext,
    committeeEpoch: input.epoch,
    pauseSequence: input.sequence,
    nonce: input.nonce,
    deadline: FAR_DEADLINE
  };
  const signature = await signer.signTypedData(await domainOf(gov, ethers), types, value);
  return { signer: signer.address, nonce: input.nonce, deadline: FAR_DEADLINE, signature };
}

describe('CommitteeGovernance — kiểm chứng các đường code mới', () => {
  it('N2a: bốn Ủy viên thay được Chủ tịch khi Chủ tịch mất khóa', async () => {
    const { ethers, gov, chair, m1, m2, m3, m4, relayer } = await deployFixture();
    const newChair = ethers.Wallet.createRandom().address;
    const base = { oldSeat: chair.address, newSeat: newChair, role: SEAT_ROLE.Chair, epoch: 1n };
    const signatures = [];
    const members = [m1, m2, m3, m4];
    for (let i = 0; i < members.length; i += 1) {
      signatures.push(await signSeatChange(gov, ethers, members[i], { ...base, nonce: BigInt(i) }));
    }
    await expect(
      gov.connect(relayer).proposeSeatChange(chair.address, newChair, SEAT_ROLE.Chair, signatures)
    ).to.emit(gov, 'SeatChangeProposed');
  });

  it('N2b: ba Ủy viên không thể thay Chủ tịch khi thiếu chữ ký Chair', async () => {
    const { ethers, gov, chair, m1, m2, m3, relayer } = await deployFixture();
    const newChair = ethers.Wallet.createRandom().address;
    const base = { oldSeat: chair.address, newSeat: newChair, role: SEAT_ROLE.Chair, epoch: 1n };
    const signatures = [];
    const members = [m1, m2, m3];
    for (let i = 0; i < members.length; i += 1) {
      signatures.push(await signSeatChange(gov, ethers, members[i], { ...base, nonce: BigInt(i) }));
    }
    await expect(
      gov.connect(relayer).proposeSeatChange(chair.address, newChair, SEAT_ROLE.Chair, signatures)
    ).to.be.revertedWithCustomError(gov, 'InsufficientChairRecoveryApprovals');
  });

  it('N1: pause tự hết hiệu lực sau 14 ngày, không cần giao dịch mở lại', async () => {
    const { ethers, gov, m1, m2, m3, relayer } = await deployFixture();
    const base = { shouldPause: true, pauseContext: 0, epoch: 1n, sequence: 0n };
    const signatures = [];
    const members = [m1, m2, m3];
    for (let i = 0; i < members.length; i += 1) {
      signatures.push(await signPause(gov, ethers, members[i], { ...base, nonce: BigInt(i) }));
    }
    await gov.connect(relayer).setPaused(true, signatures);
    expect(await gov.paused()).to.equal(true);
    await ethers.provider.send('evm_increaseTime', [14 * 24 * 60 * 60 + 1]);
    await ethers.provider.send('evm_mine', []);
    expect(await gov.paused()).to.equal(false);
  });

  it('H3: một ghế ký song song nhiều hồ sơ, thứ tự lên chuỗi bất kỳ', async () => {
    const { ethers, gov, chair, m1, m2, relayer } = await deployFixture();
    const signers = [chair, m1, m2];
    const buildSignatures = async (subjectId, nonceBase) => {
      const list = [];
      for (let i = 0; i < signers.length; i += 1) {
        list.push(await signVote(gov, ethers, signers[i], {
          kind: KIND.Disbursement,
          subjectId,
          approved: true,
          reasonHash: REASON,
          epoch: 1n,
          nonce: BigInt(nonceBase + i * 10)
        }));
      }
      return list;
    };
    const signaturesA = await buildSignatures(SUBJECT_A, 0);
    const signaturesB = await buildSignatures(SUBJECT_B, 1);
    // Nộp hồ sơ B trước hồ sơ A: nonce không tuần tự nên cả hai vẫn hợp lệ.
    await expect(
      gov.connect(relayer).recordDecision(KIND.Disbursement, SUBJECT_B, true, REASON, signaturesB)
    ).to.emit(gov, 'DecisionRecorded');
    await expect(
      gov.connect(relayer).recordDecision(KIND.Disbursement, SUBJECT_A, true, REASON, signaturesA)
    ).to.emit(gov, 'DecisionRecorded');
  });

  it('Chặn một người ký ba lần để giả đủ 3/5', async () => {
    const { ethers, gov, chair, relayer } = await deployFixture();
    const signatures = [];
    for (let i = 0; i < 3; i += 1) {
      signatures.push(await signVote(gov, ethers, chair, {
        kind: KIND.Disbursement,
        subjectId: SUBJECT_A,
        approved: true,
        reasonHash: REASON,
        epoch: 1n,
        nonce: BigInt(i)
      }));
    }
    await expect(
      gov.connect(relayer).recordDecision(KIND.Disbursement, SUBJECT_A, true, REASON, signatures)
    ).to.be.revertedWithCustomError(gov, 'DuplicateSigner');
  });

  it('Đủ bốn Ủy viên nhưng thiếu Chủ tịch thì quyết định không được ghi', async () => {
    const { ethers, gov, m1, m2, m3, m4, relayer } = await deployFixture();
    const signatures = [];
    const members = [m1, m2, m3, m4];
    for (let i = 0; i < members.length; i += 1) {
      signatures.push(await signVote(gov, ethers, members[i], {
        kind: KIND.Disbursement,
        subjectId: SUBJECT_A,
        approved: true,
        reasonHash: REASON,
        epoch: 1n,
        nonce: BigInt(i)
      }));
    }
    await expect(
      gov.connect(relayer).recordDecision(KIND.Disbursement, SUBJECT_A, true, REASON, signatures)
    ).to.be.revertedWithCustomError(gov, 'ChairSignatureMissing');
  });

  it('Pause chặn recordDecision nhưng hết hạn thì chạy lại được', async () => {
    const { ethers, gov, chair, m1, m2, m3, relayer } = await deployFixture();
    const pauseBase = { shouldPause: true, pauseContext: 0, epoch: 1n, sequence: 0n };
    const pauseSignatures = [];
    const pausers = [m1, m2, m3];
    for (let i = 0; i < pausers.length; i += 1) {
      pauseSignatures.push(await signPause(gov, ethers, pausers[i], { ...pauseBase, nonce: BigInt(i) }));
    }
    await gov.connect(relayer).setPaused(true, pauseSignatures);

    const voteSigners = [chair, m1, m2];
    const voteSignatures = [];
    for (let i = 0; i < voteSigners.length; i += 1) {
      voteSignatures.push(await signVote(gov, ethers, voteSigners[i], {
        kind: KIND.Disbursement,
        subjectId: SUBJECT_A,
        approved: true,
        reasonHash: REASON,
        epoch: 1n,
        nonce: BigInt(100 + i)
      }));
    }
    await expect(
      gov.connect(relayer).recordDecision(KIND.Disbursement, SUBJECT_A, true, REASON, voteSignatures)
    ).to.be.revertedWithCustomError(gov, 'GovernancePaused');

    await ethers.provider.send('evm_increaseTime', [14 * 24 * 60 * 60 + 1]);
    await ethers.provider.send('evm_mine', []);
    await expect(
      gov.connect(relayer).recordDecision(KIND.Disbursement, SUBJECT_A, true, REASON, voteSignatures)
    ).to.emit(gov, 'DecisionRecorded');
  });
});
