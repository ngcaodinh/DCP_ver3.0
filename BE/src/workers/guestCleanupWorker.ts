/**
 * Worker dọn dẹp phiên guest wallet và phát hiện Sybil attack.
 * Chạy 1 lần/ngày cùng schedule với ranking reconciliation (00:00).
 *
 * Nhiệm vụ:
 * - Task 1: Expire các phiên đã hết hạn (ACTIVE → EXPIRED)
 * - Task 2: Purge các phiên expired quá 30 ngày (EXPIRED → PURGED)
 * - Task 3: Cluster detection — phát hiện wallets cùng fingerprint/IP subnet/timestamps
 * - Task 4: Anti-farming check — flag nếu guest donations > 60% total donations
 */
import { getLogger } from '../config/logger';
import {
  expireGuestSessions,
  purgeOldGuestSessions,
  findGuestWalletSessionsByIds,
  aggregateFingerprintCounts,
  aggregateSubnetCounts,
  findSessionIdsByFingerprintPrefix,
  findSessionIdsBySubnet
} from '../repositories/guestWalletSessionRepository';
import {
  findAllClusterSuspects,
  markManyAsClusterSuspect
} from '../repositories/guestDonationRiskRepository';
import {
  countAnonymousDonationsSince
} from '../repositories/anonymousDonationAuditRepository';
import {
  countTotalDonationsSince
} from '../repositories/donationRepository';

const logger = getLogger();

/**
 * Thời gian (miligiây) chờ trước khi purge một phiên đã expired (30 ngày).
 */
const PURGE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Số ngày để tính tỷ lệ guest donations (FR4.G anti-farming).
 */
const ANTI_FARMING_LOOKBACK_DAYS = 30;

/**
 * Ngưỡng % guest donations để flag anti-farming (> 60%).
 */
const ANTI_FARMING_THRESHOLD_PERCENT = 60;

/**
 * Cụm cluster suspect mới cần xử lý (chưa được gán clusterId).
 * Giới hạn batch để tránh quá tải memory khi có nhiều suspicious sessions.
 */
const CLUSTER_BATCH_SIZE = 500;

/**
 * Chunk size cho parallel DB calls trong N+1 fix.
 * Giới hạn concurrency = 10 để tránh overwhelming MongoDB connection pool.
 */
const CHUNK_SIZE = 10;

/**
 * Số octets lấy từ IPv4 để tạo subnet prefix (/24).
 */
const IPV4_SUBNET_OCTETS = 3;

/**
 * Số nhóm hex lấy từ IPv6 để tạo subnet prefix (/64).
 */
const IPV6_SUBNET_GROUPS = 4;

/**
 * Khoảng thời gian (miligiây) để phát hiện velocity burst (2 phút).
 * Nếu 2 sessions cùng subnet được tạo trong khoảng thời gian này → mark là cluster.
 */
const VELOCITY_WINDOW_MS = 2 * 60 * 1000;

/**
 * Trích xuất subnet prefix từ địa chỉ IP, hỗ trợ cả IPv4 và IPv6.
 * Thêm null guard để xử lý trường hợp ipAddress là null/undefined/empty.
 *
 * Logic:
 * - IPv4: lấy 3 octets đầu tiên (/24, ví dụ "192.168.1")
 * - IPv6: lấy 4 nhóm hex đầu tiên (/64, ví dụ "2001:db8:acme:b85f")
 * - IPv6 nén (compressed): expand :: notation trước khi parse
 * - Format không nhận diện được: trả về nguyên chuỗi để tránh false negative
 *
 * @param ipAddress - Địa chỉ IP (IPv4 hoặc IPv6)
 * @returns Subnet prefix dạng string, hoặc chuỗi rỗng nếu input không hợp lệ
 */
export function extractIpSubnet(ipAddress: string): string {
  if (!ipAddress) return '';

  if (ipAddress.includes(':')) {
    // Expand IPv6 compressed notation (::) trước khi parse
    // Ví dụ: "2001:db8::1" → "2001:db8:0:0:0:0:0:1"
    // Ví dụ: "::1" → "0:0:0:0:0:0:0:1"
    // Ví dụ: "2001:db8::" → "2001:db8:0:0:0:0:0:0"
    const groups = validateAndExpandIpv6(ipAddress);
    if (!groups) return ipAddress; // Invalid IPv6 → fallback to full string
    return groups.slice(0, IPV6_SUBNET_GROUPS).join(':');
  }

  const parts = ipAddress.split('.');
  if (parts.length !== 4) {
    return ipAddress;
  }
  return parts.slice(0, IPV4_SUBNET_OCTETS).join('.');
}

