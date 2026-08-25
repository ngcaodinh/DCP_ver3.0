import hardhatRuntimeEnvironment from 'hardhat';
import { ethers } from 'ethers';
import fileSystem from 'node:fs/promises';
import path from 'node:path';

/** Lấy Hardhat runtime tương thích với định dạng export hiện tại. */
function getHardhatRuntime() {
  const runtimeModule = hardhatRuntimeEnvironment ?? {};
  return runtimeModule.default ?? runtimeModule;
}

/** Đọc biến môi trường bắt buộc và dừng sớm khi cấu hình thiếu. */
function getRequiredEnvironmentVariable(variableName) {
  const variableValue = process.env[variableName]?.trim();
  if (!variableValue) {
    throw new Error(`Thiếu biến môi trường bắt buộc: ${variableName}`);
  }

  return variableValue;
}

/** Xác định RPC phù hợp cho network deploy hiện tại. */
function resolveRpcUrl(networkName) {
  if (networkName === 'localhost' || networkName === 'hardhat') {
    return 'http://127.0.0.1:8545';
  }

  return getRequiredEnvironmentVariable('AMOY_RPC_URL');
}

/** Tạo signer deploy mà không bao giờ đưa private key vào log. */
function createDeployerSigner(networkName) {
  return new ethers.Wallet(
    getRequiredEnvironmentVariable('DEPLOYER_PRIVATE_KEY'),
    new ethers.JsonRpcProvider(resolveRpcUrl(networkName))
  );
}

/** Quyết định network nào cần xác minh source code trên explorer. */
function shouldVerifyContract(networkName) {
  return ['amoy', 'polygon', 'mainnet', 'matic'].includes(networkName.toLowerCase());
}

/** Xác minh source code, nhưng không biến lỗi index explorer thành lỗi deploy. */
async function verifyContractOnExplorer(contractAddress, constructorArguments) {
  try {
    const hardhatModule = await import('hardhat');
    await hardhatModule.default.run('verify:verify', { address: contractAddress, constructorArguments });
    console.log('✅ AuditorStaking đã được xác minh trên explorer.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️ Không thể xác minh ngay trên explorer: ${message}`);
  }
}

/** Deploy AuditorStaking và lưu block checkpoint khởi tạo cho worker backend. */
async function deployAuditorStaking() {
  const hardhatRuntime = getHardhatRuntime();
  const networkName = process.env.HARDHAT_NETWORK ?? hardhatRuntime.network?.name ?? 'unknown';
  const deployerSigner = createDeployerSigner(networkName);
  const deployerAddress = await deployerSigner.getAddress();
  const stakeTokenAddress = getRequiredEnvironmentVariable('CHARITY_TOKEN_CONTRACT_ADDRESS');
  const slasherAddress = getRequiredEnvironmentVariable('AUDITOR_STAKING_SLASHER_ADDRESS');
  const treasuryAddress = getRequiredEnvironmentVariable('AUDITOR_STAKING_TREASURY_ADDRESS');
  const initialThreshold = BigInt(process.env.AUDITOR_STAKE_INITIAL_THRESHOLD?.trim() || '3000000');

  if (initialThreshold <= 0n) {
    throw new Error('AUDITOR_STAKE_INITIAL_THRESHOLD phải lớn hơn 0.');
  }

  const artifact = await hardhatRuntime.artifacts.readArtifact('AuditorStaking');
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployerSigner);
  const contract = await factory.deploy(stakeTokenAddress, deployerAddress, initialThreshold, slasherAddress);
  const deploymentTransaction = contract.deploymentTransaction();
  const receipt = deploymentTransaction ? await deploymentTransaction.wait() : null;
  const contractAddress = await contract.getAddress();
  const defaultAdminRole = ethers.ZeroHash;
  const grantTreasuryTransaction = await contract.grantRole(defaultAdminRole, treasuryAddress);
  const grantTreasuryReceipt = await grantTreasuryTransaction.wait();
  const revokeDeployerTransaction = await contract.revokeRole(defaultAdminRole, deployerAddress);
  const revokeDeployerReceipt = await revokeDeployerTransaction.wait();

  const deployment = {
    network: networkName,
    deployedAt: new Date().toISOString(),
    deployerAddress,
    auditorStakingAddress: contractAddress,
    deployBlock: receipt?.blockNumber ?? null,
    deploymentTransactionHash: deploymentTransaction?.hash ?? null,
    adminTransfer: {
      treasuryAddress,
      grantTransactionHash: grantTreasuryReceipt?.hash ?? null,
      revokeDeployerTransactionHash: revokeDeployerReceipt?.hash ?? null
    }
  };
  const deploymentPath = path.join(process.cwd(), 'deployments', `${networkName}-auditor-staking.json`);
  await fileSystem.mkdir(path.dirname(deploymentPath), { recursive: true });
  await fileSystem.writeFile(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`, 'utf-8');

  console.log(`✅ AuditorStaking deployed: ${contractAddress}`);
  console.log(`💾 Deployment info saved: ${deploymentPath}`);
  console.log(`Cập nhật BE/.env: AUDITOR_STAKING_ADDRESS=${contractAddress}`);

  console.log(`Set AUDITOR_STAKING_DEPLOY_BLOCK=${deployment.deployBlock} in BE/.env.`);

  if (shouldVerifyContract(networkName)) {
    await verifyContractOnExplorer(contractAddress, [stakeTokenAddress, deployerAddress, initialThreshold, slasherAddress]);
  }
}

deployAuditorStaking().catch((error) => {
  console.error(`❌ Deploy AuditorStaking thất bại: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
