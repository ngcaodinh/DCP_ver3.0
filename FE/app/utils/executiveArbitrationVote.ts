import { buildSameOriginApiUrl, fetchApi } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import { signCommitteeGovernanceVote, type CommitteeVoteSignaturePayload } from '@/app/utils/committeeGovernanceSigner';

/** Ghi một phán quyết qua payload server cấp và chữ ký EIP-712; không có luồng vote client-side thứ hai. */
export async function submitExecutiveArbitrationVote(input: {
  arbitrationId: string;
  decision: 'UPHOLD_PROJECT' | 'REJECT_PROJECT';
  reason: string;
  markedAbusive: boolean;
  donationLockRiskAcknowledged: boolean;
}): Promise<void> {
  const token = readAuthSession().accessToken;
  const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
  const signingPayloadResponse = await fetchApi<CommitteeVoteSignaturePayload | null>(
    buildSameOriginApiUrl('/api/project-governance/executive/signing-payload'),
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ arbitrationId: input.arbitrationId, decision: input.decision, reason: input.reason })
    }
  );
  const eip712Signature = signingPayloadResponse.data
    ? await signCommitteeGovernanceVote(signingPayloadResponse.data)
    : undefined;
  await fetchApi(buildSameOriginApiUrl('/api/project-governance/executive/vote'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...input, eip712Signature })
  });
}
