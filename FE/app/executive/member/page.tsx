import type { ReactElement } from 'react';
import { ExecutiveCommitteeLayout } from '@/app/components/governance/ExecutiveCommitteeLayout';

/** Route cổng riêng cho Ủy viên Điều hành. */
export default function ExecutiveMemberPage(): ReactElement { return <ExecutiveCommitteeLayout viewerRole="MEMBER" />; }
