import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('DcpDonationRanking', function () {
  /** Hàm deploy fixture cho test FR3. Mục đích: khởi tạo token, ranking và cấp quyền cần thiết để test donate công khai. */
  async function deployDonationFixture() {
    const [adminAccount, managerAccount, donorAccount, secondDonorAccount] = await ethers.getSigners();

    const tokenFactory = await ethers.getContractFactory('DcpCharityToken');
    const tokenContract = await tokenFactory.deploy(adminAccount.address);
    await tokenContract.waitForDeployment();

    const rankingFactory = await ethers.getContractFactory('DcpDonationRanking');
    const rankingContract = await rankingFactory.deploy(await tokenContract.getAddress(), adminAccount.address);
    await rankingContract.waitForDeployment();

    await tokenContract.connect(adminAccount).grantMinterRole(adminAccount.address);
    await tokenContract.connect(adminAccount).mintFromBackend(donorAccount.address, 12000, 'ORDER-FR3-001');
    await tokenContract.connect(adminAccount).mintFromBackend(secondDonorAccount.address, 20000, 'ORDER-FR3-002');

    await rankingContract.connect(adminAccount).grantProjectManagerRole(managerAccount.address);
    await rankingContract.connect(managerAccount).createProject(1);
    await rankingContract.connect(managerAccount).setProjectStatus(1, 1);

    return { tokenContract, rankingContract, donorAccount, secondDonorAccount, managerAccount };
  }

  it('should donate successfully and emit DonationReceived event', async function () {
    const { tokenContract, rankingContract, donorAccount } = await deployDonationFixture();

    await tokenContract.connect(donorAccount).approve(await rankingContract.getAddress(), 5000);

    await expect(rankingContract.connect(donorAccount).donate(1, 5000, false))
      .to.emit(rankingContract, 'DonationReceived')
      .withArgs(donorAccount.address, 1, 5000, anyUintValue(), false);

    const snapshot = await rankingContract.getProjectSnapshot(1);
    expect(snapshot.totalDonationAmount).to.equal(5000);
    expect(snapshot.donationTransactionCount).to.equal(1);
    expect(snapshot.donorCount).to.equal(1);
  });

  it('should increase donorCount only once for repeated donations of same donor', async function () {
    const { tokenContract, rankingContract, donorAccount } = await deployDonationFixture();

    await tokenContract.connect(donorAccount).approve(await rankingContract.getAddress(), 9000);
    await rankingContract.connect(donorAccount).donate(1, 4000, false);
    await rankingContract.connect(donorAccount).donate(1, 5000, true);

    const snapshot = await rankingContract.getProjectSnapshot(1);
    expect(snapshot.totalDonationAmount).to.equal(9000);
    expect(snapshot.donationTransactionCount).to.equal(2);
    expect(snapshot.donorCount).to.equal(1);
  });

  it('should revert when amount is zero', async function () {
    const { rankingContract, donorAccount } = await deployDonationFixture();

    await expect(rankingContract.connect(donorAccount).donate(1, 0, false)).to.be.revertedWithCustomError(
      rankingContract,
      'InvalidAmount'
    );
  });

  it('should revert when project is not active', async function () {
    const [adminAccount, managerAccount, donorAccount] = await ethers.getSigners();

    const tokenFactory = await ethers.getContractFactory('DcpCharityToken');
    const tokenContract = await tokenFactory.deploy(adminAccount.address);
    await tokenContract.waitForDeployment();

    const rankingFactory = await ethers.getContractFactory('DcpDonationRanking');
    const rankingContract = await rankingFactory.deploy(await tokenContract.getAddress(), adminAccount.address);
    await rankingContract.waitForDeployment();

    await rankingContract.connect(adminAccount).grantProjectManagerRole(managerAccount.address);
    await rankingContract.connect(managerAccount).createProject(2);

    await expect(rankingContract.connect(donorAccount).donate(2, 1000, false)).to.be.revertedWithCustomError(
      rankingContract,
      'InvalidProjectState'
    );
  });
});

/** Hàm matcher cho tham số timestamp event. Mục đích: bỏ qua so sánh cứng timestamp nhưng vẫn xác nhận đúng kiểu dữ liệu. */
function anyUintValue() {
  return (value) => typeof value === 'bigint' && value >= 0n;
}
