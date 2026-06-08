/** Hàm head cho trang giải ngân. Mục đích: chặn index trang nghiệp vụ nội bộ không dành cho tìm kiếm công khai. */
export default function Head() {
  return (
    <>
      <title>Giải ngân | DCP</title>
      <meta name="robots" content="noindex, nofollow, noarchive" />
      <link rel="canonical" href="/disbursements" />
    </>
  );
}
