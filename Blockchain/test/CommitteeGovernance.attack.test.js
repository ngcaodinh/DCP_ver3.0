import { expect } from 'chai';
import { network } from 'hardhat';

const SEAT_ROLE = { None: 0, Chair: 1, Member: 2 };
const KIND = { Disbursement: 0, Arbitration: 1 };
const FAR_DEADLINE = 4000000000n;
const SUBJECT_A = '0x1111111111111111111111111111111111111111111111111111111111111111';
const REASON = '0x2222222222222222222222222222222222222222222222222222222222222222';
const THREE_DAYS = 3 * 24 * 60 * 60;
const SEVEN_DAYS = 7 * 24 * 60 * 60;

/** Dựng contract chưa bootstrap để kiểm tra riêng cửa khởi tạo. */
async function deployRawFixture() {
  const { ethers } = await network.create();
  const [admin, chair, m1, m2, m3, m4, outsider] = await ethers.getSigners();
  const factory = await ethers.getContractFactory('CommitteeGovernance');
  const gov = await factory.deploy(admin.address);
  await gov.waitForDeployment();
  return { ethers, gov, admin, chair, m1, m2, m3, m4, outsider };
}

/** Dựng contract đã bootstrap đủ năm ghế. */
async function deployFixture() {
  const context = await deployRawFixture();
  const { gov, admin, chair, m1, m2, m3, m4 } = context;
  await gov.connect(admin).bootstrapSeats(
    [chair.address, m1.address, m2.address, m3.address, m4.address],
    [SEAT_ROLE.Chair, SEAT_ROLE.Member, SEAT_ROLE.Member, SEAT_ROLE.Member, SEAT_ROLE.Member]
  );
  return context;
}

/** Tạo domain EIP-712; cho phép ép chainId sai để thử tấn công dùng chữ ký chéo mạng. */
async function domainOf(gov, ethers, chainIdOverride) {
  const chainId = chainIdOverride ?? (await ethers.provider.getNetwork()).chainId;
  return {
    name: 'CommitteeGovernance',
    version: '1',
    chainId,
    verifyingContract: await gov.getAddress()
  };
}

