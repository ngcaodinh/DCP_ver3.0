'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import CyberErrorScreen, { CyberErrorLogLine } from '@/app/components/common/CyberErrorScreen';

type RouteErrorPageProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

/**
 * H?m chu?n h?a m? digest th?nh ??nh d?ng ng?n, an to?n ?? hi?n th?.
 * M?c ??ch: tr?nh l? th?ng tin nh?y c?m nh?ng v?n gi? m? tham chi?u cho v?n h?nh.
 */
function createDigestCode(errorDigest?: string): string {
  if (!errorDigest) {
    return 'NO_DIGEST';
  }

  const normalizedDigestCode = errorDigest.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  return normalizedDigestCode || 'NO_DIGEST';
}

/**
 * H?m t?o s? trace gi? l?p t? digest l?i.
 * M?c ??ch: t?o ch? s? ??ng ki?u cyber ?? gi? tr?i nghi?m nh?t qu?n v?i trang 404.
 */
function createTraceMetricValue(errorDigest?: string): number {
  const digestSourceText = errorDigest || `ROUTE-${Date.now()}`;
  let hashAccumulator = 0;

  for (let characterIndex = 0; characterIndex < digestSourceText.length; characterIndex += 1) {
    // Ghi ch? logic ph?c t?p: d?ng rolling-hash ?? t?o gi? tr? ?n ??nh theo digest nh?ng kh?ng l? n?i dung g?c.
    hashAccumulator = (hashAccumulator * 31 + digestSourceText.charCodeAt(characterIndex)) % 90000000;
  }

  return hashAccumulator + 10000000;
}

/**
 * H?m hi?n th? trang l?i runtime theo chu?n route error boundary c?a Next.js.
 * M?c ??ch: cho ph?p ng??i d?ng th? l?i thao t?c an to?n m? kh?ng r?i kh?i ?ng d?ng.
 */
export default function RouteErrorPage({ error, reset }: RouteErrorPageProps) {
  useEffect(() => {
    console.error('DCP route error boundary:', error);
  }, [error]);

  const digestCode = createDigestCode(error.digest);
  const traceMetricValue = createTraceMetricValue(error.digest);

  const logLineList: CyberErrorLogLine[] = [
    {
      levelText: 'ERROR',
      codeText: digestCode,
      messageText: 'Runtime exception detected in current route segment'
    },
    {
      levelText: 'WARN',
      codeText: 'BOUNDARY',
      messageText: 'Client state has been isolated for safe recovery'
    },
    {
      levelText: 'INFO',
      codeText: 'RETRY',
      messageText: 'Ready to re-render route with reset()',
      animateTyping: true
    }
  ];

  return (
    <CyberErrorScreen
      statusCodeValue={500}
      statusBadgeText='Runtime Exception'
      titleText='Route Processing Error'
      descriptionText='H? th?ng v?a g?p l?i x? l? ? trang hi?n t?i. B?n c? th? th? render l?i route an to?n ho?c quay v? trang ch? ?? ti?p t?c thao t?c.'
      metricLabelText='Trace'
      metricTargetValue={traceMetricValue}
      terminalPathText='~/dcp/runtime-error.log'
      logLineList={logLineList}
      primaryActionNode={
        <button
          type='button'
          onClick={reset}
          className='btn-cyber flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg px-8 py-3 font-bold sm:flex-none'
          style={{
            background: 'linear-gradient(135deg, #00f5ff22, #7b2fff22)',
            border: '1px solid #00f5ff',
            color: '#00f5ff',
            fontSize: '13px',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            boxShadow: '0 0 20px rgba(0,245,255,0.2), inset 0 0 20px rgba(0,245,255,0.05)',
            transition: 'all 0.3s ease'
          }}
          onMouseEnter={event => {
            event.currentTarget.style.boxShadow = '0 0 30px rgba(0,245,255,0.4), inset 0 0 30px rgba(0,245,255,0.1)';
            event.currentTarget.style.transform = 'translateY(-2px)';
          }}
          onMouseLeave={event => {
            event.currentTarget.style.boxShadow = '0 0 20px rgba(0,245,255,0.2), inset 0 0 20px rgba(0,245,255,0.05)';
            event.currentTarget.style.transform = 'translateY(0)';
          }}
        >
          Retry Route
        </button>
      }
      secondaryActionNode={
        <Link
          href='/'
          className='btn-cyber flex-1 items-center justify-center gap-2 rounded-lg px-8 py-3 font-bold sm:flex-none'
          style={{
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.15)',
            color: 'rgba(255,255,255,0.75)',
            fontSize: '13px',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            textDecoration: 'none',
            transition: 'all 0.3s ease'
          }}
          onMouseEnter={event => {
            event.currentTarget.style.borderColor = 'rgba(255,255,255,0.4)';
            event.currentTarget.style.color = 'rgba(255,255,255,1)';
            event.currentTarget.style.transform = 'translateY(-2px)';
          }}
          onMouseLeave={event => {
            event.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)';
            event.currentTarget.style.color = 'rgba(255,255,255,0.75)';
            event.currentTarget.style.transform = 'translateY(0)';
          }}
        >
          Return Home
        </Link>
      }
      footerTagList={['STATUS: 0x500', 'SCOPE: ROUTE', 'RECOVERY: ENABLED', `DIGEST: ${digestCode}`]}
    />
  );
}
