import { expect } from 'chai';
import { network } from 'hardhat';

/**
 * Mang cac gia tri co the cua TokenStatus.
 */
const TokenStatus = {
  Active: 0,
  Frozen: 1,
  Revoked: 2,
  Burned: 3
};

/**
 * Helper: ma hoa dia chi vi.
 */
function maskAddress(address_) {
  return address_.slice(0, 6) + '...' + address_.slice(-4);
}

/**
 * Fixture deploy contract voi cac tai khoan can thiet.
 * Hardhat 3: ethers duoc lay tu network.connect().
 */
async function deployImpactSBTFixture() {
  const { ethers } = await network.create();
  const [owner, oracle, newOracle, recipient, otherAccount] = await ethers.getSigners();

  const impactSBTFactory = await ethers.getContractFactory('ImpactSBT');
  const impactSBT = await impactSBTFactory.deploy(oracle.address);
  await impactSBT.waitForDeployment();

  return { impactSBT, owner, oracle, newOracle, recipient, otherAccount, ethers };
}

describe('ImpactSBT', function () {
  // ============================================================
  // Deployment
  // ============================================================
  describe('Deployment', function () {
    it('should deploy with oracle granted ORACLE_ROLE', async function () {
      const { impactSBT, oracle } = await deployImpactSBTFixture();
      expect(await impactSBT.isOracle(oracle.address)).to.equal(true);
    });

    it('should have zero totalSupply initially', async function () {
      const { impactSBT } = await deployImpactSBTFixture();
      expect(await impactSBT.totalSupply()).to.equal(0);
    });

    it('should revert when initial oracle is zero address', async function () {
      const { ethers } = await network.create();
      const impactSBTFactory = await ethers.getContractFactory('ImpactSBT');
      await expect(
        impactSBTFactory.deploy(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(impactSBTFactory, 'InvalidAddress');
    });

    it('should set correct owner', async function () {
      const { impactSBT, owner } = await deployImpactSBTFixture();
      expect(await impactSBT.owner()).to.equal(owner.address);
    });

    it('should support ERC-5192, ERC-721, AccessControl interfaces', async function () {
      const { impactSBT } = await deployImpactSBTFixture();
      expect(await impactSBT.supportsInterface('0x6a4d1d1c')).to.equal(true); // ERC-5192
      expect(await impactSBT.supportsInterface('0x80ac58cd')).to.equal(true); // ERC-721
      expect(await impactSBT.supportsInterface('0x7965db0b')).to.equal(true); // AccessControl
    });
  });

  // ============================================================
  // Minting
  // ============================================================
  describe('Minting', function () {
    it('should mint SBT successfully when called by oracle', async function () {
      const { impactSBT, oracle, recipient } = await deployImpactSBTFixture();

      const mintTx = await impactSBT.connect(oracle).mint(
        recipient.address,
        1,      // projectId
        1,      // milestone
        100,    // beneficiaryCount
        '10.776043,106.642754',
        'QmXxx...',
        'https://ipfs.io/ipfs/QmXxx...'
      );

      await expect(mintTx)
        .to.emit(impactSBT, 'SBTMinted')
        .withArgs(recipient.address, 0, 'https://ipfs.io/ipfs/QmXxx...');

      expect(await impactSBT.totalSupply()).to.equal(1);
      expect(await impactSBT.balanceOf(recipient.address)).to.equal(1);
    });

    it('should assign correct token ID sequentially', async function () {
      const { impactSBT, oracle, recipient, otherAccount } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 50,
        '10.776043,106.642754', 'QmAaa...', 'https://ipfs.io/ipfs/QmAaa...'
      );
      await impactSBT.connect(oracle).mint(
        otherAccount.address, 2, 1, 75,
        '10.776044,106.642755', 'QmBbb...', 'https://ipfs.io/ipfs/QmBbb...'
      );

      expect(await impactSBT.totalSupply()).to.equal(2);
      expect(await impactSBT.balanceOf(recipient.address)).to.equal(1);
      expect(await impactSBT.balanceOf(otherAccount.address)).to.equal(1);
    });

    it('should revert when called by non-oracle', async function () {
      const { impactSBT, owner, recipient } = await deployImpactSBTFixture();

      await expect(
        impactSBT.connect(owner).mint(
          recipient.address, 1, 1, 100,
          '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
        )
      ).to.be.revertedWithCustomError(impactSBT, 'AccessControlUnauthorizedAccount');
    });

    it('should revert when minting to zero address', async function () {
      const { impactSBT, oracle, ethers } = await deployImpactSBTFixture();

      await expect(
        impactSBT.connect(oracle).mint(
          ethers.ZeroAddress, 1, 1, 100,
          '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
        )
      ).to.be.revertedWithCustomError(impactSBT, 'InvalidAddress');
    });

    it('should store correct metadata after minting', async function () {
      const { impactSBT, oracle, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 42, 3, 250,
        '21.028511,105.804817', 'QmMetadataHash',
        'https://ipfs.io/ipfs/QmMetadataHash'
      );

      const metadata = await impactSBT.getTokenMetadata(0);
      expect(metadata.projectId).to.equal(42);
      expect(metadata.milestone).to.equal(3);
      expect(metadata.beneficiaryCount).to.equal(250);
      expect(metadata.gpsCoordinates).to.equal('21.028511,105.804817');
      expect(metadata.imageCID).to.equal('QmMetadataHash');
      expect(metadata.mintedAt).to.be.greaterThan(0);
    });

    it('should set token status to Active after minting', async function () {
      const { impactSBT, oracle, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      expect(await impactSBT.getTokenStatus(0)).to.equal(TokenStatus.Active);
    });
  });

  // ============================================================
  // Soulbound Lock (ERC-5192)
  // ============================================================
  describe('Soulbound Lock (ERC-5192)', function () {
    it('should lock SBT after minting (locked returns true)', async function () {
      const { impactSBT, oracle, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      expect(await impactSBT.locked(0)).to.equal(true);
    });

    it('should revert when transferring locked SBT', async function () {
      const { impactSBT, oracle, recipient, otherAccount } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      await expect(
        impactSBT.connect(recipient).transferFrom(recipient.address, otherAccount.address, 0)
      ).to.be.revertedWithCustomError(impactSBT, 'TokenLocked');
    });
  });

  // ============================================================
  // Extended Token Status (Active, Frozen, Revoked, Burned)
  // ============================================================
  describe('Extended Token Status', function () {
    it('should return Active status after minting', async function () {
      const { impactSBT, oracle, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      expect(await impactSBT.getTokenStatus(0)).to.equal(TokenStatus.Active);
    });

    it('should allow oracle to update status to Frozen', async function () {
      const { impactSBT, oracle, owner, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      await expect(
        impactSBT.connect(oracle).updateTokenStatus(
          0, TokenStatus.Frozen, 'Emergency freeze - investigation ongoing'
        )
      )
        .to.emit(impactSBT, 'TokenStatusUpdated')
        .withArgs(0, TokenStatus.Frozen, 'Emergency freeze - investigation ongoing');

      expect(await impactSBT.getTokenStatus(0)).to.equal(TokenStatus.Frozen);
    });

    // Known accepted contract behavior: owner is also authorized to freeze status.
    // Keep this regression test until a separately audited role-policy upgrade changes the deployed ABI.
    it('should allow owner to update status to Frozen', async function () {
      const { impactSBT, oracle, owner, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      await impactSBT.connect(owner).updateTokenStatus(
        0, TokenStatus.Frozen, 'Owner initiated emergency freeze'
      );
      expect(await impactSBT.getTokenStatus(0)).to.equal(TokenStatus.Frozen);
    });

    it('should not allow transfer even when status is Frozen (locked returns false but transfer blocked)', async function () {
      const { impactSBT, oracle, owner, otherAccount } = await deployImpactSBTFixture();
      await impactSBT.connect(oracle).mint(owner.address, 1, 1, 5, '10.0,20.0', 'QmTest1', 'ipfs://example1');
      await impactSBT.connect(oracle).updateTokenStatus(0, 1, 'Freezing'); // Frozen

      // locked() returns false (not ERC-5192 locked anymore)
      expect(await impactSBT.locked(0)).to.equal(false);
      // But soulbound still prevents transfer — tokens are permanently soulbound
      await expect(
        impactSBT.connect(owner).transferFrom(owner.address, otherAccount.address, 0)
      ).to.be.revertedWithCustomError(impactSBT, 'TokenLocked');
    });

    it('should allow oracle to update status to Revoked', async function () {
      const { impactSBT, oracle, owner, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      await expect(
        impactSBT.connect(oracle).updateTokenStatus(
          0, TokenStatus.Revoked, 'Project completed with issues'
        )
      )
        .to.emit(impactSBT, 'TokenStatusUpdated')
        .withArgs(0, TokenStatus.Revoked, 'Project completed with issues');

      expect(await impactSBT.getTokenStatus(0)).to.equal(TokenStatus.Revoked);
    });

    it('should allow owner to update status to Revoked', async function () {
      const { impactSBT, oracle, owner, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      await impactSBT.connect(owner).updateTokenStatus(
        0, TokenStatus.Revoked, 'Owner initiated revocation'
      );
      expect(await impactSBT.getTokenStatus(0)).to.equal(TokenStatus.Revoked);
    });

    it('should not allow status update after Revoked (terminal state)', async function () {
      const { impactSBT, oracle, owner, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      await impactSBT.connect(owner).updateTokenStatus(0, TokenStatus.Revoked, 'Revoking'); // Revoked

      // Cannot transition from Revoked to any other state
      await expect(
        impactSBT.connect(owner).updateTokenStatus(0, TokenStatus.Active, 'Try to reactivate')
      ).to.be.revertedWithCustomError(impactSBT, 'InvalidTransition');
    });

    it('should allow updating status to Burned', async function () {
      const { impactSBT, oracle, owner, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      await impactSBT.connect(owner).updateTokenStatus(
        0, TokenStatus.Burned, 'Token burned by owner'
      );
      expect(await impactSBT.getTokenStatus(0)).to.equal(TokenStatus.Burned);
    });

    it('should not allow status update after Burned (terminal state)', async function () {
      const { impactSBT, oracle, owner, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      await impactSBT.connect(owner).updateTokenStatus(0, TokenStatus.Burned, 'Burning'); // Burned

      // Cannot transition from Burned to any other state
      await expect(
        impactSBT.connect(owner).updateTokenStatus(0, TokenStatus.Active, 'Try to revive')
      ).to.be.revertedWithCustomError(impactSBT, 'InvalidTransition');
    });

    it('should revert when non-authorized account updates status', async function () {
      const { impactSBT, oracle, otherAccount, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      await expect(
        impactSBT.connect(otherAccount).updateTokenStatus(
          0, TokenStatus.Revoked, 'Unauthorized attempt'
        )
      ).to.be.revertedWithCustomError(impactSBT, 'AccessControlUnauthorizedAccount');
    });

    it('should revert when updating non-existent token status', async function () {
      const { impactSBT, oracle } = await deployImpactSBTFixture();

      await expect(
        impactSBT.connect(oracle).updateTokenStatus(
          999, TokenStatus.Revoked, 'Non-existent token'
        )
      ).to.be.revertedWithCustomError(impactSBT, 'TokenNotExists');
    });

    it('should revert when updating with invalid status (out of range)', async function () {
      const { impactSBT, oracle, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      await expect(
        impactSBT.connect(oracle).updateTokenStatus(0, 99, 'Invalid status')
      ).to.be.revertedWithCustomError(impactSBT, 'InvalidStatus');
    });

    it('should allow transitioning from Frozen back to Active', async function () {
      const { impactSBT, oracle, owner, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      await impactSBT.connect(owner).updateTokenStatus(0, TokenStatus.Frozen, 'Emergency freeze');
      expect(await impactSBT.getTokenStatus(0)).to.equal(TokenStatus.Frozen);

      await impactSBT.connect(owner).updateTokenStatus(0, TokenStatus.Active, 'Unfreeze - resolved');
      expect(await impactSBT.getTokenStatus(0)).to.equal(TokenStatus.Active);
      expect(await impactSBT.locked(0)).to.equal(true);
    });
  });

  // ============================================================
  // Oracle Role Transfer
  // ============================================================
  describe('Oracle Role Transfer', function () {
    it('should allow owner to transfer oracle role', async function () {
      const { impactSBT, owner, oracle, newOracle } = await deployImpactSBTFixture();

      expect(await impactSBT.isOracle(oracle.address)).to.equal(true);
      expect(await impactSBT.isOracle(newOracle.address)).to.equal(false);

      await expect(
        impactSBT.connect(owner).transferOracleRole(newOracle.address)
      )
        .to.emit(impactSBT, 'OracleRoleTransferred')
        .withArgs(oracle.address, newOracle.address);

      expect(await impactSBT.isOracle(oracle.address)).to.equal(false);
      expect(await impactSBT.isOracle(newOracle.address)).to.equal(true);
    });

    it('should allow new oracle to mint after transfer', async function () {
      const { impactSBT, owner, oracle, newOracle, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(owner).transferOracleRole(newOracle.address);

      await expect(
        impactSBT.connect(newOracle).mint(
          recipient.address, 1, 1, 100,
          '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
        )
      ).to.emit(impactSBT, 'SBTMinted');

      expect(await impactSBT.totalSupply()).to.equal(1);
    });

    it('should revert when old oracle tries to mint after transfer', async function () {
      const { impactSBT, owner, oracle, newOracle, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(owner).transferOracleRole(newOracle.address);

      await expect(
        impactSBT.connect(oracle).mint(
          recipient.address, 1, 1, 100,
          '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
        )
      ).to.be.revertedWithCustomError(impactSBT, 'AccessControlUnauthorizedAccount');
    });

    it('should revert when non-owner tries to transfer oracle role', async function () {
      const { impactSBT, oracle, newOracle, otherAccount } = await deployImpactSBTFixture();

      await expect(
        impactSBT.connect(otherAccount).transferOracleRole(newOracle.address)
      ).to.be.revertedWithCustomError(impactSBT, 'OwnableUnauthorizedAccount');
    });

    it('should revert when transferring oracle to zero address', async function () {
      const { impactSBT, owner, ethers } = await deployImpactSBTFixture();

      await expect(
        impactSBT.connect(owner).transferOracleRole(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(impactSBT, 'InvalidAddress');
    });
  });

  // ============================================================
  // Ownership Transfer & DEFAULT_ADMIN_ROLE Sync
  // ============================================================
  describe('Ownership Transfer & DEFAULT_ADMIN_ROLE Sync', function () {
    it('should sync DEFAULT_ADMIN_ROLE when transferring ownership', async function () {
      const { impactSBT, owner, newOracle, otherAccount } = await deployImpactSBTFixture();

      // New owner khong co DEFAULT_ADMIN_ROLE truoc khi transfer
      expect(await impactSBT.hasRole('0x0000000000000000000000000000000000000000000000000000000000000000', newOracle.address))
        .to.equal(false);

      await impactSBT.connect(owner).transferOwnership(newOracle.address);

      // New owner co DEFAULT_ADMIN_ROLE sau khi transfer
      expect(await impactSBT.hasRole('0x0000000000000000000000000000000000000000000000000000000000000000', newOracle.address))
        .to.equal(true);
      // Owner cu khong con DEFAULT_ADMIN_ROLE
      expect(await impactSBT.hasRole('0x0000000000000000000000000000000000000000000000000000000000000000', owner.address))
        .to.equal(false);
    });

    // Known accepted contract behavior: ownership transfer grants the new owner role-admin capability.
    // Backend must therefore protect role changes operationally with multisig/timelock policy.
    it('should allow new owner to grant roles after ownership transfer', async function () {
      const { impactSBT, owner, newOracle, otherAccount } = await deployImpactSBTFixture();
      const ORACLE_ROLE = await impactSBT.ORACLE_ROLE();

      await impactSBT.connect(owner).transferOwnership(newOracle.address);

      // New owner co the grant ORACLE_ROLE
      await impactSBT.connect(newOracle).grantRole(ORACLE_ROLE, otherAccount.address);

      expect(await impactSBT.isOracle(otherAccount.address)).to.equal(true);
    });

    it('should prevent old owner from granting roles after ownership transfer', async function () {
      const { impactSBT, owner, newOracle, otherAccount } = await deployImpactSBTFixture();

      await impactSBT.connect(owner).transferOwnership(newOracle.address);

      // Owner cu khong con quyen grant
      await expect(
        impactSBT.connect(owner).grantRole(
          '0x0000000000000000000000000000000000000000000000000000000000000001',
          otherAccount.address
        )
      ).to.be.revertedWithCustomError(impactSBT, 'AccessControlUnauthorizedAccount');
    });

    it('should revert when transferring ownership to zero address', async function () {
      const { impactSBT, owner, ethers } = await deployImpactSBTFixture();

      await expect(
        impactSBT.connect(owner).transferOwnership(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(impactSBT, 'InvalidAddress');
    });

    it('should revert when non-owner tries to transfer ownership', async function () {
      const { impactSBT, owner, newOracle, otherAccount } = await deployImpactSBTFixture();

      await expect(
        impactSBT.connect(otherAccount).transferOwnership(newOracle.address)
      ).to.be.revertedWithCustomError(impactSBT, 'OwnableUnauthorizedAccount');
    });
  });

  // ============================================================
  // Pausable
  // ============================================================
  describe('Pausable', function () {
    it('should allow owner to pause contract', async function () {
      const { impactSBT, owner, oracle, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(owner).pause();

      await expect(
        impactSBT.connect(oracle).mint(
          recipient.address, 1, 1, 100,
          '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
        )
      ).to.be.revertedWithCustomError(impactSBT, 'EnforcedPause');
    });

    it('should allow owner to unpause contract', async function () {
      const { impactSBT, owner, oracle, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(owner).pause();
      await impactSBT.connect(owner).unpause();

      await expect(
        impactSBT.connect(oracle).mint(
          recipient.address, 1, 1, 100,
          '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
        )
      ).to.emit(impactSBT, 'SBTMinted');

      expect(await impactSBT.totalSupply()).to.equal(1);
    });

    it('should revert when non-owner tries to pause', async function () {
      const { impactSBT, oracle, otherAccount } = await deployImpactSBTFixture();

      await expect(
        impactSBT.connect(otherAccount).pause()
      ).to.be.revertedWithCustomError(impactSBT, 'OwnableUnauthorizedAccount');

      await expect(
        impactSBT.connect(oracle).pause()
      ).to.be.revertedWithCustomError(impactSBT, 'OwnableUnauthorizedAccount');
    });

    it('should revert when non-owner tries to unpause', async function () {
      const { impactSBT, owner, oracle, otherAccount } = await deployImpactSBTFixture();

      await impactSBT.connect(owner).pause();

      await expect(
        impactSBT.connect(otherAccount).unpause()
      ).to.be.revertedWithCustomError(impactSBT, 'OwnableUnauthorizedAccount');

      await expect(
        impactSBT.connect(oracle).unpause()
      ).to.be.revertedWithCustomError(impactSBT, 'OwnableUnauthorizedAccount');
    });

    it('should allow status update when paused', async function () {
      const { impactSBT, owner, oracle, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      await impactSBT.connect(owner).pause();

      await impactSBT.connect(owner).updateTokenStatus(
        0, TokenStatus.Revoked, 'Project failed'
      );
      expect(await impactSBT.getTokenStatus(0)).to.equal(TokenStatus.Revoked);
    });

    it('should allow oracle transfer when paused', async function () {
      const { impactSBT, owner, oracle, newOracle } = await deployImpactSBTFixture();

      await impactSBT.connect(owner).pause();
      await impactSBT.connect(owner).transferOracleRole(newOracle.address);

      expect(await impactSBT.isOracle(newOracle.address)).to.equal(true);
    });
  });

  // ============================================================
  // TokenURI
  // ============================================================
  describe('TokenURI', function () {
    it('should return correct tokenURI', async function () {
      const { impactSBT, oracle, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmMetadata'
      );

      expect(await impactSBT.tokenURI(0)).to.equal('https://ipfs.io/ipfs/QmMetadata');
    });

    it('should revert when tokenURI for non-existent token', async function () {
      const { impactSBT } = await deployImpactSBTFixture();

      await expect(impactSBT.tokenURI(999)).to.be.revertedWithCustomError(
        impactSBT, 'TokenNotExists'
      );
    });
  });

  // ============================================================
  // locked() edge cases
  // ============================================================
  describe('locked() function edge cases', function () {
    it('should revert when checking locked status of non-existent token', async function () {
      const { impactSBT } = await deployImpactSBTFixture();

      await expect(impactSBT.locked(999)).to.be.revertedWithCustomError(
        impactSBT, 'TokenNotExists'
      );
    });
  });

  // ============================================================
  // ownerOf (inherited from ERC721)
  // ============================================================
  describe('ownerOf (inherited from ERC721)', function () {
    it('should return correct owner after minting', async function () {
      const { impactSBT, oracle, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      expect(await impactSBT.ownerOf(0)).to.equal(recipient.address);
    });

    it('should revert when ownerOf non-existent token', async function () {
      const { impactSBT } = await deployImpactSBTFixture();
      await expect(impactSBT.ownerOf(999)).to.be.revertedWithCustomError(
        impactSBT, 'ERC721NonexistentToken'
      );
    });

    it('should revert when transferring non-existent token', async function () {
      const { impactSBT, owner, otherAccount } = await deployImpactSBTFixture();

      await expect(
        impactSBT.connect(owner).transferFrom(owner.address, otherAccount.address, 999)
      ).to.be.revertedWithCustomError(impactSBT, 'ERC721NonexistentToken');
    });
  });

  // ============================================================
  // ERC-5192 Interface Support
  // ============================================================
  describe('ERC-5192 Interface Support', function () {
    it('should support ERC-5192 interface', async function () {
      const { impactSBT } = await deployImpactSBTFixture();
      expect(await impactSBT.supportsInterface('0x6a4d1d1c')).to.equal(true);
    });

    it('should support ERC-721 interface', async function () {
      const { impactSBT } = await deployImpactSBTFixture();
      expect(await impactSBT.supportsInterface('0x80ac58cd')).to.equal(true);
    });

    it('should support AccessControl interface', async function () {
      const { impactSBT } = await deployImpactSBTFixture();
      expect(await impactSBT.supportsInterface('0x7965db0b')).to.equal(true);
    });
  });

  // ============================================================
  // Multi-oracle scenario
  // ============================================================
  describe('Multi-Oracle Scenario', function () {
    // Known accepted contract behavior: ORACLE_ROLE is intentionally multi-holder at contract level;
    // signer isolation, rotation and grant alerts are enforced by deployment operations.
    it('should have multiple oracles after adding role directly', async function () {
      const { impactSBT, owner, oracle, newOracle, recipient, ethers } = await deployImpactSBTFixture();

      const ORACLE_ROLE = await impactSBT.ORACLE_ROLE();

      // Owner grant ORACLE_ROLE to newOracle directly
      await impactSBT.connect(owner).grantRole(
        ORACLE_ROLE, newOracle.address
      );

      expect(await impactSBT.isOracle(oracle.address)).to.equal(true);
      expect(await impactSBT.isOracle(newOracle.address)).to.equal(true);

      // Both should be able to mint
      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 50,
        '10.776043,106.642754', 'QmAaa...', 'https://ipfs.io/ipfs/QmAaa...'
      );
      await impactSBT.connect(newOracle).mint(
        oracle.address, 2, 1, 75,
        '10.776044,106.642755', 'QmBbb...', 'https://ipfs.io/ipfs/QmBbb...'
      );

      expect(await impactSBT.totalSupply()).to.equal(2);
    });

    it('should revoke oracle role correctly', async function () {
      const { impactSBT, owner, oracle, newOracle } = await deployImpactSBTFixture();

      const ORACLE_ROLE = await impactSBT.ORACLE_ROLE();

      await impactSBT.connect(owner).grantRole(
        ORACLE_ROLE, newOracle.address
      );
      await impactSBT.connect(owner).revokeRole(
        ORACLE_ROLE, oracle.address
      );

      expect(await impactSBT.isOracle(oracle.address)).to.equal(false);
      expect(await impactSBT.isOracle(newOracle.address)).to.equal(true);
    });
  });

  // ============================================================
  // Gas & Efficiency
  // ============================================================
  describe('Gas & Efficiency', function () {
    it('should use reasonable gas for minting (under 320k gas)', async function () {
      const { impactSBT, oracle, recipient } = await deployImpactSBTFixture();

      const mintTx = await impactSBT.connect(oracle).mint(
        recipient.address,
        1,      // projectId
        1,      // milestone
        100,    // beneficiaryCount
        '10.776043,106.642754',
        'QmXxx...',
        'https://ipfs.io/ipfs/QmXxx...'
      );

      const receipt = await mintTx.wait(1);
      expect(receipt.gasUsed).to.be.lessThan(320000n);
    });

    it('should use reasonable gas for status update (under 70k gas)', async function () {
      const { impactSBT, oracle, owner, recipient } = await deployImpactSBTFixture();

      // Mint first
      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      // Update status by owner
      const updateTx = await impactSBT.connect(owner).updateTokenStatus(
        0, TokenStatus.Frozen, 'Emergency freeze'
      );

      const receipt = await updateTx.wait(1);
      expect(receipt.gasUsed).to.be.lessThan(70000n);
    });

    it('should use reasonable gas for oracle transfer (under 70k gas)', async function () {
      const { impactSBT, owner, oracle, newOracle } = await deployImpactSBTFixture();

      const transferTx = await impactSBT.connect(owner).transferOracleRole(newOracle.address);

      const receipt = await transferTx.wait(1);
      expect(receipt.gasUsed).to.be.lessThan(70000n);
    });
  });

  // ============================================================
  // AccessControl Granularity
  // ============================================================
  describe('AccessControl Granularity', function () {
    it('should only allow owner to pause/unpause', async function () {
      const { impactSBT, owner, oracle, otherAccount } = await deployImpactSBTFixture();

      // Owner should be able to pause
      await impactSBT.connect(owner).pause();
      expect(await impactSBT.paused()).to.equal(true);

      // Owner should be able to unpause
      await impactSBT.connect(owner).unpause();
      expect(await impactSBT.paused()).to.equal(false);
    });

    it('should only allow owner to transfer oracle role', async function () {
      const { impactSBT, owner, oracle, newOracle } = await deployImpactSBTFixture();

      // Owner can transfer
      await impactSBT.connect(owner).transferOracleRole(newOracle.address);
      expect(await impactSBT.isOracle(newOracle.address)).to.equal(true);

      // Transfer back for next test
      await impactSBT.connect(owner).transferOracleRole(oracle.address);
    });

    // Known accepted contract behavior: both ORACLE_ROLE and owner may update token status.
    // Do not silently narrow this permission in backend code; upgrade the contract via a separate ADR.
    it('should allow both oracle and owner to updateTokenStatus', async function () {
      const { impactSBT, oracle, owner, recipient } = await deployImpactSBTFixture();

      // Mint a token
      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      // Oracle can update
      await impactSBT.connect(oracle).updateTokenStatus(0, TokenStatus.Frozen, 'Oracle freeze');
      expect(await impactSBT.getTokenStatus(0)).to.equal(TokenStatus.Frozen);

      // Owner can update
      await impactSBT.connect(owner).updateTokenStatus(0, TokenStatus.Revoked, 'Owner revoke');
      expect(await impactSBT.getTokenStatus(0)).to.equal(TokenStatus.Revoked);
    });

    it('should not allow oracle to pause/unpause', async function () {
      const { impactSBT, oracle, owner } = await deployImpactSBTFixture();

      // Oracle cannot pause
      await expect(
        impactSBT.connect(oracle).pause()
      ).to.be.revertedWithCustomError(impactSBT, 'OwnableUnauthorizedAccount');

      // Deploy fresh contract for unpause test
      const { impactSBT: freshSBT } = await deployImpactSBTFixture();
      await freshSBT.connect(owner).pause();

      // Oracle cannot unpause
      await expect(
        freshSBT.connect(oracle).unpause()
      ).to.be.revertedWithCustomError(freshSBT, 'OwnableUnauthorizedAccount');
    });

    it('should not allow oracle to transfer oracle role', async function () {
      const { impactSBT, oracle, owner, newOracle } = await deployImpactSBTFixture();

      // Oracle cannot transfer oracle role
      await expect(
        impactSBT.connect(oracle).transferOracleRole(newOracle.address)
      ).to.be.revertedWithCustomError(impactSBT, 'OwnableUnauthorizedAccount');
    });
  });

  // ============================================================
  // Token Supply & Enumeration
  // ============================================================
  describe('Token Supply & Enumeration', function () {
    it('should increment totalSupply after each mint', async function () {
      const { impactSBT, oracle, recipient, otherAccount } = await deployImpactSBTFixture();

      expect(await impactSBT.totalSupply()).to.equal(0);

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 50,
        '10.776043,106.642754', 'QmAaa...', 'https://ipfs.io/ipfs/QmAaa...'
      );
      expect(await impactSBT.totalSupply()).to.equal(1);

      await impactSBT.connect(oracle).mint(
        otherAccount.address, 2, 1, 75,
        '10.776044,106.642755', 'QmBbb...', 'https://ipfs.io/ipfs/QmBbb...'
      );
      expect(await impactSBT.totalSupply()).to.equal(2);

      await impactSBT.connect(oracle).mint(
        recipient.address, 3, 1, 100,
        '10.776045,106.642756', 'QmCcc...', 'https://ipfs.io/ipfs/QmCcc...'
      );
      expect(await impactSBT.totalSupply()).to.equal(3);
    });

    it('should have correct balance after multiple mints to same address', async function () {
      const { impactSBT, oracle, recipient } = await deployImpactSBTFixture();

      expect(await impactSBT.balanceOf(recipient.address)).to.equal(0);

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 50,
        '10.776043,106.642754', 'QmAaa...', 'https://ipfs.io/ipfs/QmAaa...'
      );
      expect(await impactSBT.balanceOf(recipient.address)).to.equal(1);

      await impactSBT.connect(oracle).mint(
        recipient.address, 2, 1, 75,
        '10.776044,106.642755', 'QmBbb...', 'https://ipfs.io/ipfs/QmBbb...'
      );
      expect(await impactSBT.balanceOf(recipient.address)).to.equal(2);
    });
  });

  // ============================================================
  // Miscellaneous Edge Cases
  // ============================================================
  describe('Miscellaneous Edge Cases', function () {
    it('should revert mint when contract is paused', async function () {
      const { impactSBT, owner, oracle, recipient } = await deployImpactSBTFixture();

      // Pause the contract
      await impactSBT.connect(owner).pause();

      // Mint should revert with EnforcedPause
      await expect(
        impactSBT.connect(oracle).mint(
          recipient.address, 1, 1, 100,
          '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
        )
      ).to.be.revertedWithCustomError(impactSBT, 'EnforcedPause');
    });

    it('should allow status update when contract is paused', async function () {
      const { impactSBT, oracle, owner, recipient } = await deployImpactSBTFixture();

      // Mint first
      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      // Pause contract
      await impactSBT.connect(owner).pause();

      // Status update should still work
      await impactSBT.connect(owner).updateTokenStatus(0, TokenStatus.Revoked, 'Project failed');
      expect(await impactSBT.getTokenStatus(0)).to.equal(TokenStatus.Revoked);
    });

    it('should allow oracle transfer when contract is paused', async function () {
      const { impactSBT, owner, oracle, newOracle } = await deployImpactSBTFixture();

      // Pause contract
      await impactSBT.connect(owner).pause();

      // Oracle transfer should still work
      await impactSBT.connect(owner).transferOracleRole(newOracle.address);
      expect(await impactSBT.isOracle(newOracle.address)).to.equal(true);
    });

    it('should handle empty string gpsCoordinates', async function () {
      const { impactSBT, oracle, recipient } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '',            // empty gpsCoordinates - this is valid per spec (GPS EXIF strip case)
        'QmXxx...',
        'https://ipfs.io/ipfs/QmXxx...'
      );

      const metadata = await impactSBT.getTokenMetadata(0);
      expect(metadata.gpsCoordinates).to.equal('');
    });

    it('should revert when minting with empty imageCID', async function () {
      const { impactSBT, oracle, recipient } = await deployImpactSBTFixture();

      await expect(
        impactSBT.connect(oracle).mint(
          recipient.address, 1, 1, 100,
          '10.776043,106.642754', '', 'https://ipfs.io/ipfs/QmXxx...'
        )
      ).to.be.revertedWithCustomError(impactSBT, 'EmptyImageCID');
    });

    it('should revert when minting with empty tokenURI', async function () {
      const { impactSBT, oracle, recipient } = await deployImpactSBTFixture();

      await expect(
        impactSBT.connect(oracle).mint(
          recipient.address, 1, 1, 100,
          '10.776043,106.642754', 'QmXxx...', ''
        )
      ).to.be.revertedWithCustomError(impactSBT, 'EmptyTokenURI');
    });

    it('should allow minting with empty gpsCoordinates (GPS EXIF strip case)', async function () {
      const { impactSBT, oracle, owner } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        owner.address, 1, 1, 5, '', 'QmTest1', 'ipfs://example1'
      );

      // Verify mint succeeded
      expect(await impactSBT.totalSupply()).to.equal(1);
    });

    it('should still prevent transfer after Revoked (soulbound forever)', async function () {
      const { impactSBT, oracle, owner, recipient, otherAccount } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      await impactSBT.connect(owner).updateTokenStatus(
        0, TokenStatus.Revoked, 'Project failed'
      );

      // Soulbound forever — even after Revoked, transfer is still blocked
      await expect(
        impactSBT.connect(recipient).transferFrom(recipient.address, otherAccount.address, 0)
      ).to.be.revertedWithCustomError(impactSBT, 'TokenLocked');
    });

    it('should still prevent transfer after Burned (soulbound forever)', async function () {
      const { impactSBT, oracle, owner, recipient, otherAccount } = await deployImpactSBTFixture();

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754', 'QmXxx...', 'https://ipfs.io/ipfs/QmXxx...'
      );

      await impactSBT.connect(owner).updateTokenStatus(
        0, TokenStatus.Burned, 'Burned by owner'
      );

      // Soulbound forever — even after Burned, transfer is still blocked
      await expect(
        impactSBT.connect(recipient).transferFrom(recipient.address, otherAccount.address, 0)
      ).to.be.revertedWithCustomError(impactSBT, 'TokenLocked');
    });

    it('should handle very long imageCID', async function () {
      const { impactSBT, oracle, recipient } = await deployImpactSBTFixture();

      // Create a very long CID (simulating IPFS CIDv1)
      const longCid = 'Qm' + 'a'.repeat(100);
      const longTokenUri = 'https://ipfs.io/ipfs/' + longCid;

      await impactSBT.connect(oracle).mint(
        recipient.address, 1, 1, 100,
        '10.776043,106.642754',
        longCid,
        longTokenUri
      );

      const metadata = await impactSBT.getTokenMetadata(0);
      expect(metadata.imageCID).to.equal(longCid);
    });
  });
});
