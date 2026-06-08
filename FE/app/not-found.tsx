"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

// Kiểu dữ liệu cho một hạt trong hiệu ứng particle
interface ParticleData {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  radius: number;
  opacity: number;
  color: string;
}

/**
 * Hook tùy chỉnh: tạo hiệu ứng đếm ngược số giả lập "đang tải"
 * Trả về số hiện tại đang đếm lên, mô phỏng cảm giác blockchain scanning
 */
function useCountUpAnimation(targetValue: number, durationMs: number): number {
  const [currentValue, setCurrentValue] = useState(0);

  useEffect(() => {
    const startTime = performance.now();

    const animateCount = (timestamp: number) => {
      const elapsed = timestamp - startTime;
      const progress = Math.min(elapsed / durationMs, 1);
      // Easing: ease-out cubic
      const easedProgress = 1 - Math.pow(1 - progress, 3);
      setCurrentValue(Math.floor(easedProgress * targetValue));

      if (progress < 1) {
        requestAnimationFrame(animateCount);
      }
    };

    requestAnimationFrame(animateCount);
  }, [targetValue, durationMs]);

  return currentValue;
}

/**
 * Component canvas vẽ các hạt nổi (particle field)
 * Tạo hiệu ứng nền không gian số cho trang lỗi Web3
 */
function ParticleCanvas() {
  const canvasReference = useRef<HTMLCanvasElement>(null);
  const animationFrameId = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasReference.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const particleColors = ["#00f5ff", "#7b2fff", "#ff006e", "#00ff88"];
    const particles: ParticleData[] = [];
    const totalParticles = 80;

    // Thiết lập kích thước canvas theo cửa sổ trình duyệt
    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    // Khởi tạo các hạt với vị trí và vận tốc ngẫu nhiên
    const initializeParticles = () => {
      particles.length = 0;
      for (let index = 0; index < totalParticles; index++) {
        particles.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          velocityX: (Math.random() - 0.5) * 0.6,
          velocityY: (Math.random() - 0.5) * 0.6,
          radius: Math.random() * 1.5 + 0.5,
          opacity: Math.random() * 0.6 + 0.2,
          color: particleColors[Math.floor(Math.random() * particleColors.length)],
        });
      }
    };

    // Vẽ đường kết nối giữa các hạt gần nhau (tạo cảm giác mạng lưới)
    const drawConnectionLine = (particleA: ParticleData, particleB: ParticleData, distance: number) => {
      const maxConnectionDistance = 120;
      const lineOpacity = (1 - distance / maxConnectionDistance) * 0.25;
      context.beginPath();
      context.moveTo(particleA.x, particleA.y);
      context.lineTo(particleB.x, particleB.y);
      context.strokeStyle = `rgba(0, 245, 255, ${lineOpacity})`;
      context.lineWidth = 0.5;
      context.stroke();
    };

    // Vẽ toàn bộ frame animation
    const drawFrame = () => {
      context.clearRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < particles.length; i++) {
        const particle = particles[i];

        // Di chuyển hạt
        particle.x += particle.velocityX;
        particle.y += particle.velocityY;

        // Bounce khi chạm viền
        if (particle.x < 0 || particle.x > canvas.width) particle.velocityX *= -1;
        if (particle.y < 0 || particle.y > canvas.height) particle.velocityY *= -1;

        // Vẽ hạt
        context.beginPath();
        context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        context.fillStyle = particle.color.replace(")", `, ${particle.opacity})`).replace("rgb", "rgba").replace("#", "rgba(").replace("rgba(", "rgba(").replace("00f5ff,", "0,245,255,").replace("7b2fff,", "123,47,255,").replace("ff006e,", "255,0,110,").replace("00ff88,", "0,255,136,");

        // Dùng fillStyle đơn giản hơn
        context.globalAlpha = particle.opacity;
        context.fillStyle = particle.color;
        context.fill();
        context.globalAlpha = 1;

        // Kết nối các hạt gần nhau
        for (let j = i + 1; j < particles.length; j++) {
          const other = particles[j];
          const dx = particle.x - other.x;
          const dy = particle.y - other.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < 120) {
            drawConnectionLine(particle, other, distance);
          }
        }
      }

      animationFrameId.current = requestAnimationFrame(drawFrame);
    };

    resizeCanvas();
    initializeParticles();
    drawFrame();

    window.addEventListener("resize", () => {
      resizeCanvas();
      initializeParticles();
    });

    return () => {
      cancelAnimationFrame(animationFrameId.current);
      window.removeEventListener("resize", resizeCanvas);
    };
  }, []);

  return (
    <canvas
      ref={canvasReference}
      className="fixed inset-0 w-full h-full pointer-events-none"
      style={{ zIndex: 0 }}
    />
  );
}

