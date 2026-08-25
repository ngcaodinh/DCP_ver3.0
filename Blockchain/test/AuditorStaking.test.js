import { expect } from 'chai';
import { network } from 'hardhat';

const INITIAL_THRESHOLD = 3_000_000n;
const INITIAL_STAKE = 5_000_000n;
const UNBONDING_PERIOD_SECONDS = 7n * 24n * 60n * 60n;

/**
 * Triển khai token DCT và AuditorStaking với các tài khoản độc lập cho từng kịch bản.
 */
async function deployAuditorStakingFixture() {
  const { ethers } = await network.create();
  const [admin, slasher, staker, auditor, otherAccount] = await ethers.getSigners();

  const tokenFactory = await ethers.getContractFactory('DcpCharityToken');
  const stakeToken = await tokenFactory.deploy(admin.address);
  await stakeToken.waitForDeployment();

  await stakeToken.grantMinterRole(admin.address);
  await stakeToken.mintFromBackend(staker.address, INITIAL_STAKE, 'AUDITOR_STAKING_TEST_STAKER');
  await stakeToken.mintFromBackend(auditor.address, INITIAL_STAKE, 'AUDITOR_STAKING_TEST_AUDITOR');
  await stakeToken.mintFromBackend(admin.address, INITIAL_STAKE, 'AUDITOR_STAKING_TEST_ADMIN');

  const stakingFactory = await ethers.getContractFactory('AuditorStaking');
  const auditorStaking = await stakingFactory.deploy(
    await stakeToken.getAddress(),
    admin.address,
    INITIAL_THRESHOLD,
    slasher.address
  );
  await auditorStaking.waitForDeployment();

  return { admin, slasher, staker, auditor, otherAccount, stakeToken, auditorStaking, ethers };
}

/**
 * Kiểm tra bất biến kế toán nhằm bảo đảm contract luôn đủ token cho các nghĩa vụ đã ghi nhận.
 */
async function expectAccountingInvariant(auditorStaking, stakeToken, accounts) {
  let totalStake = 0n;
  let totalPendingWithdrawal = 0n;

  for (const account of accounts) {
    totalStake += await auditorStaking.stakedBalance(account.address);
    totalPendingWithdrawal += await auditorStaking.pendingWithdrawAmount(account.address);
  }

  const contractBalance = await stakeToken.balanceOf(await auditorStaking.getAddress());
  expect(contractBalance).to.be.gte(
    totalStake + totalPendingWithdrawal + await auditorStaking.rewardPool()
  );
}

