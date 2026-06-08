'use client';

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

interface ParticleData {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  radius: number;
  opacity: number;
  color: string;
}

export type CyberErrorLogLevel = 'ERROR' | 'WARN' | 'INFO';

export type CyberErrorLogLine = {
  levelText: CyberErrorLogLevel;
  codeText: string;
  messageText: string;
  animateTyping?: boolean;
};

type CyberErrorScreenProps = {
  statusCodeValue: number;
  statusBadgeText: string;
  titleText: string;
  descriptionText: string;
  metricLabelText: string;
  metricTargetValue: number;
  terminalPathText: string;
  logLineList: CyberErrorLogLine[];
  primaryActionNode: ReactNode;
  secondaryActionNode?: ReactNode;
  footerTagList: string[];
};

/**
 * H?m t?o hi?u ?ng ??m t?ng cho s? li?u tr?ng th?i tr?n m?n h?nh l?i.
 * M?c ??ch: gi?p giao di?n l?i c? c?m gi?c ??ng theo phong c?ch cyber c?a d? ?n.
 */
function useCountUpAnimation(targetValue: number, durationMilliseconds: number): number {
  const [currentValue, setCurrentValue] = useState(0);

  useEffect(() => {
    const startTimestamp = performance.now();

    const animateFrame = (currentTimestamp: number) => {
      const elapsedMilliseconds = currentTimestamp - startTimestamp;
      const progressRatio = Math.min(elapsedMilliseconds / durationMilliseconds, 1);
      const easedProgressRatio = 1 - Math.pow(1 - progressRatio, 3);
      setCurrentValue(Math.floor(easedProgressRatio * targetValue));

      if (progressRatio < 1) {
        requestAnimationFrame(animateFrame);
      }
    };

    requestAnimationFrame(animateFrame);
  }, [targetValue, durationMilliseconds]);

  return currentValue;
}

/**
 * H?m d?ng canvas particle n?n cho trang l?i cyber.
 * M?c ??ch: t?o chi?u s?u th? gi?c gi?ng giao di?n `not-found.tsx` g?c.
 */
function ParticleCanvas() {
  const canvasReference = useRef<HTMLCanvasElement>(null);
  const animationFrameReference = useRef<number>(0);

  useEffect(() => {
    const canvasElement = canvasReference.current;
    if (!canvasElement) {
      return;
    }

    const drawingContext = canvasElement.getContext('2d');
    if (!drawingContext) {
      return;
    }

    const particleColorList = ['#00f5ff', '#7b2fff', '#ff006e', '#00ff88'];
    const particleDataList: ParticleData[] = [];
    const totalParticleCount = 80;

    const resizeCanvas = () => {
      canvasElement.width = window.innerWidth;
      canvasElement.height = window.innerHeight;
    };

    const initializeParticles = () => {
      particleDataList.length = 0;

      for (let index = 0; index < totalParticleCount; index += 1) {
        particleDataList.push({
          x: Math.random() * canvasElement.width,
          y: Math.random() * canvasElement.height,
          velocityX: (Math.random() - 0.5) * 0.6,
          velocityY: (Math.random() - 0.5) * 0.6,
          radius: Math.random() * 1.5 + 0.5,
          opacity: Math.random() * 0.6 + 0.2,
          color: particleColorList[Math.floor(Math.random() * particleColorList.length)]
        });
      }
    };

    const drawConnectionLine = (sourceParticle: ParticleData, targetParticle: ParticleData, distanceValue: number) => {
      const maxConnectionDistance = 120;
      const lineOpacity = (1 - distanceValue / maxConnectionDistance) * 0.25;

      drawingContext.beginPath();
      drawingContext.moveTo(sourceParticle.x, sourceParticle.y);
      drawingContext.lineTo(targetParticle.x, targetParticle.y);
      drawingContext.strokeStyle = `rgba(0, 245, 255, ${lineOpacity})`;
      drawingContext.lineWidth = 0.5;
      drawingContext.stroke();
    };

    const drawFrame = () => {
      drawingContext.clearRect(0, 0, canvasElement.width, canvasElement.height);

      for (let sourceIndex = 0; sourceIndex < particleDataList.length; sourceIndex += 1) {
        const currentParticle = particleDataList[sourceIndex];

        currentParticle.x += currentParticle.velocityX;
        currentParticle.y += currentParticle.velocityY;

        if (currentParticle.x < 0 || currentParticle.x > canvasElement.width) {
          currentParticle.velocityX *= -1;
        }

        if (currentParticle.y < 0 || currentParticle.y > canvasElement.height) {
          currentParticle.velocityY *= -1;
        }

        drawingContext.beginPath();
        drawingContext.arc(currentParticle.x, currentParticle.y, currentParticle.radius, 0, Math.PI * 2);
        drawingContext.globalAlpha = currentParticle.opacity;
        drawingContext.fillStyle = currentParticle.color;
        drawingContext.fill();
        drawingContext.globalAlpha = 1;

        for (let targetIndex = sourceIndex + 1; targetIndex < particleDataList.length; targetIndex += 1) {
          const targetParticle = particleDataList[targetIndex];
          const distanceX = currentParticle.x - targetParticle.x;
          const distanceY = currentParticle.y - targetParticle.y;
          const distanceValue = Math.sqrt(distanceX * distanceX + distanceY * distanceY);

          if (distanceValue < 120) {
            drawConnectionLine(currentParticle, targetParticle, distanceValue);
          }
        }
      }

      animationFrameReference.current = requestAnimationFrame(drawFrame);
    };

    const handleWindowResize = () => {
      resizeCanvas();
      initializeParticles();
    };

    resizeCanvas();
    initializeParticles();
    drawFrame();

    window.addEventListener('resize', handleWindowResize);

    return () => {
      cancelAnimationFrame(animationFrameReference.current);
      window.removeEventListener('resize', handleWindowResize);
    };
  }, []);

  return <canvas ref={canvasReference} className='fixed inset-0 h-full w-full pointer-events-none' style={{ zIndex: 0 }} />;
}

