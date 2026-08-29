const { config } = require('dotenv');
const { ethers } = require('ethers');

config();

const MULTISIG_ABI = [
  'function ADMIN_SIGNER_ROLE() view returns (bytes32)',
  'function ORG_SIGNER_ROLE() view returns (bytes32)',
  'function REGULATORY_SIGNER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32,address) view returns (bool)',
  'function grantAdminSignerRole(address) external',
  'function grantOrgSignerRole(address) external',
  'function grantRegulatorySignerRole(address) external'
];

/** Đọc biến bắt buộc mà không in private key ra terminal. */
function getRequiredEnvironmentVariable(variableName) {
  const value = String(process.env[variableName] || '').trim();
  if (!value) throw new Error(`Thiếu biến môi trường: ${variableName}`);
  return value;
}

/** Cấp role nếu thiếu rồi đọc lại chain để script có thể chạy lặp lại an toàn. */
async function ensureRole(contract, roleHash, signerAddress, grantMethod) {
  if (await contract.hasRole(roleHash, signerAddress)) return null;
  const transaction = await contract[grantMethod](signerAddress);
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1 || !await contract.hasRole(roleHash, signerAddress)) throw new Error(`Cấp role ${grantMethod} thất bại.`);
  return transaction.hash;
}

/** Cấp và kiểm tra ba vai kỹ thuật độc lập, tránh lỗi AlreadySigned khi một ví cố ký hai vai. */
async function provisionDisbursementServiceSigners() {
  const provider = new ethers.JsonRpcProvider(getRequiredEnvironmentVariable('BLOCKCHAIN_RPC_URL'));
  const administrator = new ethers.Wallet(getRequiredEnvironmentVariable('DONATION_ADMIN_PRIVATE_KEY'), provider);
  const contract = new ethers.Contract(getRequiredEnvironmentVariable('MULTISIG_DISBURSEMENT_ADDRESS'), MULTISIG_ABI, administrator);
  const signerDefinitions = [
    { name: 'ADMIN', keyVariable: 'DISBURSEMENT_SERVICE_SIGNER_ADMIN_KEY', roleGetter: 'ADMIN_SIGNER_ROLE', grantMethod: 'grantAdminSignerRole' },
    { name: 'ORG', keyVariable: 'DISBURSEMENT_SERVICE_SIGNER_ORG_KEY', roleGetter: 'ORG_SIGNER_ROLE', grantMethod: 'grantOrgSignerRole' },
    { name: 'REGULATORY', keyVariable: 'DISBURSEMENT_SERVICE_SIGNER_REGULATORY_KEY', roleGetter: 'REGULATORY_SIGNER_ROLE', grantMethod: 'grantRegulatorySignerRole' }
  ];
  const signerEntries = signerDefinitions.map(definition => ({ ...definition, wallet: new ethers.Wallet(getRequiredEnvironmentVariable(definition.keyVariable), provider) }));
  const addresses = await Promise.all(signerEntries.map(entry => entry.wallet.getAddress()));
  if (new Set(addresses.map(address => address.toLowerCase())).size !== signerEntries.length) throw new Error('Ba ví kỹ thuật phải là ba địa chỉ khác nhau.');

  for (let index = 0; index < signerEntries.length; index += 1) {
    const entry = signerEntries[index];
    const address = addresses[index];
    const roleHash = await contract[entry.roleGetter]();
    const transactionHash = await ensureRole(contract, roleHash, address, entry.grantMethod);
    const roleChecks = await Promise.all([
      contract.hasRole(await contract.ADMIN_SIGNER_ROLE(), address),
      contract.hasRole(await contract.ORG_SIGNER_ROLE(), address),
      contract.hasRole(await contract.REGULATORY_SIGNER_ROLE(), address)
    ]);
    if (roleChecks.filter(Boolean).length !== 1 || !roleChecks[index]) throw new Error(`Ví ${entry.name} không có đúng một role kỹ thuật.`);
    console.log(JSON.stringify({ role: entry.name, address, grantedTransactionHash: transactionHash, verified: true }));
  }
}

provisionDisbursementServiceSigners().catch(error => { console.error('Provision signer giải ngân thất bại:', error.message); process.exitCode = 1; });
