import type { ProjectEventType } from '../constants/projectEventTypes';

export type ProjectEventArchiveState = 'HOT' | 'ARCHIVED';
export type ProjectEventSource = 'api' | 'worker';

export interface ProjectEventRecord {
  eventId: string;
  eventType: ProjectEventType;
  projectId: string | null;
  timestamp: Date;
  walletAddress: string | null;
  amount: number | null;
  correlationId: string | null;
  organizationId: string | null;
  payload: Record<string, unknown>;
  source: ProjectEventSource;
  archiveState: ProjectEventArchiveState;
  archivedAt: Date | null;
  archiveLocator: string | null;
  archiveChecksum: string | null;
  createdAt: Date;
}

export interface LogEventInput {
  eventType: ProjectEventType;
  projectId?: string | null;
  timestamp: Date;
  walletAddress?: string | null;
  amount?: number | null;
  correlationId?: string | null;
  organizationId?: string | null;
  payload?: Record<string, unknown>;
}

/** Bản ghi nằm trong Redis trước khi worker gán thời điểm flush vào createdAt. */
export type QueuedProjectEventRecord = Omit<ProjectEventRecord, 'createdAt'> & { createdAt: null };
