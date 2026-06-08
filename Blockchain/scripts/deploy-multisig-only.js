import '@nomicfoundation/hardhat-ethers';
import hardhatRuntimeEnvironment from 'hardhat';
import { ethers } from 'ethers';
import fileSystem from 'node:fs/promises';
import path from 'node:path';

/**
 * Script deploy DUY NHAT MultisigDisbursement lên Amoy.
 * KHÔNG deploy lại DcpCharityToken hay DcpDonationRanking.
 * Address của 2 contract cũ được truyền qua environment variable.
 */

/** Lấy Hardhat runtime an toàn theo định dạng export phiên bản hiện tại. */
function getHardhatRuntime() {
  const runtimeModule = hardhatRuntimeEnvironment ?? {};
  return runtimeModule.default ?? runtimeModule;
}

/** Lấy biến môi trường bắt buộc. */
function getRequiredEnv(varName) {
  const val = process.env[varName];
  if (!val) throw new Error(`Thiếu biến bắt buộc: ${varName}`);
  return val.trim();
}

/** Lấy RPC URL theo network. */
function resolveRpcUrl(networkName) {
  if (networkName === 'localhost' || networkName === 'hardhat') {
    return 'http://127.0.0.1:8545';
  }
  return getRequiredEnv('AMOY_RPC_URL');
}

/** Tạo ví deployer từ private key. */
function createDeployerSigner(networkName) {
  const privateKey = getRequiredEnv('DEPLOYER_PRIVATE_KEY');
  const rpcUrl = resolveRpcUrl(networkName);
  return new ethers.Wallet(privateKey, new ethers.JsonRpcProvider(rpcUrl));
}

async function deployMultisigDisbursement() {
  const hardhatRuntime = getHardhatRuntime();
  const networkName = process.env.HARDHAT_NETWORK ?? hardhatRuntime.network?.name ?? 'unknown';
  const deployerSigner = createDeployerSigner(networkName);
  const deployerAddress = await deployerSigner.getAddress();

  // === Lấy address contract CŨ từ env ===
  const charityTokenAddress = getRequiredEnv('CHARITY_TOKEN_ADDRESS');
  const donationRankingAddress = getRequiredEnv('DONATION_RANKING_ADDRESS');

  // === Lấy 3 signer addresses ===
  // Nếu không có env riêng → fallback về deployer (chỉ dùng khi test local)
  const getSigner = (envName, fallback) =>
    process.env[envName]?.trim() || fallback;

  const adminSigner = getSigner('MULTISIG_ADMIN_SIGNER_ADDRESS', deployerAddress);
  const orgSigner = getSigner('MULTISIG_ORG_SIGNER_ADDRESS', deployerAddress);
  const regulatorySigner = getSigner('MULTISIG_REGULATORY_SIGNER_ADDRESS', deployerAddress);

  console.log('\n=== Deploy MultisigDisbursement ===');
  console.log(`Network:           ${networkName}`);
  console.log(`Deployer:          ${deployerAddress}`);
  console.log(`CharityToken:      ${charityTokenAddress}`);
  console.log(`DonationRanking:   ${donationRankingAddress}`);
  console.log(`Admin Signer:      ${adminSigner}`);
  console.log(`Org Signer:        ${orgSigner}`);
  console.log(`Regulatory Signer: ${regulatorySigner}`);

  // === Deploy MultisigDisbursement ===
  const multisigArtifact = await hardhatRuntime.artifacts.readArtifact('MultisigDisbursement');
  const multisigFactory = new ethers.ContractFactory(
    multisigArtifact.abi,
    multisigArtifact.bytecode,
    deployerSigner
  );

  const multisigContract = await multisigFactory.deploy(
    charityTokenAddress,
    donationRankingAddress,
    adminSigner,
    orgSigner,
    regulatorySigner
  );
  await multisigContract.waitForDeployment();
  const multisigAddress = await multisigContract.getAddress();

  console.log(`\n✅ MultisigDisbursement deployed to: ${multisigAddress}`);

  // === Grant DISBURSEMENT_ROLE tren DcpCharityToken cho MultisigDisbursement ===
  // MultisigDisbursement can role nay de goi burnForDisbursement() trong finalizeDisbursement.
  console.log('\nGranting DISBURSEMENT_ROLE to MultisigDisbursement on DcpCharityToken...');
  const tokenContract = new ethers.Contract(
    charityTokenAddress,
    (await hardhatRuntime.artifacts.readArtifact('DcpCharityToken')).abi,
    deployerSigner
  );
  const grantTx = await tokenContract.grantDisbursementRole(multisigAddress);
  await grantTx.wait();
  console.log('✅ DISBURSEMENT_ROLE granted.');

  // === Ghi đè file deployment cũ để thêm multisigAddress ===
  const deploymentFilePath = path.join(process.cwd(), 'deployments', `${networkName}.json`);

  let existingDeployment = {};
  try {
    const raw = await fileSystem.readFile(deploymentFilePath, 'utf-8');
    existingDeployment = JSON.parse(raw.trim());
  } catch {
    // File không tồn tại → bắt đầu từ mới
  }

  const updatedDeployment = {
    ...existingDeployment,
    network: networkName,
    deployedAt: new Date().toISOString(),
    deployerAddress,
    charityTokenAddress: existingDeployment.charityTokenAddress || charityTokenAddress,
    donationRankingAddress: existingDeployment.donationRankingAddress || donationRankingAddress,
    multisigDisbursementAddress: multisigAddress,
    signerRoles: {
      adminSigner,
      orgSigner,
      regulatorySigner
    }
  };

  await fileSystem.mkdir(path.dirname(deploymentFilePath), { recursive: true });
  await fileSystem.writeFile(deploymentFilePath, JSON.stringify(updatedDeployment, null, 2), 'utf-8');

  console.log(`✅ Deployment info saved to: ${deploymentFilePath}`);
  console.log('\n=== DEPLOYMENT SEQUENCE ===');
  console.log('Step 1: Ran deploy-multisig-only.js (this script)');
  console.log('  - Deployed MultisigDisbursement');
  console.log('  - Granted DISBURSEMENT_ROLE on DcpCharityToken');
  console.log('\n=== NEXT STEPS ===');
  console.log('1. Update backend .env: MULTISIG_DISBURSEMENT_ADDRESS=' + multisigAddress);
  console.log('2. Restart backend to apply new address');
}

deployMultisigDisbursement().catch((error) => {
  console.error('\n❌ Deploy failed:', error.message);
  process.exitCode = 1;
});
