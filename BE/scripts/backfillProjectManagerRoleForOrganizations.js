const { config } = require('dotenv');
const mongoose = require('mongoose');
const { ethers } = require('ethers');

config();

const donationRankingContractAbi = [
  'function hasRole(bytes32 role, address account) external view returns (bool)',
  'function projectManagerRole() external view returns (bytes32)',
  'function grantProjectManagerRole(address account) external'
];

/** Hàm lấy biến môi trường bắt buộc. Mục đích: dừng script sớm nếu thiếu cấu hình quan trọng. */
function getRequiredEnvironmentVariable(variableName) {
  const variableValue = String(process.env[variableName] || '').trim();
  if (!variableValue) {
    throw new Error(`Thiếu biến môi trường: ${variableName}`);
  }
  return variableValue;
}

/** Hàm chuẩn hóa private key. Mục đích: đảm bảo private key đúng định dạng 0x + 64 ký tự hex. */
function normalizePrivateKey(privateKeyValue) {
  const rawPrivateKey = privateKeyValue.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(rawPrivateKey)) {
    throw new Error('DONATION_ADMIN_PRIVATE_KEY không hợp lệ.');
  }
  return `0x${rawPrivateKey}`;
}

/** Hàm kết nối MongoDB. Mục đích: đọc danh sách organization đã được approve từ database. */
async function connectToMongoDb() {
  const mongoDatabaseUri = getRequiredEnvironmentVariable('MONGODB_URI');
  const mongoDatabaseName = String(process.env.MONGODB_DB_NAME || '').trim() || undefined;
  await mongoose.connect(mongoDatabaseUri, { dbName: mongoDatabaseName });
}

/** Hàm lấy danh sách ví organization cần backfill. Mục đích: chỉ chọn tài khoản organizations có ví hợp lệ. */
async function getOrganizationWalletAddressList() {
  const authUserSchema = new mongoose.Schema({}, { strict: false, collection: 'authusers' });
  const AuthUserModel = mongoose.models.AuthUserBackfill || mongoose.model('AuthUserBackfill', authUserSchema);

  const organizationUserList = await AuthUserModel.find({ role: 'organizations', accountStatus: 'ACTIVE' })
    .select({ id: 1, email: 1, walletAddress: 1, _id: 0 })
    .lean()
    .exec();

  return organizationUserList
    .map((userItem) => ({
      userId: String(userItem.id || ''),
      email: String(userItem.email || ''),
      walletAddress: String(userItem.walletAddress || '').trim()
    }))
    .filter((userItem) => ethers.isAddress(userItem.walletAddress));
}

/** Hàm backfill PROJECT_MANAGER_ROLE cho toàn bộ organization đã approve. Mục đích: đồng bộ quyền on-chain cho dữ liệu legacy. */
async function backfillProjectManagerRoleForOrganizations() {
  const blockchainRpcUrl = getRequiredEnvironmentVariable('BLOCKCHAIN_RPC_URL');
  const donationRankingContractAddress = getRequiredEnvironmentVariable('DONATION_RANKING_CONTRACT_ADDRESS');
  const adminPrivateKey = normalizePrivateKey(getRequiredEnvironmentVariable('DONATION_ADMIN_PRIVATE_KEY'));

  const provider = new ethers.JsonRpcProvider(blockchainRpcUrl);
  const adminSigner = new ethers.Wallet(adminPrivateKey, provider);
  const donationRankingContract = new ethers.Contract(donationRankingContractAddress, donationRankingContractAbi, adminSigner);

  await connectToMongoDb();
  const organizationUserList = await getOrganizationWalletAddressList();
  const projectManagerRoleHash = await donationRankingContract.projectManagerRole();

  console.log(`Bat dau backfill role cho ${organizationUserList.length} organization.`);
  let grantedCount = 0;
  let skippedCount = 0;

  for (const organizationUser of organizationUserList) {
    const hasRole = await donationRankingContract.hasRole(projectManagerRoleHash, organizationUser.walletAddress);
    if (hasRole) {
      skippedCount += 1;
      console.log(`[SKIP] userId=${organizationUser.userId} wallet=${organizationUser.walletAddress} da co role.`);
      continue;
    }

    const grantRoleTransaction = await donationRankingContract.grantProjectManagerRole(organizationUser.walletAddress);
    await grantRoleTransaction.wait(1);
    grantedCount += 1;

    console.log(
      `[GRANT] userId=${organizationUser.userId} wallet=${organizationUser.walletAddress} txHash=${grantRoleTransaction.hash}`
    );
  }

  console.log(`Hoan tat backfill. granted=${grantedCount}, skipped=${skippedCount}, total=${organizationUserList.length}`);
}

backfillProjectManagerRoleForOrganizations()
  .catch((error) => {
    console.error('Backfill PROJECT_MANAGER_ROLE that bai:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