/**
 * H?m tr? v? m?u theo c?p log terminal.
 * M?c ??ch: gi? m?u tr?ng th?i ERROR/WARN/INFO nh?t qu?n v?i phong c?ch cyber.
 */
function resolveLogLevelColor(levelText: CyberErrorLogLevel): string {
  if (levelText === 'ERROR') {
    return '#ff006e';
  }

  if (levelText === 'WARN') {
    return '#febc2e';
  }

  return '#00f5ff';
}

/**
 * H?m hi?n th? text glitch cho m? l?i l?n.
 * M?c ??ch: t?i hi?n hi?u ?ng nhi?u ??c tr?ng c?a trang l?i Web3/cyberpunk.
 */
function GlitchText({ text }: { text: string }) {
  return (
    <span className='relative inline-block' data-text={text}>
      <style>{`
        .glitch-text {
          position: relative;
          display: inline-block;
        }
        .glitch-text::before,
        .glitch-text::after {
          content: attr(data-text);
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
        }
        .glitch-text::before {
          animation: glitch-before 3s infinite;
          color: #ff006e;
          clip-path: polygon(0 0, 100% 0, 100% 35%, 0 35%);
        }
        .glitch-text::after {
          animation: glitch-after 3s infinite;
          color: #00f5ff;
          clip-path: polygon(0 65%, 100% 65%, 100% 100%, 0 100%);
        }
        @keyframes glitch-before {
          0%, 90%, 100% { transform: translate(0); opacity: 0; }
          92% { transform: translate(-3px, 1px); opacity: 0.8; }
          94% { transform: translate(3px, -1px); opacity: 0.8; }
          96% { transform: translate(-2px, 2px); opacity: 0.8; }
          98% { transform: translate(0); opacity: 0; }
        }
        @keyframes glitch-after {
          0%, 88%, 100% { transform: translate(0); opacity: 0; }
          90% { transform: translate(3px, 2px); opacity: 0.8; }
          92% { transform: translate(-3px, -1px); opacity: 0.8; }
          94% { transform: translate(2px, 1px); opacity: 0.8; }
          96% { transform: translate(0); opacity: 0; }
        }
        @keyframes scanline {
          0% { transform: translateY(-100%); }
          100% { transform: translateY(100vh); }
        }
        @keyframes pulse-border {
          0%, 100% { box-shadow: 0 0 0 0 rgba(0, 245, 255, 0.4); }
          50% { box-shadow: 0 0 0 8px rgba(0, 245, 255, 0); }
        }
        @keyframes typing {
          from { width: 0; }
          to { width: 100%; }
        }
        @keyframes blink-cursor {
          0%, 100% { border-right-color: #00f5ff; }
          50% { border-right-color: transparent; }
        }
        @keyframes float-up {
          0% { opacity: 0; transform: translateY(30px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        .terminal-text {
          overflow: hidden;
          white-space: nowrap;
          border-right: 2px solid #00f5ff;
          animation: typing 2s steps(30, end) 0.5s both, blink-cursor 0.8s step-end infinite;
        }
        .btn-cyber {
          position: relative;
          overflow: hidden;
          transition: all 0.3s ease;
        }
        .btn-cyber::before {
          content: '';
          position: absolute;
          top: 0;
          left: -100%;
          width: 100%;
          height: 100%;
          background: linear-gradient(90deg, transparent, rgba(0, 245, 255, 0.2), transparent);
          transition: left 0.4s ease;
        }
        .btn-cyber:hover::before {
          left: 100%;
        }
        .animate-float-up {
          animation: float-up 0.6s ease forwards;
        }
        .delay-100 { animation-delay: 0.1s; opacity: 0; }
        .delay-200 { animation-delay: 0.2s; opacity: 0; }
        .delay-300 { animation-delay: 0.3s; opacity: 0; }
        .delay-400 { animation-delay: 0.4s; opacity: 0; }
        .delay-500 { animation-delay: 0.5s; opacity: 0; }
        .delay-600 { animation-delay: 0.6s; opacity: 0; }
      `}</style>
      <span className='glitch-text' data-text={text}>
        {text}
      </span>
    </span>
  );
}

