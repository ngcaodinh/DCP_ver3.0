/** Hàm head cho trang nạp tiền. Mục đích: chặn index trang giao dịch cá nhân để giảm rủi ro SEO và lộ intent nội bộ. */
export default function Head() {
  return (
    <>
      <title>Nạp tiền | DCP</title>
      <meta name="robots" content="noindex, nofollow, noarchive" />
      <link rel="canonical" href="/deposit" />
    </>
  );
}