const VOTE_TYPES = {
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

const SEAT_CHANGE_TYPES = {
  SeatChange: [
    { name: 'oldSeat', type: 'address' },
    { name: 'newSeat', type: 'address' },
    { name: 'role', type: 'uint8' },
    { name: 'committeeEpoch', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
};

/** Ký một phiếu quyết định, cho phép ép sai chainId hoặc deadline để thử tấn công. */
async function signVote(gov, ethers, signer, input) {
  const value = {
    kind: input.kind ?? KIND.Disbursement,
    subjectId: input.subjectId ?? SUBJECT_A,
    approved: input.approved ?? true,
    reasonHash: input.reasonHash ?? REASON,
    committeeEpoch: input.epoch ?? 1n,
    nonce: input.nonce,
    deadline: input.deadline ?? FAR_DEADLINE
  };
  const domain = await domainOf(gov, ethers, input.chainIdOverride);
  const signature = await signer.signTypedData(domain, VOTE_TYPES, value);
  return { signer: signer.address, nonce: value.nonce, deadline: value.deadline, signature };
}

/** Ký một đề xuất thay ghế. */
async function signSeatChange(gov, ethers, signer, input) {
  const value = {
    oldSeat: input.oldSeat,
    newSeat: input.newSeat,
    role: input.role,
    committeeEpoch: input.epoch,
    nonce: input.nonce,
    deadline: FAR_DEADLINE
  };
  const domain = await domainOf(gov, ethers);
  const signature = await signer.signTypedData(domain, SEAT_CHANGE_TYPES, value);
  return { signer: signer.address, nonce: input.nonce, deadline: FAR_DEADLINE, signature };
}

/** Gom ba chữ ký hợp lệ gồm Chủ tịch và hai Ủy viên. */
async function quorumVotes(gov, ethers, signers, overrides = {}) {
  const list = [];
  for (let i = 0; i < signers.length; i += 1) {
    list.push(await signVote(gov, ethers, signers[i], { nonce: BigInt(i), ...overrides }));
  }
  return list;
}

describe('CommitteeGovernance — tấn công thử', () => {
  it('Chữ ký giả mạo bị từ chối', async () => {
    const { ethers, gov, chair, m1, m2, outsider, relayer } = await deployFixture();
    const signatures = await quorumVotes(gov, ethers, [chair, m1, m2]);
    // Người ngoài ký nhưng khai là địa chỉ của Ủy viên đang giữ ghế.
    const forged = await signVote(gov, ethers, outsider, { nonce: 99n });
    signatures[2] = { ...forged, signer: m2.address };
    await expect(
      gov.connect(outsider).recordDecision(KIND.Disbursement, SUBJECT_A, true, REASON, signatures)
    ).to.be.revertedWithCustomError(gov, 'InvalidSignature');
  });

  it('Chữ ký từ chainId khác bị từ chối', async () => {
    const { ethers, gov, chair, m1, m2, outsider } = await deployFixture();
    const signatures = await quorumVotes(gov, ethers, [chair, m1, m2], { chainIdOverride: 999999n });
    await expect(
      gov.connect(outsider).recordDecision(KIND.Disbursement, SUBJECT_A, true, REASON, signatures)
    ).to.be.revertedWithCustomError(gov, 'InvalidSignature');
  });

  it('Chữ ký quá deadline bị từ chối', async () => {
    const { ethers, gov, chair, m1, m2, outsider } = await deployFixture();
    const latest = await ethers.provider.getBlock('latest');
    const pastDeadline = BigInt(latest.timestamp - 1);
    const signatures = await quorumVotes(gov, ethers, [chair, m1, m2], { deadline: pastDeadline });
    await expect(
      gov.connect(outsider).recordDecision(KIND.Disbursement, SUBJECT_A, true, REASON, signatures)
    ).to.be.revertedWithCustomError(gov, 'SignatureExpired');
  });

  it('Đổi approved sau khi ký thì chữ ký mất hiệu lực', async () => {
    const { ethers, gov, chair, m1, m2, outsider } = await deployFixture();
    const signatures = await quorumVotes(gov, ethers, [chair, m1, m2], { approved: true });
    await expect(
      gov.connect(outsider).recordDecision(KIND.Disbursement, SUBJECT_A, false, REASON, signatures)
    ).to.be.revertedWithCustomError(gov, 'InvalidSignature');
  });

  it('Ghi cùng một subject lần hai bị từ chối', async () => {
    const { ethers, gov, chair, m1, m2, outsider } = await deployFixture();
    const first = await quorumVotes(gov, ethers, [chair, m1, m2]);
    await gov.connect(outsider).recordDecision(KIND.Disbursement, SUBJECT_A, true, REASON, first);
    const shifted = [];
    for (let i = 0; i < 3; i += 1) {
      shifted.push(await signVote(gov, ethers, [chair, m1, m2][i], { nonce: BigInt(50 + i) }));
    }
    await expect(
      gov.connect(outsider).recordDecision(KIND.Disbursement, SUBJECT_A, true, REASON, shifted)
    ).to.be.revertedWithCustomError(gov, 'DecisionAlreadyRecorded');
  });

  it('Dùng lại đúng bộ chữ ký cũ cho subject khác bị từ chối', async () => {
    const { ethers, gov, chair, m1, m2, outsider } = await deployFixture();
    const signatures = await quorumVotes(gov, ethers, [chair, m1, m2]);
    const otherSubject = '0x4444444444444444444444444444444444444444444444444444444444444444';
    await expect(
      gov.connect(outsider).recordDecision(KIND.Disbursement, otherSubject, true, REASON, signatures)
    ).to.be.revertedWithCustomError(gov, 'InvalidSignature');
  });

  it('Người ngoài Ủy ban ký thì bị chặn ngay ở khâu ghế', async () => {
    const { ethers, gov, chair, m1, outsider } = await deployFixture();
    const signatures = await quorumVotes(gov, ethers, [chair, m1, outsider]);
    await expect(
      gov.connect(outsider).recordDecision(KIND.Disbursement, SUBJECT_A, true, REASON, signatures)
    ).to.be.revertedWithCustomError(gov, 'SignerNotSeated');
  });

  it('Đề xuất thay ghế hết cửa sổ bảy ngày thì không thực thi được', async () => {
    const { ethers, gov, chair, m1, m2, m3, outsider } = await deployFixture();
    const newSeat = ethers.Wallet.createRandom().address;
    const target = m3.address;
    const signatures = [];
    const approvers = [chair, m1, m2];
    for (let i = 0; i < approvers.length; i += 1) {
      signatures.push(await signSeatChange(gov, ethers, approvers[i], {
        oldSeat: target, newSeat, role: SEAT_ROLE.Member, epoch: 1n, nonce: BigInt(i)
      }));
    }
    await gov.connect(outsider).proposeSeatChange(target, newSeat, SEAT_ROLE.Member, signatures);
    await ethers.provider.send('evm_increaseTime', [THREE_DAYS + SEVEN_DAYS + 10]);
    await ethers.provider.send('evm_mine', []);
    await expect(gov.connect(outsider).executeSeatChange(1))
      .to.be.revertedWithCustomError(gov, 'SeatChangeExpired');
  });

  it('Đề xuất thay ghế trước timelock ba ngày thì chưa thực thi được', async () => {
    const { ethers, gov, chair, m1, m2, m3, outsider } = await deployFixture();
    const newSeat = ethers.Wallet.createRandom().address;
    const signatures = [];
    const approvers = [chair, m1, m2];
    for (let i = 0; i < approvers.length; i += 1) {
      signatures.push(await signSeatChange(gov, ethers, approvers[i], {
        oldSeat: m3.address, newSeat, role: SEAT_ROLE.Member, epoch: 1n, nonce: BigInt(i)
      }));
    }
    await gov.connect(outsider).proposeSeatChange(m3.address, newSeat, SEAT_ROLE.Member, signatures);
    await expect(gov.connect(outsider).executeSeatChange(1))
      .to.be.revertedWithCustomError(gov, 'SeatChangeNotReady');
  });

  it('Hai đề xuất cùng epoch: cái thứ hai thành vô hiệu sau khi cái đầu thực thi', async () => {
    const { ethers, gov, chair, m1, m2, m3, m4, outsider } = await deployFixture();
    const seatX = ethers.Wallet.createRandom().address;
    const seatY = ethers.Wallet.createRandom().address;
    const approvers = [chair, m1, m2];
    const buildSignatures = async (oldSeat, newSeat, nonceBase) => {
      const list = [];
      for (let i = 0; i < approvers.length; i += 1) {
        list.push(await signSeatChange(gov, ethers, approvers[i], {
          oldSeat, newSeat, role: SEAT_ROLE.Member, epoch: 1n, nonce: BigInt(nonceBase + i)
        }));
      }
      return list;
    };
    const first = await buildSignatures(m3.address, seatX, 0);
    const second = await buildSignatures(m4.address, seatY, 10);
    await gov.connect(outsider).proposeSeatChange(m3.address, seatX, SEAT_ROLE.Member, first);
    await gov.connect(outsider).proposeSeatChange(m4.address, seatY, SEAT_ROLE.Member, second);
    await ethers.provider.send('evm_increaseTime', [THREE_DAYS + 10]);
    await ethers.provider.send('evm_mine', []);
    await gov.connect(outsider).executeSeatChange(1);
    await expect(gov.connect(outsider).executeSeatChange(2))
      .to.be.revertedWithCustomError(gov, 'SeatChangeEpochMismatch');
  });

  it('Bootstrap sai tỉ lệ hai Chủ tịch bị từ chối', async () => {
    const { gov, admin, chair, m1, m2, m3, m4 } = await deployRawFixture();
    await expect(gov.connect(admin).bootstrapSeats(
      [chair.address, m1.address, m2.address, m3.address, m4.address],
      [SEAT_ROLE.Chair, SEAT_ROLE.Chair, SEAT_ROLE.Member, SEAT_ROLE.Member, SEAT_ROLE.Member]
    )).to.be.revertedWithCustomError(gov, 'InvalidSeatComposition');
  });

  it('Bootstrap với địa chỉ trùng bị từ chối', async () => {
    const { gov, admin, chair, m1, m2, m3 } = await deployRawFixture();
    await expect(gov.connect(admin).bootstrapSeats(
      [chair.address, m1.address, m1.address, m2.address, m3.address],
      [SEAT_ROLE.Chair, SEAT_ROLE.Member, SEAT_ROLE.Member, SEAT_ROLE.Member, SEAT_ROLE.Member]
    )).to.be.revertedWithCustomError(gov, 'DuplicateSeat');
  });

  it('Bootstrap lần hai bị từ chối', async () => {
    const { gov, admin, chair, m1, m2, m3, m4 } = await deployFixture();
    await expect(gov.connect(admin).bootstrapSeats(
      [chair.address, m1.address, m2.address, m3.address, m4.address],
      [SEAT_ROLE.Chair, SEAT_ROLE.Member, SEAT_ROLE.Member, SEAT_ROLE.Member, SEAT_ROLE.Member]
    )).to.be.revertedWithCustomError(gov, 'SeatsAlreadyBootstrapped');
  });

  it('Người không phải bootstrap admin không nạp được ghế', async () => {
    const { gov, chair, m1, m2, m3, m4, outsider } = await deployRawFixture();
    await expect(gov.connect(outsider).bootstrapSeats(
      [chair.address, m1.address, m2.address, m3.address, m4.address],
      [SEAT_ROLE.Chair, SEAT_ROLE.Member, SEAT_ROLE.Member, SEAT_ROLE.Member, SEAT_ROLE.Member]
    )).to.be.revertedWithCustomError(gov, 'NotBootstrapAdmin');
  });

  it('Chưa bootstrap thì không ghi được quyết định', async () => {
    const { ethers, gov, chair, m1, m2, outsider } = await deployRawFixture();
    const signatures = await quorumVotes(gov, ethers, [chair, m1, m2], { epoch: 0n });
    await expect(
      gov.connect(outsider).recordDecision(KIND.Disbursement, SUBJECT_A, true, REASON, signatures)
    ).to.be.revertedWithCustomError(gov, 'SeatsNotBootstrapped');
  });
});
