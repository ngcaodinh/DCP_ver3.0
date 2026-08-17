import { getLogger } from '../config/logger';
import { streamDonorAddressesForScheduler } from '../repositories/donorTrustScoreRepository';
import { recalculateTrustScoreForDonor } from '../services/trust-score.service';

const logger = getLogger();

/**
 * Khoảng thời gian giữa các lần chạy trust score scheduler (24 giờ).
 * Mục đích: đảm bảo trust score của tất cả donors được làm mới hàng ngày
 * ngay cả khi không có sự kiện trigger (KYC, donation mới).
 */
const TRUST_SCORE_SCHEDULE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Số lượng donors được xử lý song song trong một batch.
 * Mục đích: cân bằng giữa tốc độ xử lý và tải DB — không làm spike
 * connection pool khi collection lớn (>10k donors).
 * Giá trị 10 đủ để tăng throughput ~10x so với sequential mà không overwhelm DB.
 */
const BATCH_CONCURRENCY = 10;

/**
 * Handle của timeout scheduler đang chờ đến lượt chạy tiếp theo.
 * Mục đích: lưu lại để có thể clearTimeout khi graceful shutdown,
 * tránh để timer kích hoạt job sau khi process đã nhận tín hiệu tắt.
 */
let schedulerTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

/**
 * Biến theo dõi trạng thái scheduler để hỗ trợ checkpoint/resume khi crash.
 * Nếu scheduler crash giữa chừng, lần chạy tiếp theo sẽ bắt đầu lại từ đầu
 * (hiện tại chưa có persistence cho checkpoint — see I2 note trong code).
 */
let isSchedulerRunning = false;

/**
 * AbortController của job đang chạy (nếu có).
 * Mục đích: cho phép stopTrustScoreScheduler() abort job đang giữa batch
 * khi process nhận SIGTERM/SIGINT — tránh shutdown leak khi scheduler
 * tiếp tục tính toán đến hết batch dù server đang tắt.
 * Được tạo mới mỗi cycle trong startTrustScoreScheduler và reset về null khi cycle kết thúc.
 */
let currentAbortController: AbortController | null = null;

/**
 * Hàm xử lý một batch donors song song với concurrency limit.
 * Mục đích: tránh N+1 sequential await khi collection lớn, đồng thời
 * không overwhelm DB bằng cách giới hạn số lượng Promise chạy cùng lúc.
 *
 * Hỗ trợ abort: kiểm tra signal trước mỗi chunk donors trong batch — nếu scheduler
 * nhận stop signal thì return sớm với partial result, giúp shutdown nhanh hơn
 * thay vì phải đợi toàn bộ batch BATCH_CONCURRENCY donors hoàn thành.
 *
 * @param addresses - Mảng wallet addresses cần recalculate trong batch này.
 * @param signal - AbortSignal tùy chọn để cho phép dừng sớm khi scheduler shutdown.
 * @returns Số lượng thành công và thất bại trong batch (partial nếu bị abort giữa chừng).
 */