/**
 * Expand IPv6 address có nén (compressed notation) thành mảng 8 nhóm hex.
 * Xử lý các dạng: full, compressed (::), trailing (::1), leading (2001::).
 *
 * @param ipAddress - Địa chỉ IPv6 cần expand
 * @returns Mảng 8 nhóm hex, mỗi nhóm 4 ký tự hex
 */
function expandIpv6Groups(ipAddress: string): string[] {
  const groups = ipAddress.split(':');

  // Tìm vị trí của :: (empty group)
  const emptyIndex = groups.findIndex(g => g === '');

  if (emptyIndex === -1) {
    // Không có :: → địa chỉ đầy đủ, pad thêm nếu thiếu
    while (groups.length < 8) {
      groups.push('0');
    }
    return groups.slice(0, 8);
  }

  // Số lượng group thực tế có data (bỏ qua chuỗi rỗng sinh ra bởi ::)
  const numNonEmptyGroups = groups.filter(g => g !== '').length;
  // Số nhóm cần thêm vào chỗ trống = 8 - total valid groups hiện tại
  const expansionCount = 8 - numNonEmptyGroups;

  // Tạo mảng expansion
  const expansion = Array<string>(expansionCount).fill('0');

  // Ghép: phần trước :: + expansion + phần sau :: (loại bỏ empty groups)
  const before = groups.slice(0, emptyIndex);
  const after = groups.slice(emptyIndex + 1).filter(g => g !== '');

  const result = [...before, ...expansion, ...after];
  // Pad thêm nếu thiếu (trường hợp input không hợp lệ có ít hơn 8 nhóm)
  while (result.length < 8) {
    result.push('0');
  }
  return result.slice(0, 8);
}

/**
 * Validate và expand IPv6 address thành 8 nhóm hex.
 * Trả về mảng 8 phần tử hoặc null nếu input không hợp lệ.
 * Chỉ expand khi :: notation làm giảm số nhóm xuống dưới 8.
 *
 * @param ipAddress - Địa chỉ IPv6 cần validate
 * @returns Mảng 8 nhóm hex hoặc null nếu không hợp lệ
 */
function validateAndExpandIpv6(ipAddress: string): string[] | null {
  const groups = expandIpv6Groups(ipAddress);
  if (groups.length < 8) return null;
  return groups;
}

/**
 * Kiểm tra xem địa chỉ IP có phải là IPv6 không.
 *
 * @param ipAddress - Địa chỉ IP cần kiểm tra
 * @returns true nếu là IPv6, false nếu là IPv4
 */
export function isIpv6Address(ipAddress: string): boolean {
  if (!ipAddress) return false;
  return ipAddress.includes(':');
}

/**
 * Task 1: Expire các phiên guest wallet đã hết hạn.
 * Mục đích: đánh dấu ACTIVE sessions có expiresAt < now thành EXPIRED.
 * Không hard-delete — giữ lại để audit trail.
 */
export async function taskExpireOverdueSessions(): Promise<number> {
  const now = new Date();
  const expiredCount = await expireGuestSessions(now);
  logger.info(`[GuestCleanup] Task1: Đã expire ${expiredCount} phiên hết hạn.`);
  return expiredCount;
}

/**
 * Task 2: Purge các phiên expired quá 30 ngày.
 * Mục đích: chuyển EXPIRED → PURGED sau khi retention period qua.
 * Soft-delete để giữ audit trail, comply với data retention policy.
 */
export async function taskPurgeOldSessions(): Promise<number> {
  const cutoffDate = new Date(Date.now() - PURGE_THRESHOLD_MS);
  const purgedCount = await purgeOldGuestSessions(cutoffDate);
  logger.info(`[GuestCleanup] Task2: Đã purge ${purgedCount} phiên expired quá 30 ngày.`);
  return purgedCount;
}

