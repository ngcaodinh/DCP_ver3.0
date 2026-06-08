import '@nomicfoundation/hardhat-ethers';
import hardhatRuntimeEnvironment from 'hardhat';
import { ethers } from 'ethers';
import fileSystem from 'node:fs/promises';
import path from 'node:path';

/**
 * Hàm lấy Hardhat runtime theo định dạng export hiện tại.
 * Mục đích: đảm bảo truy cập `network` và `artifacts` ổn định.
 */
function getHardhatRuntime() {
  const runtimeModule = hardhatRuntimeEnvironment ?? {};
  return runtimeModule.default ?? runtimeModule;
}

/**
 * Hàm lấy biến môi trường bắt buộc.
 * Mục đích: dừng deploy ngay khi thiếu cấu hình quan trọng.
 */
function getRequiredEnvironmentVariable(variableName) {
  const variableValue = process.env[variableName]?.trim();

  if (!variableValue) {
    throw new Error(`Thiếu biến môi trường bắt buộc: ${variableName}`);
  }

  return variableValue;
}

/**
 * Hàm lấy RPC URL theo network hiện tại.
 * Mục đích: ưu tiên localhost khi chạy local, còn lại dùng AMOY_RPC_URL.
 */
function resolveRpcUrl(networkName) {
  if (networkName === 'localhost' || networkName === 'hardhat') {
    return 'http://127.0.0.1:8545';
  }

  return getRequiredEnvironmentVariable('AMOY_RPC_URL');
}

/**
 * Hàm khởi tạo ví deployer từ private key.
 * Mục đích: tạo signer để deploy contract và cấp quyền sau deploy.
 */
function createDeployerSigner(networkName) {
  const deployerPrivateKey = getRequiredEnvironmentVariable('DEPLOYER_PRIVATE_KEY');
  const rpcUrl = resolveRpcUrl(networkName);
  const jsonRpcProvider = new ethers.JsonRpcProvider(rpcUrl);

  return new ethers.Wallet(deployerPrivateKey, jsonRpcProvider);
}

/**
 * Hàm lấy địa chỉ signer cho từng vai trò multisig.
 * Mục đích: bắt buộc khai báo signer trên Amoy để tránh deploy sai cấu hình.
 */
function getMultisigSignerAddress(environmentVariableName, deployerAddress, networkName) {
  const configuredAddress = process.env[environmentVariableName]?.trim();

  if (configuredAddress) {
    return configuredAddress;
  }

  // Chỉ cho phép fallback deployer khi chạy local để tiện test nhanh.
  if (networkName === 'localhost' || networkName === 'hardhat') {
    return deployerAddress;
  }

  throw new Error(`Thiếu biến môi trường signer: ${environmentVariableName}`);
}

/**
 * Hàm deploy duy nhất contract MultisigDisbursement.
 * Mục đích: không deploy lại DcpCharityToken và DcpDonationRanking đã có sẵn.
 */
async function deployMultisigDisbursementOnly() {
  const hardhatRuntime = getHardhatRuntime();
  const networkName = process.env.HARDHAT_NETWORK ?? hardhatRuntime.network?.name ?? 'unknown';
  const deployerSigner = createDeployerSigner(networkName);
  const deployerAddress = await deployerSigner.getAddress();

  const charityTokenAddress = getRequiredEnvironmentVariable('CHARITY_TOKEN_ADDRESS');
  const donationRankingAddress = getRequiredEnvironmentVariable('DONATION_RANKING_ADDRESS');

  const adminSignerAddress = getMultisigSignerAddress(
    'MULTISIG_ADMIN_SIGNER_ADDRESS',
    deployerAddress,
    networkName
  );
  const organizationSignerAddress = getMultisigSignerAddress(
    'MULTISIG_ORG_SIGNER_ADDRESS',
    deployerAddress,
    networkName
  );
  const regulatorySignerAddress = getMultisigSignerAddress(
    'MULTISIG_REGULATORY_SIGNER_ADDRESS',
    deployerAddress,
    networkName
  );

  console.log('\n=== Deploy MultisigDisbursement only ===');
  console.log(`Network:            ${networkName}`);
  console.log(`Deployer:           ${deployerAddress}`);
  console.log(`CharityToken:       ${charityTokenAddress}`);
  console.log(`DonationRanking:    ${donationRankingAddress}`);
  console.log(`Admin Signer:       ${adminSignerAddress}`);
  console.log(`Organization Signer:${organizationSignerAddress}`);
  console.log(`Regulatory Signer:  ${regulatorySignerAddress}`);

  const multisigArtifact = await hardhatRuntime.artifacts.readArtifact('MultisigDisbursement');
  const multisigFactory = new ethers.ContractFactory(
    multisigArtifact.abi,
    multisigArtifact.bytecode,
    deployerSigner
  );

  const multisigContract = await multisigFactory.deploy(
    charityTokenAddress,
    donationRankingAddress,
    adminSignerAddress,
    organizationSignerAddress,
    regulatorySignerAddress
  );

  await multisigContract.waitForDeployment();
  const multisigDisbursementAddress = await multisigContract.getAddress();
  console.log(`\n✅ MultisigDisbursement deployed: ${multisigDisbursementAddress}`);

  // Cấp DISBURSEMENT_ROLE để multisig mới có thể gọi burnForDisbursement().
  const charityTokenArtifact = await hardhatRuntime.artifacts.readArtifact('DcpCharityToken');
  const charityTokenContract = new ethers.Contract(
    charityTokenAddress,
    charityTokenArtifact.abi,
    deployerSigner
  );
  const grantRoleTransaction = await charityTokenContract.grantDisbursementRole(multisigDisbursementAddress);
  await grantRoleTransaction.wait();
  console.log('✅ Granted DISBURSEMENT_ROLE to new MultisigDisbursement.');

  const deploymentFilePath = path.join(process.cwd(), 'deployments', `${networkName}.json`);

  let existingDeployment = {};
  try {
    const existingDeploymentRaw = await fileSystem.readFile(deploymentFilePath, 'utf-8');
    existingDeployment = JSON.parse(existingDeploymentRaw.trim());
  } catch {
    // Không có file cũ thì tạo mới.
  }

  const deploymentOutput = {
    ...existingDeployment,
    network: networkName,
    deployedAt: new Date().toISOString(),
    deployerAddress,
    charityTokenAddress: existingDeployment.charityTokenAddress ?? charityTokenAddress,
    donationRankingAddress: existingDeployment.donationRankingAddress ?? donationRankingAddress,
    multisigDisbursementAddress,
    signerRoles: {
      adminSigner: adminSignerAddress,
      orgSigner: organizationSignerAddress,
      regulatorySigner: regulatorySignerAddress
    }
  };

  await fileSystem.mkdir(path.dirname(deploymentFilePath), { recursive: true });
  await fileSystem.writeFile(deploymentFilePath, `${JSON.stringify(deploymentOutput, null, 2)}\n`, 'utf-8');

  console.log(`✅ Deployment info saved: ${deploymentFilePath}`);
  console.log(`✅ Update BE env MULTISIG_DISBURSEMENT_ADDRESS=${multisigDisbursementAddress}`);
}

deployMultisigDisbursementOnly().catch((errorObject) => {
  console.error('\n❌ Deploy failed:', errorObject.message);
  process.exitCode = 1;
});