async function processBatch(
  addresses: string[],
  signal?: AbortSignal
): Promise<{ successCount: number; failureCount: number }> {
  let successCount = 0;
  let failureCount = 0;
  let processedCount = 0;

  // Chia batch thành các chunk BATCH_CONCURRENCY và xử lý song song trong từng chunk.
  // Kiểm tra abort signal trước mỗi chunk — cho phép dừng sớm khi shutdown,
  // không phải đợi toàn bộ donors trong batch (có thể lên tới batchSize=500) hoàn thành.
  for (let chunkStartIndex = 0; chunkStartIndex < addresses.length; chunkStartIndex += BATCH_CONCURRENCY) {
    // Nếu scheduler nhận stop signal thì dừng sớm với partial result —
    // tránh tiếp tục tính toán trong khi process đang trong quá trình shutdown.
    if (signal?.aborted) {
      logger.info(
        `Trust score scheduler: nhận tín hiệu abort, dừng batch sớm (đã xử lý ${processedCount}/${addresses.length} donors).`
      );
      return { successCount, failureCount };
    }

    const currentChunk = addresses.slice(chunkStartIndex, chunkStartIndex + BATCH_CONCURRENCY);

    // Xử lý song song tối đa BATCH_CONCURRENCY donors cùng lúc,
    // dùng Promise.allSettled để không dừng batch khi 1 donor lỗi.
    const results = await Promise.allSettled(
      currentChunk.map(donorAddress => recalculateTrustScoreForDonor(donorAddress))
    );

    results.forEach((result, chunkIndex) => {
      processedCount++;
      if (result.status === 'fulfilled') {
        successCount++;
      } else {
        failureCount++;
        logger.warn('Trust score scheduler: recalculate thất bại cho một donor.', {
          donorAddress: currentChunk[chunkIndex],
          errorMessage: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
      }
    });
  }

  return { successCount, failureCount };
}

/**
 * Hàm thực hiện một lần recalculate trust score cho toàn bộ donors có bản ghi trong DB.
 * Mục đích: batch job hàng ngày đảm bảo trust score không bị stale theo thời gian
 * (accountAge tăng dần, KYC status có thể thay đổi).
 *
 * Flow:
 * 1. Stream donor addresses từ DB theo batch để tránh load toàn bộ vào memory.
 * 2. Kiểm tra abort signal trước mỗi batch — nếu scheduler đang shutdown thì
 *    dừng stream ngay, trả về partial result (cộng dồn từ các batch đã chạy).
 * 3. Xử lý mỗi batch với controlled concurrency (BATCH_CONCURRENCY) — processBatch
 *    cũng check signal giữa các chunk để có thể dừng sớm hơn nữa.
 * 4. Mỗi recalculate đã tự invalidate cache bên trong service.
 * 5. Log tổng kết kết quả (thành công / thất bại) sau khi hoàn thành.
 *
 * @param signal - AbortSignal để cho phép caller (scheduler) dừng job sớm khi shutdown.
 * @returns Thống kê số lượng thành công và thất bại (partial nếu bị abort).
 */
async function runDailyTrustScoreRecalculation(signal: AbortSignal): Promise<{
  successCount: number;
  failureCount: number;
}> {
  let successCount = 0;
  let failureCount = 0;
  let batchCount = 0;

  // Dùng streaming thay vì load toàn bộ vào memory để hỗ trợ 100k+ donors.
  // Mỗi batch xử lý tối đa BATCH_CONCURRENCY donors song song.
  await streamDonorAddressesForScheduler(async (addresses: string[]) => {
    // Kiểm tra signal trước khi bắt đầu batch mới — nếu scheduler đang shutdown
    // thì không gọi processBatch, tránh lãng phí tính toán và giúp tắt nhanh hơn.
    if (signal.aborted) {
      logger.info(
        `Trust score scheduler: nhận tín hiệu abort trước batch #${batchCount + 1}, dừng stream sớm.`
      );
      return;
    }

    batchCount++;
    const batchResult = await processBatch(addresses, signal);
    successCount += batchResult.successCount;
    failureCount += batchResult.failureCount;

    logger.info(
      `Trust score scheduler: hoàn thành batch #${batchCount} (${addresses.length} donors).`
    );
  });

  return { successCount, failureCount };
}

/**
 * Hàm khởi động trust score scheduler hàng ngày.
 * Mục đích: tự động recalculate trust score cho tất cả donors mỗi 24 giờ
 * để accountAge factor được cập nhật đúng và cache không stale quá lâu.
 *
 * Dùng recursive setTimeout (thay vì setInterval) để:
 * - Tránh overlap nếu job chạy lâu hơn interval.
 * - Đảm bảo interval 24h bắt đầu SAU khi job hoàn thành.
 *
 * Flow:
 * 1. Scheduler khởi động — chờ 24h rồi chạy lần đầu.
 * 2. Mỗi cycle tạo AbortController mới (lưu vào currentAbortController)
 *    để stopTrustScoreScheduler có thể abort job đang chạy giữa batch.
 * 3. Sau mỗi lần chạy (thành công hoặc lỗi) → lại chờ 24h tiếp.
 * 4. Lỗi trong một cycle không dừng scheduler.
 * 5. Lưu handle vào schedulerTimeoutHandle để stopTrustScoreScheduler có thể clear.
 */
export function startTrustScoreScheduler(): void {
  logger.info(
    `Trust score scheduler khởi động (interval=${TRUST_SCORE_SCHEDULE_INTERVAL_MS / 1000 / 60 / 60}h).`
  );

  const runWithInterval = (): void => {
    schedulerTimeoutHandle = setTimeout(async () => {
      // Reset handle ngay khi timer fire — tránh race với stopTrustScoreScheduler.
      schedulerTimeoutHandle = null;

      // Ngăn chặn overlap nếu job chạy lâu hơn interval (dù đã dùng setTimeout).
      if (isSchedulerRunning) {
        logger.warn('Trust score scheduler: job trước chưa hoàn thành, bỏ qua cycle này.');
        runWithInterval();
        return;
      }

      isSchedulerRunning = true;

      // Tạo AbortController mới cho cycle này — stopTrustScoreScheduler sẽ gọi
      // abort() trên controller này để job hiện tại (nếu đang chạy) dừng sớm.
      currentAbortController = new AbortController();

      try {
        const result = await runDailyTrustScoreRecalculation(currentAbortController.signal);

        if (currentAbortController.signal.aborted) {
          // Job đã bị stop giữa chừng — kết quả chỉ là partial, không phải lỗi.
          logger.info('Trust score scheduler: job đã bị dừng sớm bởi shutdown signal.', {
            successCount: result.successCount,
            failureCount: result.failureCount
          });
        } else {
          logger.info('Trust score scheduler: hoàn thành recalculation hàng ngày.', {
            successCount: result.successCount,
            failureCount: result.failureCount
          });
        }
      } catch (error) {
        logger.error('Trust score scheduler: job recalculation thất bại toàn bộ.', {
          errorMessage: (error as Error).message
        });
      } finally {
        isSchedulerRunning = false;
        currentAbortController = null;
      }

      runWithInterval();
    }, TRUST_SCORE_SCHEDULE_INTERVAL_MS);
  };

  runWithInterval();
}

/**
 * Hàm dừng trust score scheduler một cách graceful.
 * Mục đích: clear timeout đang chờ + abort job đang chạy để server có thể tắt
 * nhanh chóng khi nhận SIGTERM/SIGINT, tránh shutdown leak (job tiếp tục chạy
 * đến hết batch dù process đang shutdown).
 *
 * Hành vi:
 * 1. Nếu có timeout đang chờ → clearTimeout để job không kích hoạt sau khi stop.
 * 2. Nếu có job đang chạy → abort AbortController của cycle đó. processBatch và
 *    runDailyTrustScoreRecalculation sẽ kiểm tra signal và return sớm với partial result.
 *
 * Idempotent: gọi nhiều lần đều an toàn (handle/controller đã null sẽ bỏ qua).
 */
export function stopTrustScoreScheduler(): void {
  // Bước 1: clear timeout đang chờ (nếu có) — job không kích hoạt sau khi stop.
  if (schedulerTimeoutHandle !== null) {
    clearTimeout(schedulerTimeoutHandle);
    schedulerTimeoutHandle = null;
  }

  // Bước 2: abort job đang chạy (nếu có) — cho phép processBatch dừng giữa batch
  // thay vì đợi toàn bộ donors hoàn thành. Fix blocker B2 shutdown leak.
  if (currentAbortController !== null) {
    logger.info('Trust score scheduler: gửi tín hiệu abort đến job đang chạy.');
    currentAbortController.abort();
  }

  logger.info('Trust score scheduler đã được dừng.');
}