/**
 * Task 4: Anti-farming check — flag nếu guest donations > 60% total.
 * Mục đích: phát hiện scenario có thể là farm Sybil để inflate QF matching.
 */
export async function taskAntiFarmingCheck(): Promise<boolean> {
  const lookbackDate = new Date(Date.now() - ANTI_FARMING_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const [guestCount, totalCount] = await Promise.all([
    countAnonymousDonationsSince(lookbackDate),
    countTotalDonationsSince(lookbackDate)
  ]);

  if (totalCount === 0) {
    logger.info('[GuestCleanup] Task4: Không có donation nào trong khoảng thời gian kiểm tra.');
    return false;
  }

  const guestPercent = (guestCount / totalCount) * 100;

  if (guestPercent > ANTI_FARMING_THRESHOLD_PERCENT) {
    logger.warn(`[GuestCleanup] Task4: ALERT! Guest donations chiếm ${guestPercent.toFixed(2)}% (${guestCount}/${totalCount}) trong ${ANTI_FARMING_LOOKBACK_DAYS} ngày qua. Ngưỡng: ${ANTI_FARMING_THRESHOLD_PERCENT}%.`, {
      action: 'anti_farming_alert',
      reason: `Guest donations ${guestPercent.toFixed(2)}% > threshold ${ANTI_FARMING_THRESHOLD_PERCENT}%`
    });
    return true;
  }

  logger.info(`[GuestCleanup] Task4: Guest donations chiếm ${guestPercent.toFixed(2)}% (${guestCount}/${totalCount}). Ngưỡng: ${ANTI_FARMING_THRESHOLD_PERCENT}%.`);
  return false;
}

// Type cho session data cần thiết cho cluster detection
interface SessionDataForCluster {
  sessionId: string;
  deviceFingerprintHash: string;
  ipAddress: string;
  createdAt: Date;
}

// Type cho thông tin subnet query
interface SubnetQuery {
  prefix: string;
  isIpv6: boolean;
}

/**
 * Phát hiện các sessions có cùng fingerprint prefix (≥3 sessions → cluster).
 * Mỗi fingerprint prefix đủ ngưỡng sẽ được query và mark là cluster suspect.
 *
 * Performance: Sử dụng chunk + Promise.all thay vì sequential await
 * để parallelize N DB calls, giảm tổng wall-clock time.
 *
 * @param uniqueFingerprintPrefixes - Set các fingerprint prefixes cần kiểm tra
 * @param fingerprintCounts - Map<fingerprintPrefix, totalCount> từ aggregation query
 * @param handledSessionIds - Set các sessionIds đã được mark (để track)
 * @returns Số lượng sessions mới được mark
 */
export async function detectFingerprintReuse(
  uniqueFingerprintPrefixes: Set<string>,
  fingerprintCounts: Map<string, number>,
  handledSessionIds: Set<string>
): Promise<number> {
  const prefixesToProcess = [...uniqueFingerprintPrefixes].filter(fp => {
    const totalCount = fingerprintCounts.get(fp) ?? 0;
    return totalCount >= 3;
  });

  if (!prefixesToProcess.length) return 0;

  let totalMarked = 0;

  // Chunk prefixes thành batches nhỏ để parallelize mà không overwhelming DB
  for (let i = 0; i < prefixesToProcess.length; i += CHUNK_SIZE) {
    const chunk = prefixesToProcess.slice(i, i + CHUNK_SIZE);

    const chunkResults = await Promise.all(
      chunk.map(async (fingerprintPrefix) => {
        const totalCount = fingerprintCounts.get(fingerprintPrefix) ?? 0;
        const clusterId = `fp_${fingerprintPrefix}`;
        const ids = await findSessionIdsByFingerprintPrefix(fingerprintPrefix);

        if (!ids.length) return { marked: 0, ids: [] };

        const marked = await markManyAsClusterSuspect(ids, clusterId);
        return { marked, ids };
      })
    );

    for (const { marked, ids } of chunkResults) {
      totalMarked += marked;
      for (const id of ids) handledSessionIds.add(id);
    }

    // Log chunk hoàn thành
    logger.info(`[GuestCleanup] Task3a: Processed ${Math.min(i + CHUNK_SIZE, prefixesToProcess.length)}/${prefixesToProcess.length} fingerprint prefixes.`);
  }

  return totalMarked;
}

/**
 * Phát hiện các sessions có cùng IP subnet prefix (≥5 sessions → cluster).
 * Truyền handledSessionIds vào query để loại trừ sessions đã được xử lý bởi fingerprint reuse.
 *
 * Performance: Sử dụng chunk + Promise.all thay vì sequential await
 * để parallelize N DB calls, giảm tổng wall-clock time.
 *
 * @param uniqueSubnetQueries - Array các subnet queries cần kiểm tra
 * @param subnetCounts - Map<SubnetPrefix, totalCount> từ aggregation query
 * @param handledSessionIds - Set các sessionIds đã được mark (để track và exclude)
 * @returns Số lượng sessions mới được mark
 */
export async function detectSubnetBurst(
  uniqueSubnetQueries: SubnetQuery[],
  subnetCounts: Map<string, number>,
  handledSessionIds: Set<string>
): Promise<number> {
  const subnetsToProcess = uniqueSubnetQueries.filter(({ prefix }) => {
    const totalCount = subnetCounts.get(prefix) ?? 0;
    return totalCount >= 5;
  });

  if (!subnetsToProcess.length) return 0;

  let totalMarked = 0;

  // Chunk subnets thành batches nhỏ để parallelize mà không overwhelming DB
  for (let i = 0; i < subnetsToProcess.length; i += CHUNK_SIZE) {
    const chunk = subnetsToProcess.slice(i, i + CHUNK_SIZE);

    const chunkResults = await Promise.all(
      chunk.map(async ({ prefix: subnetPrefix, isIpv6 }) => {
        const totalCount = subnetCounts.get(subnetPrefix) ?? 0;
        const clusterId = `ip_${subnetPrefix}`;
        const ids = await findSessionIdsBySubnet(subnetPrefix, isIpv6, [...handledSessionIds]);

        if (!ids.length) return { marked: 0, ids: [] };

        const marked = await markManyAsClusterSuspect(ids, clusterId);
        return { marked, ids };
      })
    );

    for (const { marked, ids } of chunkResults) {
      totalMarked += marked;
      for (const id of ids) handledSessionIds.add(id);
    }

    // Log chunk hoàn thành
    logger.info(`[GuestCleanup] Task3b: Processed ${Math.min(i + CHUNK_SIZE, subnetsToProcess.length)}/${subnetsToProcess.length} subnet prefixes.`);
  }

  return totalMarked;
}

/**
 * Phát hiện các sessions cùng subnet được tạo trong khoảng thời gian ngắn (velocity check).
 * Sử dụng sliding window: so sánh từng cặp sessions kề nhau theo thời gian.
 * Nếu 2 sessions cách nhau < VELOCITY_WINDOW_MS → mark là cluster.
 *
 * @param uniqueSubnetQueries - Array các subnet prefixes cần kiểm tra
 * @param subnetSessionMap - Map<SubnetPrefix, sessions[]> cho O(1) lookup
 * @param handledSessionIds - Set các sessionIds đã được mark (để tránh re-mark)
 * @param lookbackDate - Ngày bắt đầu lookback window
 * @returns Số lượng sessions mới được mark
 */
export async function detectSessionVelocity(
  uniqueSubnetQueries: SubnetQuery[],
  subnetSessionMap: Map<string, SessionDataForCluster[]>,
  handledSessionIds: Set<string>,
  lookbackDate: Date
): Promise<number> {
  let totalMarked = 0;

  for (const { prefix: subnetPrefix } of uniqueSubnetQueries) {
    const subnetSessions = subnetSessionMap.get(subnetPrefix) ?? [];
    // Lọc các sessions trong lookback window
    const filtered = subnetSessions.filter(s => s.createdAt >= lookbackDate);

    if (filtered.length < 2) continue;

    // Sắp xếp theo thời gian tạo
    const sorted = filtered.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    );

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const timeDiffMs = curr.createdAt.getTime() - prev.createdAt.getTime();

      // Bỏ qua nếu time diff >= 2 phút
      if (timeDiffMs >= VELOCITY_WINDOW_MS) continue;
      // Bỏ qua nếu cả 2 sessions đã được mark
      if (handledSessionIds.has(prev.sessionId) && handledSessionIds.has(curr.sessionId)) continue;

      const idsToMark: string[] = [];
      if (!handledSessionIds.has(prev.sessionId)) idsToMark.push(prev.sessionId);
      if (!handledSessionIds.has(curr.sessionId)) idsToMark.push(curr.sessionId);
      if (idsToMark.length === 0) continue;

      // Dùng timestamp thay vì array index để tránh clusterId collision
      // qua các batch khác nhau (Worker chạy nhiều ngày, index sẽ reset mỗi batch)
      const clusterId = `vel_${subnetPrefix}_${prev.createdAt.getTime()}`;
      const marked = await markManyAsClusterSuspect(idsToMark, clusterId);
      totalMarked += marked;
      handledSessionIds.add(prev.sessionId);
      handledSessionIds.add(curr.sessionId);
      logger.info(`[GuestCleanup] Task3c: Velocity cluster ${clusterId} → marked ${marked} sessions (${prev.sessionId} ↔ ${curr.sessionId}, ${(timeDiffMs / 1000).toFixed(0)}s).`);
    }
  }

  return totalMarked;
}

