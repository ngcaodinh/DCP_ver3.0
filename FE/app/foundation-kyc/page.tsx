import type { Metadata } from 'next';
import Link from 'next/link';
import Script from 'next/script';
import FoundationKycForm from '../components/foundationKyc/FoundationKycForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Xác minh tài khoản nhận quyên góp | DCP',
  description: 'Cổng công khai dành cho Quỹ từ thiện đăng ký xác minh tài khoản ngân hàng trung tâm nhận tiền quyên góp.',
  robots: { index: false, follow: false }
};

/** Hiển thị shell server cho cổng KYC public và chỉ tải reCAPTCHA tại route cần dùng. */
export default function FoundationKycPage(): React.ReactElement {
  const recaptchaSiteKey = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY || '';

  return (
    <main className="min-h-screen bg-[#f4fbfa] py-5 sm:py-8">
      <div className="px-4 sm:px-6">
        <div className="mx-auto max-w-7xl">
          <header className="mb-6 flex flex-col items-start gap-3 px-1 sm:mb-8 sm:flex-row sm:items-center sm:justify-between sm:px-3">
          <Link href="/" aria-label="DCP - Trang chủ" className="logo rounded-xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-100">
            <div className="logo-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M12 21.7C5.8 17.5 2 13.2 2 9a6 6 0 0112 0 6 6 0 0112 0c0 4.2-3.8 8.5-10 12.7z" />
              </svg>
            </div>
            <div>
              <span className="logo-text">DCP</span>
              <span className="logo-tag">Minh bạch tuyệt đối</span>
            </div>
          </Link>
          </header>
          {recaptchaSiteKey ? (
            <Script
              src={`https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(recaptchaSiteKey)}`}
              strategy="afterInteractive"
            />
          ) : null}
          <FoundationKycForm recaptchaSiteKey={recaptchaSiteKey} />
        </div>
      </div>

      <footer>
        <div className="footer-grid">
          <div className="footer-brand">
            <a href="#" className="logo footer-logo">
              <div className="logo-icon">
                <svg viewBox="0 0 24 24" className="footer-logo-icon">
                  <path d="M12 21.7C5.8 17.5 2 13.2 2 9a6 6 0 0112 0 6 6 0 0112 0c0 4.2-3.8 8.5-10 12.7z" />
                </svg>
              </div>
              <div>
                <span className="logo-text">DCP</span>
                <span className="logo-tag">Minh bạch tuyệt đối</span>
              </div>
            </a>
            <p className="footer-desc">
              Nền tảng từ thiện phi tập trung đầu tiên tại Việt Nam, kết hợp Blockchain và hệ thống thanh toán truyền thống.
            </p>
            <div className="social-links">
              <a href="https://zalo.me/0367400325" className="social-btn" target="_blank" rel="noopener noreferrer">𝕏</a>
              <a href="https://zalo.me/0367400325" className="social-btn" target="_blank" rel="noopener noreferrer">f</a>
              <a href="https://zalo.me/0367400325" className="social-btn" target="_blank" rel="noopener noreferrer">in</a>
              <a href="https://zalo.me/0367400325" className="social-btn" target="_blank" rel="noopener noreferrer">⛓</a>
            </div>
          </div>
          <div className="footer-col">
            <h4>Nền tảng</h4>
            <ul>
              <li><a href="#">Dự án đang mở</a></li>
              <li><a href="#">Bảng xếp hạng QF</a></li>
              <li><a href="/transparency">Transparency Dashboard</a></li>
              <li><a href="/foundation-kyc">Đăng ký tổ chức</a></li>
            </ul>
          </div>
          <div className="footer-col">
            <h4>Về DCP</h4>
            <ul>
              <li><a href="#">Giới thiệu</a></li>
              <li><a href="#">Cách hoạt động</a></li>
              <li><a href="#">Công nghệ</a></li>
              <li><a href="#">Blog</a></li>
            </ul>
          </div>
          <div className="footer-col">
            <h4>Hỗ trợ</h4>
            <ul>
              <li><a href="#">Điều khoản sử dụng</a></li>
              <li><a href="#">Chính sách bảo mật</a></li>
              <li><a href="tel:0367400325">Liên hệ: 0367400325</a></li>
              <li><a href="https://zalo.me/0367400325" target="_blank" rel="noopener noreferrer">Zalo: 0367400325</a></li>
            </ul>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© 2025 DCP — Decentralized Charity Platform. All rights reserved.</span>
          <div className="footer-tech">
            <span className="tech-badge">⛓ Polygon Amoy</span>
            <span className="tech-badge">💳 PayOS</span>
            <span className="tech-badge">🔐 ERC-4337</span>
            <span className="tech-badge">📦 IPFS</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