/**
 * Component hiển thị dòng chữ với hiệu ứng glitch (nhiễu hình ảnh)
 * Mô phỏng lỗi tín hiệu số đặc trưng của thẩm mỹ Web3/cyberpunk
 */
function GlitchText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={`relative inline-block ${className}`} data-text={text}>
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
        @keyframes flicker {
          0%, 98%, 100% { opacity: 1; }
          99% { opacity: 0.4; }
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
        .terminal-text {
          overflow: hidden;
          white-space: nowrap;
          border-right: 2px solid #00f5ff;
          animation: typing 2s steps(30, end) 0.5s both, blink-cursor 0.8s step-end infinite;
        }
        .scanline-effect::after {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(transparent 50%, rgba(0, 0, 0, 0.03) 50%);
          background-size: 100% 4px;
          pointer-events: none;
          border-radius: inherit;
        }
        .neon-glow {
          text-shadow: 0 0 10px rgba(0, 245, 255, 0.8), 0 0 20px rgba(0, 245, 255, 0.4), 0 0 40px rgba(0, 245, 255, 0.2);
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
        @keyframes float-up {
          0% { opacity: 0; transform: translateY(30px); }
          100% { opacity: 1; transform: translateY(0); }
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
        .delay-700 { animation-delay: 0.7s; opacity: 0; }
      `}</style>
      <span className="glitch-text" data-text={text}>{text}</span>
    </span>
  );
}

/**
 * Trang lỗi 404 với phong cách Web3/Cyberpunk
 * Hiển thị khi người dùng truy cập URL không tồn tại trong ứng dụng
 */
export default function NotFoundPage() {
  const errorCode = useCountUpAnimation(404, 1200);
  const blockNumber = useCountUpAnimation(19847362, 1800);
  const [isGlitching, setIsGlitching] = useState(false);

  // Kích hoạt hiệu ứng glitch định kỳ
  useEffect(() => {
    const glitchInterval = setInterval(() => {
      setIsGlitching(true);
      setTimeout(() => setIsGlitching(false), 400);
    }, 4000);

    return () => clearInterval(glitchInterval);
  }, []);

  return (
    <div
      className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden"
      style={{ background: "#020408", fontFamily: "'JetBrains Mono', 'Courier New', monospace" }}
    >
      {/* Nền particle animation */}
      <ParticleCanvas />

      {/* Lớp overlay gradient */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          background: "radial-gradient(ellipse at 50% 50%, rgba(123,47,255,0.08) 0%, transparent 70%)",
          zIndex: 1,
        }}
      />

      {/* Đường quét scanline toàn màn hình */}
      <div
        className="fixed inset-0 pointer-events-none overflow-hidden"
        style={{ zIndex: 2 }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "2px",
            background: "linear-gradient(90deg, transparent, rgba(0,245,255,0.6), transparent)",
            animation: "scanline 6s linear infinite",
            opacity: 0.4,
          }}
        />
      </div>

      {/* Nội dung chính */}
      <main
        className="relative flex flex-col items-center text-center px-6 py-12 max-w-2xl w-full"
        style={{ zIndex: 10 }}
      >

        {/* Badge trạng thái lỗi blockchain */}
        <div
          className="animate-float-up delay-100 mb-8 inline-flex items-center gap-2 px-4 py-2 rounded-full"
          style={{
            border: "1px solid rgba(255, 0, 110, 0.5)",
            background: "rgba(255, 0, 110, 0.08)",
            color: "#ff006e",
            fontSize: "11px",
            letterSpacing: "0.2em",
            textTransform: "uppercase",
          }}
        >
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: "#ff006e",
              display: "inline-block",
              animation: "pulse-border 1.5s ease-in-out infinite",
              boxShadow: "0 0 8px #ff006e",
            }}
          />
          Transaction Reverted · Block #{blockNumber.toLocaleString()}
        </div>

        {/* Số lỗi 404 lớn với hiệu ứng glitch */}
        <div
          className="animate-float-up delay-200 relative select-none mb-2"
          style={{
            fontSize: "clamp(100px, 22vw, 180px)",
            fontWeight: 900,
            lineHeight: 1,
            letterSpacing: "-0.04em",
            color: "#00f5ff",
            filter: isGlitching
              ? "drop-shadow(3px 0 0 #ff006e) drop-shadow(-3px 0 0 #7b2fff)"
              : "drop-shadow(0 0 20px rgba(0,245,255,0.5))",
            transition: "filter 0.05s",
          }}
        >
          {errorCode === 404 ? (
            <GlitchText text="404" />
          ) : (
            <span>{String(errorCode).padStart(3, "0")}</span>
          )}
        </div>

        {/* Tiêu đề lỗi */}
        <h1
          className="animate-float-up delay-300 mb-3"
          style={{
            fontSize: "clamp(18px, 4vw, 26px)",
            fontWeight: 700,
            color: "#e2e8f0",
            letterSpacing: "0.05em",
            textTransform: "uppercase",
          }}
        >
          Page Not Found
        </h1>

        {/* Mô tả lỗi kiểu terminal */}
        <div
          className="animate-float-up delay-400 mb-8 relative scanline-effect"
          style={{
            background: "rgba(0, 0, 0, 0.6)",
            border: "1px solid rgba(0, 245, 255, 0.2)",
            borderRadius: "8px",
            padding: "20px 24px",
            width: "100%",
            textAlign: "left",
          }}
        >
          {/* Thanh tiêu đề terminal */}
          <div className="flex items-center gap-2 mb-3 pb-3" style={{ borderBottom: "1px solid rgba(0,245,255,0.15)" }}>
            <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#ff5f57", display: "inline-block" }} />
            <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#febc2e", display: "inline-block" }} />
            <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#28c840", display: "inline-block" }} />
            <span style={{ marginLeft: "8px", fontSize: "11px", color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em" }}>
              ~/web3/error.log
            </span>
          </div>

          {/* Nội dung log terminal */}
          <div style={{ fontSize: "12px", lineHeight: 2, color: "rgba(255,255,255,0.7)" }}>
            <p>
              <span style={{ color: "#ff006e" }}>ERROR</span>
              <span style={{ color: "rgba(255,255,255,0.3)" }}> [0x4E4F4654] </span>
              Route not found in the network
            </p>
            <p>
              <span style={{ color: "#febc2e" }}>WARN</span>
              <span style={{ color: "rgba(255,255,255,0.3)" }}>  [0x52455645] </span>
              Smart contract returned null pointer
            </p>
            <p>
              <span style={{ color: "#00f5ff" }}>INFO</span>
              <span style={{ color: "rgba(255,255,255,0.3)" }}>  [0x48454C50] </span>
              <span className="terminal-text">Redirecting to safe zone...</span>
            </p>
          </div>
        </div>

        {/* Các nút hành động */}
        <div className="animate-float-up delay-500 flex flex-col sm:flex-row gap-4 w-full sm:w-auto">
          {/* Nút quay về trang chủ - nổi bật */}
          <Link
            href="/"
            className="btn-cyber flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-8 py-3 rounded-lg font-bold"
            style={{
              background: "linear-gradient(135deg, #00f5ff22, #7b2fff22)",
              border: "1px solid #00f5ff",
              color: "#00f5ff",
              fontSize: "13px",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              textDecoration: "none",
              boxShadow: "0 0 20px rgba(0,245,255,0.2), inset 0 0 20px rgba(0,245,255,0.05)",
              transition: "all 0.3s ease",
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.boxShadow = "0 0 30px rgba(0,245,255,0.4), inset 0 0 30px rgba(0,245,255,0.1)";
              event.currentTarget.style.transform = "translateY(-2px)";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.boxShadow = "0 0 20px rgba(0,245,255,0.2), inset 0 0 20px rgba(0,245,255,0.05)";
              event.currentTarget.style.transform = "translateY(0)";
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            Return Home
          </Link>

          {/* Nút quay lại trang trước */}
          <button
            onClick={() => window.history.back()}
            className="btn-cyber flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-8 py-3 rounded-lg font-bold cursor-pointer"
            style={{
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.15)",
              color: "rgba(255,255,255,0.7)",
              fontSize: "13px",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              transition: "all 0.3s ease",
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.borderColor = "rgba(255,255,255,0.4)";
              event.currentTarget.style.color = "rgba(255,255,255,1)";
              event.currentTarget.style.transform = "translateY(-2px)";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.borderColor = "rgba(255,255,255,0.15)";
              event.currentTarget.style.color = "rgba(255,255,255,0.7)";
              event.currentTarget.style.transform = "translateY(0)";
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m12 19-7-7 7-7" />
              <path d="M19 12H5" />
            </svg>
            Go Back
          </button>
        </div>

        {/* Thông tin kỹ thuật phía dưới */}
        <div
          className="animate-float-up delay-600 mt-12 flex flex-wrap justify-center gap-6"
          style={{ fontSize: "11px", color: "rgba(255,255,255,0.25)", letterSpacing: "0.08em" }}
        >
          <span>STATUS: 0x404</span>
          <span style={{ color: "rgba(255,255,255,0.1)" }}>|</span>
          <span>CHAIN: MAINNET</span>
          <span style={{ color: "rgba(255,255,255,0.1)" }}>|</span>
          <span>GAS: NULL</span>
          <span style={{ color: "rgba(255,255,255,0.1)" }}>|</span>
          <span>TX: 0x0000...0000</span>
        </div>
      </main>
    </div>
  );
}
