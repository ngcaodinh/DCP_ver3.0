'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import CyberErrorScreen, { CyberErrorLogLine } from '@/app/components/common/CyberErrorScreen';

type GlobalErrorPageProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

/**
 * H?m chu?n h?a m? digest th?nh ??nh d?ng ng?n cho global error.
 * M?c ??ch: ??m b?o hi?n th? m? tham chi?u ng?n g?n m? kh?ng l? d? li?u nh?y c?m.
 */
function createDigestCode(errorDigest?: string): string {
  if (!errorDigest) {
    return 'GLOBAL_NO_DIGEST';
  }

  const normalizedDigestCode = errorDigest.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  return normalizedDigestCode || 'GLOBAL_NO_DIGEST';
}

/**
 * H?m t?o m? heartbeat gi? l?p cho global error.
 * M?c ??ch: gi? tr?i nghi?m animation cyber ??ng nh?t gi?a c?c trang l?i.
 */
function createHeartbeatMetricValue(errorDigest?: string): number {
  const digestSourceText = errorDigest || `GLOBAL-${Date.now()}`;
  let hashAccumulator = 0;

  for (let characterIndex = 0; characterIndex < digestSourceText.length; characterIndex += 1) {
    // Ghi ch? logic ph?c t?p: rolling-hash gi?p t?o ch? s? ?n ??nh m? kh?ng ph? thu?c v?o m?i tr??ng runtime.
    hashAccumulator = (hashAccumulator * 37 + digestSourceText.charCodeAt(characterIndex)) % 90000000;
  }

  return hashAccumulator + 10000000;
}

/**
 * H?m hi?n th? trang l?i global theo chu?n global-error c?a Next.js.
 * M?c ??ch: cung c?p fallback cu?i c?ng khi l?i x?y ra ? m?c root layout.
 */
export default function GlobalErrorPage({ error, reset }: GlobalErrorPageProps) {
  useEffect(() => {
    Sentry.captureException(error);
    console.error('DCP global error boundary:', error);
  }, [error]);

  const digestCode = createDigestCode(error.digest);
  const heartbeatMetricValue = createHeartbeatMetricValue(error.digest);

  const logLineList: CyberErrorLogLine[] = [
    {
      levelText: 'ERROR',
      codeText: digestCode,
      messageText: 'Global shell exception interrupted root layout rendering'
    },
    {
      levelText: 'WARN',
      codeText: 'LAYOUT',
      messageText: 'Fallback boundary is active in safe recovery mode'
    },
    {
      levelText: 'INFO',
      codeText: 'RELOAD',
      messageText: 'Awaiting full page reload or shell reset()',
      animateTyping: true
    }
  ];

  return (
    <html lang='vi'>
      <body>
        <CyberErrorScreen
          statusCodeValue={500}
          statusBadgeText='Global Fault'
          titleText='Core Interface Interrupted'
          descriptionText='H? th?ng ?ang g?p l?i ? t?ng giao di?n g?c. B?n c? th? th? kh?i ph?c shell nhanh ho?c t?i l?i to?n b? trang ?? t?i t?o tr?ng th?i an to?n.'
          metricLabelText='Heartbeat'
          metricTargetValue={heartbeatMetricValue}
          terminalPathText='~/dcp/global-error.log'
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
              Reset Shell
            </button>
          }
          secondaryActionNode={
            <button
              type='button'
              onClick={() => window.location.reload()}
              className='btn-cyber flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg px-8 py-3 font-bold sm:flex-none'
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.15)',
                color: 'rgba(255,255,255,0.75)',
                fontSize: '13px',
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
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
              Reload App
            </button>
          }
          footerTagList={['STATUS: 0x500', 'SCOPE: GLOBAL', 'MODE: SAFE_FALLBACK', `DIGEST: ${digestCode}`]}
        />
      </body>
    </html>
  );
}
