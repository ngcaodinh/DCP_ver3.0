import { getLogger } from '../config/logger';
import { runWithWorkerContext } from '../config/requestContext';
import { PROJECT_ACTIVATION_BATCH_LIMIT } from '../constants/projectListingPolicy';
import { findPendingArbitrationsExpiredBeforeFromRepository } from '../repositories/projectArbitrationRepository';
import { findProjectsReadyForActivationFromRepository } from '../repositories/projectRepository';
import { activateApprovedProject } from '../services/projectActivation.service';
import { resolveArbitrationByTimeout } from '../services/projectArbitration.service';

const logger = getLogger();
const POLL_INTERVAL_MS = 10 * 60 * 1000;
let intervalId: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

/** Khởi động worker niêm yết và không cho phép double-start trong cùng process. */
export function startProjectActivationWorker(): void {
  if (intervalId) return;
  void runProjectActivationCycle();
  intervalId = setInterval(() => void runProjectActivationCycle(), POLL_INTERVAL_MS);
}

/** Dừng worker để graceful shutdown không giữ event loop. */
export function stopProjectActivationWorker(): void {
  if (!intervalId) return;
  clearInterval(intervalId);
  intervalId = null;
}

/** Quét kích hoạt và timeout độc lập để lỗi một project không giết cả chu kỳ. */
export async function runProjectActivationCycle(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    await runWithWorkerContext('project-activation', async () => {
    const now = new Date();
    const [readyProjects, overdueArbitrations] = await Promise.all([
      findProjectsReadyForActivationFromRepository(now, PROJECT_ACTIVATION_BATCH_LIMIT),
      findPendingArbitrationsExpiredBeforeFromRepository(now, PROJECT_ACTIVATION_BATCH_LIMIT)
    ]);
    for (const project of readyProjects) {
      try { await activateApprovedProject(project.projectId, 'PENDING_ACTIVATION'); }
      catch (error) { logger.error('Project activation worker lỗi dự án.', { projectId: project.projectId, errorMessage: (error as Error).message }); }
    }
    for (const arbitration of overdueArbitrations) {
      try { await resolveArbitrationByTimeout(arbitration.arbitrationId); }
      catch (error) { logger.error('Project activation worker lỗi timeout xét xử.', { arbitrationId: arbitration.arbitrationId, errorMessage: (error as Error).message }); }
    }
    });
  } finally {
    isRunning = false;
  }
}