/**
 * Task 3: Cluster detection — phát hiện Sybil attack.
 * Mục đích: nhóm các guest wallets cùng fingerprint/IP subnet/timestamps gần nhau.
 *
 * Corrected Algorithm:
 *
 * Vấn đề với thuật toán cũ:
 * - Cluster Leak: Chỉ gán clusterId cho sessions trong batch → session cũ cùng cluster không được update
 * - Unbounded Backlog: 1 batch duy nhất 500 items → nếu 5000 suspects, mất 10 ngày để clear
 * - N+1 Query: Vòng lặp tuần tự cho N unique prefixes → N sequential DB queries
 * - Fixed Time Bucket: Session A tạo lúc 1:59 và B tạo lúc 2:01 sẽ bị miss vì khác bucket dù khoảng cách thực tế < 2 phút
 *
 * Thuật toán mới:
 * 1. While loop: drain hết queue bằng cursor-based pagination (lastSeenId)
 *    Mỗi batch 500 items → không nổ RAM, không backlog
 * 2. Trong mỗi batch: batch fetch session data → extract prefixes
 * 3. Gọi 2 aggregation queries duy nhất để lấy TOTAL counts cho TẤT CẢ prefixes cùng lúc
 * 4. Với mỗi prefix đủ ngưỡng → query sessionIds từ DB → gọi markManyAsClusterSuspect
 * 5. Velocity check: group by subnet → sort theo time → so sánh adjacent pairs (sliding window)
 * 6. Cursor pagination: chỉ query sessions CHƯA có clusterId để tránh re-mark
 *
 * @param now - Thời điểm hiện tại (mặc định: new Date())
 * @returns Số lượng sessions mới được mark là cluster suspect
 */