/**
 * H?m chu?n h?a m? l?i hi?n th? trong l?c animation ch?y.
 * M?c ??ch: gi? s? hi?n th? ?? ch? s? tr??c khi k?t th?c hi?u ?ng ??m.
 */
function formatAnimatedStatusCode(animatedStatusCode: number, targetStatusCode: number): string {
  const statusCodeLength = String(targetStatusCode).length;
  return String(animatedStatusCode).padStart(statusCodeLength, '0');
}

/**
 * H?m d?ng giao di?n l?i cyber d?ng chung.
 * M?c ??ch: t?i s? d?ng m?t layout nh?t qu?n cho 404, 500 v? global error.
 */
export default function CyberErrorScreen({
  statusCodeValue,
  statusBadgeText,
  titleText,
  descriptionText,
  metricLabelText,
  metricTargetValue,
  terminalPathText,
  logLineList,
  primaryActionNode,
  secondaryActionNode,
  footerTagList
}: CyberErrorScreenProps) {
  const animatedStatusCode = useCountUpAnimation(statusCodeValue, 1200);
  const animatedMetricValue = useCountUpAnimation(metricTargetValue, 1800);
  const [isGlitching, setIsGlitching] = useState(false);
  const glitchTimeoutReference = useRef<number | undefined>(undefined);

  useEffect(() => {
    const glitchIntervalIdentifier = window.setInterval(() => {
      setIsGlitching(true);

      if (glitchTimeoutReference.current) {
        window.clearTimeout(glitchTimeoutReference.current);
      }

      glitchTimeoutReference.current = window.setTimeout(() => {
        setIsGlitching(false);
      }, 400);
    }, 4000);

    return () => {
      window.clearInterval(glitchIntervalIdentifier);

      if (glitchTimeoutReference.current) {
        window.clearTimeout(glitchTimeoutReference.current);
      }
    };
  }, []);

  const animatedStatusCodeText = formatAnimatedStatusCode(animatedStatusCode, statusCodeValue);

  return (
    <div
      className='relative flex min-h-screen flex-col items-center justify-center overflow-hidden'
      style={{ background: '#020408', fontFamily: "'JetBrains Mono', 'Courier New', monospace" }}
    >
      <ParticleCanvas />

      <div
        className='fixed inset-0 pointer-events-none'
        style={{
          background: 'radial-gradient(ellipse at 50% 50%, rgba(123,47,255,0.08) 0%, transparent 70%)',
          zIndex: 1
        }}
      />

      <div className='fixed inset-0 pointer-events-none overflow-hidden' style={{ zIndex: 2 }}>
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '2px',
            background: 'linear-gradient(90deg, transparent, rgba(0,245,255,0.6), transparent)',
            animation: 'scanline 6s linear infinite',
            opacity: 0.4
          }}
        />
      </div>

      <main className='relative flex w-full max-w-2xl flex-col items-center px-6 py-12 text-center' style={{ zIndex: 10 }}>
        <div
          className='animate-float-up delay-100 mb-8 inline-flex items-center gap-2 rounded-full px-4 py-2'
          style={{
            border: '1px solid rgba(255, 0, 110, 0.5)',
            background: 'rgba(255, 0, 110, 0.08)',
            color: '#ff006e',
            fontSize: '11px',
            letterSpacing: '0.2em',
            textTransform: 'uppercase'
          }}
        >
          <span
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: '#ff006e',
              display: 'inline-block',
              animation: 'pulse-border 1.5s ease-in-out infinite',
              boxShadow: '0 0 8px #ff006e'
            }}
          />
          {statusBadgeText} ? {metricLabelText} #{animatedMetricValue.toLocaleString()}
        </div>

        <div
          className='animate-float-up delay-200 relative mb-2 select-none'
          style={{
            fontSize: 'clamp(100px, 22vw, 180px)',
            fontWeight: 900,
            lineHeight: 1,
            letterSpacing: '-0.04em',
            color: '#00f5ff',
            filter: isGlitching
              ? 'drop-shadow(3px 0 0 #ff006e) drop-shadow(-3px 0 0 #7b2fff)'
              : 'drop-shadow(0 0 20px rgba(0,245,255,0.5))',
            transition: 'filter 0.05s'
          }}
        >
          {animatedStatusCode === statusCodeValue ? (
            <GlitchText text={String(statusCodeValue)} />
          ) : (
            <span>{animatedStatusCodeText}</span>
          )}
        </div>

        <h1
          className='animate-float-up delay-300 mb-3'
          style={{
            fontSize: 'clamp(18px, 4vw, 26px)',
            fontWeight: 700,
            color: '#e2e8f0',
            letterSpacing: '0.05em',
            textTransform: 'uppercase'
          }}
        >
          {titleText}
        </h1>

        <p
          className='animate-float-up delay-400 mb-8 max-w-xl'
          style={{
            color: 'rgba(226,232,240,0.7)',
            fontSize: '14px',
            lineHeight: 1.8
          }}
        >
          {descriptionText}
        </p>

        <div
          className='scanline-effect animate-float-up delay-400 mb-8 w-full rounded-xl p-5 text-left'
          style={{
            border: '1px solid rgba(255,255,255,0.1)',
            background: 'rgba(15,23,42,0.35)',
            boxShadow: 'inset 0 0 24px rgba(0,0,0,0.2)'
          }}
        >
          <div className='mb-3 flex items-center gap-2'>
            <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#ff5f57', display: 'inline-block' }} />
            <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#febc2e', display: 'inline-block' }} />
            <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#28c840', display: 'inline-block' }} />
            <span style={{ marginLeft: '8px', fontSize: '11px', color: 'rgba(255,255,255,0.3)', letterSpacing: '0.1em' }}>
              {terminalPathText}
            </span>
          </div>

          <div style={{ fontSize: '12px', lineHeight: 2, color: 'rgba(255,255,255,0.7)' }}>
            {logLineList.map((logLine, lineIndex) => (
              <p key={`${logLine.codeText}-${lineIndex}`}>
                <span style={{ color: resolveLogLevelColor(logLine.levelText) }}>{logLine.levelText}</span>
                <span style={{ color: 'rgba(255,255,255,0.3)' }}> [{logLine.codeText}] </span>
                {logLine.animateTyping ? <span className='terminal-text'>{logLine.messageText}</span> : logLine.messageText}
              </p>
            ))}
          </div>
        </div>

        <div className='animate-float-up delay-500 flex w-full flex-col gap-4 sm:w-auto sm:flex-row'>
          {primaryActionNode}
          {secondaryActionNode}
        </div>

        <div
          className='animate-float-up delay-600 mt-12 flex flex-wrap justify-center gap-4 sm:gap-6'
          style={{ fontSize: '11px', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.08em' }}
        >
          {footerTagList.map((footerTagText, tagIndex) => (
            <span key={`${footerTagText}-${tagIndex}`}>
              {footerTagText}
              {tagIndex < footerTagList.length - 1 ? <span style={{ color: 'rgba(255,255,255,0.1)' }}> | </span> : null}
            </span>
          ))}
        </div>
      </main>
    </div>
  );
}
