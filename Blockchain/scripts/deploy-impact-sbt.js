import '@nomicfoundation/hardhat-ethers';
import hardhatRuntimeEnvironment from 'hardhat';
import { ethers } from 'ethers';
import fileSystem from 'node:fs/promises';
import path from 'node:path';

/**
 * Ham lay Hardhat runtime theo dinh dang export hien tai.
 * Muc dich: dam bao truy cap `network` va `artifacts` on dinh.
 */
function getHardhatRuntime() {
  const runtimeModule = hardhatRuntimeEnvironment ?? {};
  return runtimeModule.default ?? runtimeModule;
}

/**
 * Ham lay bien moi truong bat buoc.
 * Muc dich: dung deploy ngay khi thieu cau hinh quan trong.
 */
function getRequiredEnvironmentVariable(variableName) {
  const variableValue = process.env[variableName]?.trim();

  if (!variableValue) {
    throw new Error(`Thieu bien moi truong bat buoc: ${variableName}`);
  }

  return variableValue;
}

/**
 * Ham lay RPC URL theo network hien tai.
 * Muc dich: uu tien localhost khi chay local, con lai dung AMOY_RPC_URL.
 */
function resolveRpcUrl(networkName) {
  if (networkName === 'localhost' || networkName === 'hardhat') {
    return 'http://127.0.0.1:8545';
  }

  return getRequiredEnvironmentVariable('AMOY_RPC_URL');
}

/**
 * Ham khoi tao vi deployer tu private key.
 * Muc dich: tao signer de deploy contract va cap quyen sau deploy.
 */
function createDeployerSigner(networkName) {
  const deployerPrivateKey = getRequiredEnvironmentVariable('DEPLOYER_PRIVATE_KEY');
  const rpcUrl = resolveRpcUrl(networkName);
  const jsonRpcProvider = new ethers.JsonRpcProvider(rpcUrl);

  return new ethers.Wallet(deployerPrivateKey, jsonRpcProvider);
}

/**
 * Ham kiem tra xem co can xac minh contract tren explorer khong.
 * Muc dich: chi xac minh tren cac network thuc (khong phai local).
 */
function shouldVerifyContract(networkName) {
  const nonLocalNetworks = ['amoy', 'polygon', 'mainnet', 'matic'];
  return nonLocalNetworks.includes(networkName.toLowerCase());
}

/**
 * Ham xac minh contract tren Polygonscan/Amoy explorer.
 * Muc dich: cong khai ma nguon tren explorer de nguoi dung kiem tra.
 */
async function verifyContractOnExplorer(contractAddress, constructorArguments) {
  const hardhatRuntime = getHardhatRuntime();
  const networkName = process.env.HARDHAT_NETWORK ?? hardhatRuntime.network?.name ?? 'unknown';

  try {
    console.log('\n--- Verifying contract on explorer ---');
    const hre = await import('hardhat');
    await hre.default.run('verify:verify', {
      address: contractAddress,
      constructorArguments: constructorArguments
    });
    console.log(`✅ Contract verified on ${networkName} explorer`);
  } catch (error) {
    // Neu qua som (chuong trinh chua kip index), co gang lai sau
    if (error.message.includes('Already verified') || error.message.includes('already verified')) {
      console.log('ℹ️  Contract already verified');
    } else {
      console.warn(`⚠️  Verification failed (contract may still be indexed): ${error.message}`);
    }
  }
}

/**
 * Ham in huong dan sau khi deploy thanh cong.
 * Muc dich: giup nguoi dung biet cac buoc tiep theo.
 */
function printDeploymentInstructions(contractAddress, networkName) {
  console.log('\n========================================');
  console.log('🚀 DEPLOYMENT INSTRUCTIONS');
  console.log('========================================');
  console.log(`\n📍 Contract Address: ${contractAddress}`);
  console.log(`🌐 Network: ${networkName}`);

  console.log('\n📋 Next Steps:');
  console.log('1. Update your BE .env file with:');
  console.log(`   IMPACT_SBT_ADDRESS=${contractAddress}`);

  console.log('\n2. View contract on explorer:');
  if (networkName === 'amoy') {
    console.log(`   https://www.oklink.com/amoy/address/${contractAddress}`);
  } else {
    console.log(`   https://polygonscan.com/address/${contractAddress}`);
  }

  console.log('\n3. Verify contract on explorer:');
  if (networkName === 'amoy') {
    console.log(`   https://www.oklink.com/amoy/address/${contractAddress}#code`);
  } else {
    console.log(`   https://polygonscan.com/address/${contractAddress}#code`);
  }

  console.log('\n========================================\n');
}

/**
 * Ham deploy ImpactSBT contract.
 * Muc dich: tao Impact SBT voi dia chi Oracle duoc cau hinh.
 */
async function deployImpactSBT() {
  const hardhatRuntime = getHardhatRuntime();
  const networkName = process.env.HARDHAT_NETWORK ?? hardhatRuntime.network?.name ?? 'unknown';
  const deployerSigner = createDeployerSigner(networkName);
  const deployerAddress = await deployerSigner.getAddress();

  const oracleAddress = getRequiredEnvironmentVariable('ORACLE_ADDRESS');

  console.log('\n========================================');
  console.log('🚀 IMPACT SBT DEPLOYMENT');
  console.log('========================================');
  console.log(`\n📡 Network:            ${networkName}`);
  console.log(`👤 Deployer:           ${deployerAddress}`);
  console.log(`🔮 Oracle:             ${oracleAddress}`);

  const impactSBTArtifact = await hardhatRuntime.artifacts.readArtifact('ImpactSBT');
  const impactSBTFactory = new ethers.ContractFactory(
    impactSBTArtifact.abi,
    impactSBTArtifact.bytecode,
    deployerSigner
  );

  console.log('\n📦 Deploying contract...');
  const impactSBTContract = await impactSBTFactory.deploy(oracleAddress);

  await impactSBTContract.waitForDeployment();
  const impactSBTAddress = await impactSBTContract.getAddress();
  console.log(`\n✅ ImpactSBT deployed:  ${impactSBTAddress}`);

  // Luu deployment info
  const deploymentFilePath = path.join(process.cwd(), 'deployments', `${networkName}.json`);

  let existingDeployment = {};
  try {
    const existingDeploymentRaw = await fileSystem.readFile(deploymentFilePath, 'utf-8');
    existingDeployment = JSON.parse(existingDeploymentRaw.trim());
  } catch {
    // Khong co file cu thi tao moi.
  }

  const deploymentOutput = {
    ...existingDeployment,
    network: networkName,
    deployedAt: new Date().toISOString(),
    deployerAddress,
    impactSBTAddress
  };

  await fileSystem.mkdir(path.dirname(deploymentFilePath), { recursive: true });
  await fileSystem.writeFile(deploymentFilePath, `${JSON.stringify(deploymentOutput, null, 2)}\n`, 'utf-8');

  console.log(`\n💾 Deployment info saved: ${deploymentFilePath}`);

  // Xac minh contract tren explorer neu la network thuc
  if (shouldVerifyContract(networkName)) {
    await verifyContractOnExplorer(impactSBTAddress, [oracleAddress]);
  }

  // In huong dan sau deploy
  printDeploymentInstructions(impactSBTAddress, networkName);

  return impactSBTAddress;
}

deployImpactSBT().catch((errorObject) => {
  console.error('\n❌ Deploy failed:', errorObject.message);
  process.exitCode = 1;
});