export async function taskDetectClusters(now: Date = new Date()): Promise<number> {
  const lookbackDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // While loop để drain hết queue — tránh backlog khi có nhiều suspects
  let totalMarked = 0;
  let lastSeenId: string | undefined;

  while (true) {
    // Chỉ lấy sessions chưa được gán clusterId (tránh re-mark)
    const existingSuspects = await findAllClusterSuspects(CLUSTER_BATCH_SIZE, lastSeenId);

    if (!existingSuspects.length) {
      break;
    }

    // Batch fetch tất cả session data
    const sessionIds = existingSuspects.map(s => s.sessionId);
    const sessions = await findGuestWalletSessionsByIds(sessionIds);

    // Build lookup map: sessionId → session data
    const sessionById = new Map(sessions.map(s => [s.sessionId, s]));

    // Extract unique fingerprint prefixes từ batch
    const uniqueFingerprintPrefixes = new Set<string>();
    for (const suspect of existingSuspects) {
      const session = sessionById.get(suspect.sessionId);
      if (session) {
        uniqueFingerprintPrefixes.add(session.deviceFingerprintHash.substring(0, 16));
      }
    }

    // Extract unique subnet prefixes từ batch
    const uniqueSubnetQueries: SubnetQuery[] = [];
    const seenSubnets = new Set<string>();
    for (const suspect of existingSuspects) {
      const session = sessionById.get(suspect.sessionId);
      if (session && session.ipAddress) {
        const subnet = extractIpSubnet(session.ipAddress);
        if (subnet && !seenSubnets.has(subnet)) {
          seenSubnets.add(subnet);
          uniqueSubnetQueries.push({ prefix: subnet, isIpv6: isIpv6Address(session.ipAddress) });
        }
      }
    }

    // Fix N+1: 2 aggregation queries duy nhất cho TẤT CẢ prefixes cùng lúc
    const [fingerprintCounts, subnetCounts] = await Promise.all([
      aggregateFingerprintCounts([...uniqueFingerprintPrefixes]),
      aggregateSubnetCounts(uniqueSubnetQueries)
    ]);

    // Track session IDs đã được mark trong Steps 3a/3b để exclude khỏi velocity check
    const handledSessionIds = new Set<string>();

    // Step 3a: Fingerprint reuse detection
    await detectFingerprintReuse(uniqueFingerprintPrefixes, fingerprintCounts, handledSessionIds);

    // Step 3b: IP subnet burst detection
    await detectSubnetBurst(uniqueSubnetQueries, subnetCounts, handledSessionIds);

    // Step 3c: Session velocity check — O(1) Map lookup thay vì O(N) filter
    // Build Map<subnetPrefix, sessions[]> cho O(1) lookup
    const subnetSessionMap = new Map<string, SessionDataForCluster[]>();
    for (const session of sessions) {
      if (!session.ipAddress) continue;
      const subnetPrefix = extractIpSubnet(session.ipAddress);
      const existing = subnetSessionMap.get(subnetPrefix) ?? [];
      existing.push({
        sessionId: session.sessionId,
        deviceFingerprintHash: session.deviceFingerprintHash,
        ipAddress: session.ipAddress,
        createdAt: session.createdAt
      });
      subnetSessionMap.set(subnetPrefix, existing);
    }

    const batchMarked = await detectSessionVelocity(
      uniqueSubnetQueries,
      subnetSessionMap,
      handledSessionIds,
      lookbackDate
    );

    totalMarked += batchMarked;

    // Cursor pagination: lưu _id cuối cùng để batch tiếp theo bắt đầu từ đây
    lastSeenId = existingSuspects[existingSuspects.length - 1]._id?.toString();

    // Nếu batch trả về ít hơn batch size → đã hết data, thoát
    if (existingSuspects.length < CLUSTER_BATCH_SIZE) {
      break;
    }
  }

  logger.info(`[GuestCleanup] Task3: Cluster detection hoàn tất. Đã mark ${totalMarked} sessions mới.`);
  return totalMarked;
}

