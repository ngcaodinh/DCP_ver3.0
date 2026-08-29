import hardhatRuntimeEnvironment from 'hardhat';
import { ethers } from 'ethers';
import fileSystem from 'node:fs/promises';
import path from 'node:path';

/** Lấy Hardhat runtime tương thích với định dạng export hiện tại. */
function getHardhatRuntime() {
  const runtimeModule = hardhatRuntimeEnvironment ?? {};
  return runtimeModule.default ?? runtimeModule;
}

/** Đọc biến môi trường bắt buộc và dừng sớm khi cấu hình deploy chưa đầy đủ. */
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

/** Tạo signer deploy mà không bao giờ ghi private key vào log hay artifact. */
function createDeployerSigner(networkName) {
  return new ethers.Wallet(
    getRequiredEnvironmentVariable('DEPLOYER_PRIVATE_KEY'),
    new ethers.JsonRpcProvider(resolveRpcUrl(networkName))
  );
}

/** Chỉ verify source trên network public để không làm local deployment phụ thuộc explorer. */
function shouldVerifyContract(networkName) {
  return ['amoy', 'polygon', 'mainnet', 'matic'].includes(networkName.toLowerCase());
}

/** Verify source theo best-effort vì lỗi explorer không được làm mất thông tin deploy thành công. */
async function verifyContractOnExplorer(contractAddress, constructorArguments) {
  try {
    const hardhatModule = await import('hardhat');
    await hardhatModule.default.run('verify:verify', { address: contractAddress, constructorArguments });
    console.log('CommitteeGovernance đã được xác minh trên explorer.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Không thể xác minh ngay trên explorer: ${message}`);
  }
}

/** Deploy contract governance không giữ tiền, lưu deployment checkpoint và in hướng dẫn bootstrap ghế an toàn. */
async function deployCommitteeGovernance() {
  const hardhatRuntime = getHardhatRuntime();
  const networkName = process.env.HARDHAT_NETWORK ?? hardhatRuntime.network?.name ?? 'unknown';
  const deployerSigner = createDeployerSigner(networkName);
  const deployerAddress = await deployerSigner.getAddress();
  const artifact = await hardhatRuntime.artifacts.readArtifact('CommitteeGovernance');
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployerSigner);
  const contract = await factory.deploy(deployerAddress);
  const deploymentTransaction = contract.deploymentTransaction();
  const receipt = deploymentTransaction ? await deploymentTransaction.wait() : null;
  const committeeGovernanceAddress = await contract.getAddress();

  const deployment = {
    network: networkName,
    deployedAt: new Date().toISOString(),
    deployerAddress,
    committeeGovernanceAddress,
    bootstrapAdmin: deployerAddress,
    deployBlock: receipt?.blockNumber ?? null,
    deploymentTransactionHash: deploymentTransaction?.hash ?? null
  };
  const deploymentPath = path.join(process.cwd(), 'deployments', `${networkName}-committee-governance.json`);
  await fileSystem.mkdir(path.dirname(deploymentPath), { recursive: true });
  await fileSystem.writeFile(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`, 'utf-8');

  console.log(`CommitteeGovernance deployed: ${committeeGovernanceAddress}`);
  console.log(`Deployment info saved: ${deploymentPath}`);
  console.log(`Cập nhật BE/.env: COMMITTEE_GOVERNANCE_ADDRESS=${committeeGovernanceAddress}`);
  console.log('Chỉ gọi bootstrapSeats sau khi năm ví ghế đã đăng nhập thử và có người thứ hai đối chiếu.');

  if (shouldVerifyContract(networkName)) {
    await verifyContractOnExplorer(committeeGovernanceAddress, [deployerAddress]);
  }
}

deployCommitteeGovernance().catch((error) => {
  console.error(`Deploy CommitteeGovernance thất bại: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
