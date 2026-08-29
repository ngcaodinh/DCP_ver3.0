import type { ReactElement } from 'react';
import { ExecutiveCommitteeLayout } from '@/app/components/governance/ExecutiveCommitteeLayout';

/** Route cổng riêng cho Chủ tịch DAO. */
export default function ExecutiveChairPage(): ReactElement { return <ExecutiveCommitteeLayout viewerRole="CHAIR" />; }