/**
 * Hàm chạy toàn bộ cleanup workflow.
 * Thực thi 4 tasks theo thứ tự để đảm bảo data consistency:
 * - Tasks 1+2 (expire/purge) chạy trước để tránh race với Task 3.
 * - Tasks 3+4 chạy song song sau khi Tasks 1+2 hoàn tất.
 *
 * @returns Object chứa kết quả của từng task
 */
export async function runGuestCleanup(): Promise<{
  expired: number;
  purged: number;
  clusters: number;
  farmingDetected: boolean;
}> {
  logger.info('[GuestCleanup] Bắt đầu guest cleanup worker.');

  const expired = await taskExpireOverdueSessions();
  const purged = await taskPurgeOldSessions();

  const [clusters, farmingDetected] = await Promise.all([
    taskDetectClusters(),
    taskAntiFarmingCheck()
  ]);

  logger.info('[GuestCleanup] Hoàn tất guest cleanup worker.', {
    action: 'guest_cleanup_complete',
    expiredSessions: expired,
    purgedSessions: purged,
    newClusters: clusters,
    farmingDetected
  });

  return { expired, purged, clusters, farmingDetected };
}

/**
 * Hàm chạy guest cleanup một lần (dùng bởi rankingReconcileWorker).
 * Cleanup worker chạy định kỳ 00:00 mỗi ngày thông qua rankingReconcileWorker.
 *
 * @returns Object chứa kết quả của từng task
 */
export async function runGuestCleanupOnce(): Promise<{
  expired: number;
  purged: number;
  clusters: number;
  farmingDetected: boolean;
}> {
  return runGuestCleanup();
}
