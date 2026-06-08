import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('SimpleStorage', function () {
  /**
   * Hàm hỗ trợ deploy contract mẫu cho test.
   * Mục đích: tái sử dụng logic deploy giúp test rõ ràng, dễ đọc.
   */
  async function deploySimpleStorageFixture() {
    const simpleStorageFactory = await ethers.getContractFactory('SimpleStorage');
    const simpleStorageContract = await simpleStorageFactory.deploy();

    await simpleStorageContract.waitForDeployment();

    return { simpleStorageContract };
  }

  it('should store and read value correctly', async function () {
    const { simpleStorageContract } = await deploySimpleStorageFixture();

    await simpleStorageContract.setValue(2024);

    const storedValue = await simpleStorageContract.getValue();

    expect(storedValue).to.equal(2024);
  });
});

