import { SBT_HIDDEN_FROM_GALLERY_STATUSES, type SbtTokenStatusName } from '../constants/sbtTokenStatus';
import { getLogger } from '../config/logger';
import {
  findImpactSbtMetadataByTokenId,
  updateImpactSbtOnChainStatus,
  type ImpactSbtMetadataRecord
} from '../models/impactSbtMetadataModel';
import {
  findOrCreateSbtStatusProjectionEvent,
  markSbtStatusProjectionEventApplied,
  scheduleSbtStatusProjectionEventRetry,
  type SbtStatusProjectionEventRecord
} from '../models/sbtStatusProjectionModel';
import { invalidateSbtGalleryTotalCache, invalidateSbtTokenCache } from './sbtMetadataCacheService';

const logger = getLogger();

export interface SbtTokenStatusUpdateEvent {
  chainId: string;
  contractAddress: string;
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  tokenId: number;
  newStatus: SbtTokenStatusName;
  reason: string;
}

/** Kiểm tra event đã được một projector khác áp hoặc bị thay thế bởi event canonical mới hơn. */
function isEventAlreadyAppliedOrSuperseded(
  record: ImpactSbtMetadataRecord,
  event: SbtTokenStatusUpdateEvent
): boolean {
  const { tokenStatusBlockNumber, tokenStatusLogIndex } = record;
  if (
    typeof tokenStatusBlockNumber !== 'number'
    || typeof tokenStatusLogIndex !== 'number'
    || !Number.isSafeInteger(tokenStatusBlockNumber)
    || !Number.isSafeInteger(tokenStatusLogIndex)
  ) {
    return false;
  }

  return tokenStatusBlockNumber > event.blockNumber
    || (tokenStatusBlockNumber === event.blockNumber && tokenStatusLogIndex >= event.logIndex);
}

/** Áp một TokenStatusUpdated đã được xác nhận vào Mongo read model theo thứ tự log canonical. */
export async function projectSbtTokenStatusUpdate(event: SbtTokenStatusUpdateEvent): Promise<boolean> {
  const durableEvent = await findOrCreateSbtStatusProjectionEvent(event);
  if (durableEvent.projectionStatus === 'APPLIED') {
    return false;
  }

  const updatedRecord = await updateImpactSbtOnChainStatus(event.tokenId, {
    onChainTokenStatus: event.newStatus,
    reason: event.reason,
    updatedBy: 'ON_CHAIN_STATUS_PROJECTOR',
    updatedAt: new Date(),
    eventLocation: {
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
      transactionHash: event.transactionHash
    }
  });

  if (!updatedRecord) {
    const currentRecord = await findImpactSbtMetadataByTokenId(event.tokenId);
    if (currentRecord?.status === 'CONFIRMED' && isEventAlreadyAppliedOrSuperseded(currentRecord, event)) {
      await markSbtStatusProjectionEventApplied(durableEvent);
      return false;
    }

    // Event đã durable được hoãn bằng backoff để token legacy không chặn checkpoint hay tạo retry liên tục.
    await scheduleSbtStatusProjectionEventRetry(durableEvent);
    logger.warn('Chưa thể project TokenStatusUpdated vì metadata CONFIRMED chưa sẵn sàng; giữ event PENDING để retry.', {
      tokenId: event.tokenId,
      transactionHash: event.transactionHash,
      logIndex: event.logIndex,
      metadataStatus: currentRecord?.status ?? 'NOT_FOUND'
    });
    return false;
  }

  await invalidateSbtTokenCache(event.tokenId);
  if ((SBT_HIDDEN_FROM_GALLERY_STATUSES as readonly string[]).includes(event.newStatus)) {
    await invalidateSbtGalleryTotalCache(updatedRecord.projectId);
  }

  await markSbtStatusProjectionEventApplied(durableEvent);
  return true;
}

/** Kiểu helper dùng cho test và caller nội bộ để giữ identity event không bị thay đổi khi replay. */
export type SbtStatusProjectionEventIdentity = Pick<
  SbtStatusProjectionEventRecord,
  'chainId' | 'transactionHash' | 'logIndex'
>;