describe('AuditorStaking', function () {
  it('stakes token, tracks the balance, and emits the cumulative balance', async function () {
    const { staker, stakeToken, auditorStaking } = await deployAuditorStakingFixture();
    const stakeAmount = 3_000_000n;

    await stakeToken.connect(staker).approve(await auditorStaking.getAddress(), stakeAmount);

    await expect(auditorStaking.connect(staker).stake(stakeAmount))
      .to.emit(auditorStaking, 'Staked')
      .withArgs(staker.address, stakeAmount, stakeAmount);

    expect(await auditorStaking.stakedBalance(staker.address)).to.equal(stakeAmount);
    await expectAccountingInvariant(auditorStaking, stakeToken, [staker]);
  });

  it('rejects a zero stake', async function () {
    const { staker, auditorStaking } = await deployAuditorStakingFixture();

    await expect(auditorStaking.connect(staker).stake(0))
      .to.be.revertedWithCustomError(auditorStaking, 'InvalidAmount');
  });

  it('moves an unstake request immediately and starts the seven-day release period', async function () {
    const { staker, stakeToken, auditorStaking, ethers } = await deployAuditorStakingFixture();
    const stakeAmount = 3_000_000n;
    const unstakeAmount = 1_000_000n;

    await stakeToken.connect(staker).approve(await auditorStaking.getAddress(), stakeAmount);
    await auditorStaking.connect(staker).stake(stakeAmount);
    const transaction = await auditorStaking.connect(staker).requestUnstake(unstakeAmount);
    const receipt = await transaction.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);

    expect(await auditorStaking.stakedBalance(staker.address)).to.equal(stakeAmount - unstakeAmount);
    expect(await auditorStaking.pendingWithdrawAmount(staker.address)).to.equal(unstakeAmount);
    expect(await auditorStaking.unbondingReleaseAt(staker.address)).to.equal(
      BigInt(block.timestamp) + UNBONDING_PERIOD_SECONDS
    );
  });

  it('rejects an unstake amount that exceeds the active stake', async function () {
    const { staker, stakeToken, auditorStaking } = await deployAuditorStakingFixture();
    const stakeAmount = 3_000_000n;

    await stakeToken.connect(staker).approve(await auditorStaking.getAddress(), stakeAmount);
    await auditorStaking.connect(staker).stake(stakeAmount);

    await expect(auditorStaking.connect(staker).requestUnstake(stakeAmount + 1n))
      .to.be.revertedWithCustomError(auditorStaking, 'InsufficientStakedBalance');
  });

  it('does not allow a withdrawal before the unbonding period finishes', async function () {
    const { staker, stakeToken, auditorStaking } = await deployAuditorStakingFixture();
    const stakeAmount = 3_000_000n;

    await stakeToken.connect(staker).approve(await auditorStaking.getAddress(), stakeAmount);
    await auditorStaking.connect(staker).stake(stakeAmount);
    await auditorStaking.connect(staker).requestUnstake(stakeAmount);

    await expect(auditorStaking.connect(staker).withdraw())
      .to.be.revertedWithCustomError(auditorStaking, 'UnbondingNotReady');
  });

  it('withdraws the pending stake after seven days', async function () {
    const { staker, stakeToken, auditorStaking, ethers } = await deployAuditorStakingFixture();
    const stakeAmount = 3_000_000n;

    await stakeToken.connect(staker).approve(await auditorStaking.getAddress(), stakeAmount);
    await auditorStaking.connect(staker).stake(stakeAmount);
    await auditorStaking.connect(staker).requestUnstake(stakeAmount);
    await ethers.provider.send('evm_increaseTime', [Number(UNBONDING_PERIOD_SECONDS)]);
    await ethers.provider.send('evm_mine', []);

    await expect(auditorStaking.connect(staker).withdraw())
      .to.emit(auditorStaking, 'Withdrawn')
      .withArgs(staker.address, stakeAmount);

    expect(await auditorStaking.pendingWithdrawAmount(staker.address)).to.equal(0);
    await expectAccountingInvariant(auditorStaking, stakeToken, [staker]);
  });

  it('allows only the slasher to slash and retains the penalty in rewardPool', async function () {
    const { slasher, staker, otherAccount, stakeToken, auditorStaking } = await deployAuditorStakingFixture();
    const stakeAmount = 3_000_000n;
    const slashAmount = 900_000n;

    await stakeToken.connect(staker).approve(await auditorStaking.getAddress(), stakeAmount);
    await auditorStaking.connect(staker).stake(stakeAmount);

    await expect(auditorStaking.connect(otherAccount).slash(staker.address, slashAmount, 'UNAUTHORIZED'))
      .to.be.revertedWithCustomError(auditorStaking, 'AccessControlUnauthorizedAccount');

    const balanceBeforeSlash = await stakeToken.balanceOf(await auditorStaking.getAddress());
    await auditorStaking.connect(slasher).slash(staker.address, slashAmount, 'INCORRECT_FIELD_VERDICT:1');

    expect(await auditorStaking.stakedBalance(staker.address)).to.equal(stakeAmount - slashAmount);
    expect(await auditorStaking.rewardPool()).to.equal(slashAmount);
    expect(await stakeToken.balanceOf(await auditorStaking.getAddress())).to.equal(balanceBeforeSlash);
    await expectAccountingInvariant(auditorStaking, stakeToken, [staker]);
  });

  it('rejects a slash above the active stake', async function () {
    const { slasher, staker, stakeToken, auditorStaking } = await deployAuditorStakingFixture();
    const stakeAmount = 3_000_000n;

    await stakeToken.connect(staker).approve(await auditorStaking.getAddress(), stakeAmount);
    await auditorStaking.connect(staker).stake(stakeAmount);

    await expect(auditorStaking.connect(slasher).slash(staker.address, stakeAmount + 1n, 'OVER_STAKE'))
      .to.be.revertedWithCustomError(auditorStaking, 'InsufficientStakedBalance');
  });

  it('rejects an empty or duplicate reason code so off-chain retries cannot apply the same slash twice', async function () {
    const { slasher, staker, stakeToken, auditorStaking } = await deployAuditorStakingFixture();
    await stakeToken.connect(staker).approve(await auditorStaking.getAddress(), INITIAL_THRESHOLD);
    await auditorStaking.connect(staker).stake(INITIAL_THRESHOLD);

    await expect(auditorStaking.connect(slasher).slash(staker.address, 1n, ''))
      .to.be.revertedWithCustomError(auditorStaking, 'EmptyReasonCode');
    await auditorStaking.connect(slasher).slash(staker.address, 1n, 'PENALTY:CASE-1:auditor-1');
    await expect(auditorStaking.connect(slasher).slash(staker.address, 1n, 'PENALTY:CASE-1:auditor-1'))
      .to.be.revertedWithCustomError(auditorStaking, 'AlreadyProcessedReasonCode');
  });

  it('documents the frozen-contract boundary: pending withdrawals must be collected as off-chain debt', async function () {
    const { slasher, staker, stakeToken, auditorStaking } = await deployAuditorStakingFixture();
    await stakeToken.connect(staker).approve(await auditorStaking.getAddress(), INITIAL_THRESHOLD);
    await auditorStaking.connect(staker).stake(INITIAL_THRESHOLD);
    await auditorStaking.connect(staker).requestUnstake(INITIAL_THRESHOLD);

    await expect(auditorStaking.connect(slasher).slash(staker.address, 1n, 'PENALTY:PENDING:auditor-1'))
      .to.be.revertedWithCustomError(auditorStaking, 'InsufficientStakedBalance');
  });

  it('protects staked balances when a reward exceeds rewardPool and pays valid rewards', async function () {
    const { slasher, staker, auditor, stakeToken, auditorStaking } = await deployAuditorStakingFixture();
    const stakeAmount = 3_000_000n;
    const slashAmount = 900_000n;
    const rewardAmount = 500_000n;

    await stakeToken.connect(staker).approve(await auditorStaking.getAddress(), stakeAmount);
    await auditorStaking.connect(staker).stake(stakeAmount);
    await auditorStaking.connect(slasher).slash(staker.address, slashAmount, 'PENALTY:1');

    await expect(auditorStaking.connect(slasher).payReward(auditor.address, slashAmount + 1n, 'REWARD:OVER'))
      .to.be.revertedWithCustomError(auditorStaking, 'InsufficientRewardPool');
    expect(await auditorStaking.stakedBalance(staker.address)).to.equal(stakeAmount - slashAmount);

    const auditorBalanceBeforeReward = await stakeToken.balanceOf(auditor.address);
    await expect(auditorStaking.connect(slasher).payReward(auditor.address, rewardAmount, 'VERIFIED_FIELD_REPORT:1'))
      .to.emit(auditorStaking, 'Rewarded')
      .withArgs(auditor.address, rewardAmount, 'VERIFIED_FIELD_REPORT:1');

    expect(await stakeToken.balanceOf(auditor.address)).to.equal(auditorBalanceBeforeReward + rewardAmount);
    expect(await auditorStaking.rewardPool()).to.equal(slashAmount - rewardAmount);
    await expectAccountingInvariant(auditorStaking, stakeToken, [staker, auditor]);
  });

  it('funds rewardPool from the admin wallet', async function () {
    const { admin, stakeToken, auditorStaking } = await deployAuditorStakingFixture();
    const fundingAmount = 500_000n;

    await stakeToken.connect(admin).approve(await auditorStaking.getAddress(), fundingAmount);
    await expect(auditorStaking.connect(admin).fundRewardPool(fundingAmount))
      .to.emit(auditorStaking, 'RewardPoolFunded')
      .withArgs(admin.address, fundingAmount);

    expect(await auditorStaking.rewardPool()).to.equal(fundingAmount);
    await expectAccountingInvariant(auditorStaking, stakeToken, []);
  });

  it('pauses new stakes without trapping withdrawals or stopping slashing and rewards', async function () {
    const { admin, slasher, staker, auditor, stakeToken, auditorStaking, ethers } = await deployAuditorStakingFixture();
    const stakeAmount = 3_000_000n;
    const slashAmount = 900_000n;

    await stakeToken.connect(staker).approve(await auditorStaking.getAddress(), stakeAmount);
    await auditorStaking.connect(staker).stake(stakeAmount);
    await auditorStaking.connect(staker).requestUnstake(1_000_000n);
    await auditorStaking.connect(slasher).slash(staker.address, slashAmount, 'PENALTY:PAUSED');
    await auditorStaking.connect(admin).pauseContract();

    await expect(auditorStaking.connect(staker).stake(1n))
      .to.be.revertedWithCustomError(auditorStaking, 'EnforcedPause');
    await expect(auditorStaking.connect(staker).requestUnstake(1n))
      .to.be.revertedWithCustomError(auditorStaking, 'EnforcedPause');

    await auditorStaking.connect(slasher).payReward(auditor.address, slashAmount, 'REWARD:PAUSED');
    await ethers.provider.send('evm_increaseTime', [Number(UNBONDING_PERIOD_SECONDS)]);
    await ethers.provider.send('evm_mine', []);
    await auditorStaking.connect(staker).withdraw();

    await expectAccountingInvariant(auditorStaking, stakeToken, [staker, auditor]);
  });
});
