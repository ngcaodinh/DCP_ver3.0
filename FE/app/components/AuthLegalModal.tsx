'use client';

/**
 * Component popup hiển thị nội dung pháp lý (Điều khoản sử dụng / Chính sách bảo mật).
 * Mục đích: tách riêng UI popup pháp lý để dùng chung cho login & register.
 *
 * Hành vi:
 * - Bấm Esc hoặc click overlay để đóng.
 * - Focus trap bên trong modal khi đang mở.
 * - Trả focus về phần tử trigger khi đóng.
 *
 * Sử dụng:
 *   <AuthLegalModal
 *     variant="terms"
 *     open={isOpen}
 *     onClose={handleClose}
 *     triggerRef={linkRef}  // ref của link đã bấm (để trả focus)
 *   />
 */

import { useCallback, useEffect, useRef } from 'react';

/** Biến thể nội dung pháp lý. */
type LegalVariant = 'terms' | 'privacy';

/** Props cho AuthLegalModal. */
type AuthLegalModalProps = {
  /** Trạng thái mở/đóng modal. */
  open: boolean;
  /** Callback đóng modal. */
  onClose: () => void;
  /** Biến thể nội dung: terms = Điều khoản sử dụng, privacy = Chính sách bảo mật. */
  variant: LegalVariant;
  /** Ref của phần tử link đã kích hoạt mở modal (dùng để trả focus khi đóng). */
  triggerRef?: React.RefObject<HTMLElement | null>;
};

/**
 * Nội dung Điều khoản sử dụng DCP.
 * Nguồn: dcp-terms-of-service.md (version 1.0 · hiệu lực 01/01/2025).
 */
const TERMS_CONTENT = `# ĐIỀU KHOẢN SỬ DỤNG DỊCH VỤ

**Decentralized Charity Platform (DCP)**
Phiên bản 1.0 · Có hiệu lực từ 01/01/2025

---

> Vui lòng đọc kỹ các điều khoản dưới đây trước khi sử dụng nền tảng. Bằng cách nhấn dấu tích vào ô **"Tôi đồng ý với Điều khoản sử dụng và Chính sách bảo mật của DCP"**, bạn xác nhận đã đọc, hiểu và chấp nhận ràng buộc pháp lý với toàn bộ nội dung được nêu, bao gồm các điều khoản đặc thù về giao dịch blockchain, dữ liệu on-chain không thể xóa và cơ chế xếp hạng phi tập trung.

---

## Điều 1 — Định nghĩa và Phạm vi Áp dụng

**1.1** **Nền tảng DCP** (Decentralized Charity Platform) là hệ thống từ thiện hybrid kết hợp công nghệ Blockchain và thanh toán truyền thống, vận hành trên mạng Polygon (Amoy Testnet trong giai đoạn POC).

**1.2 Các định nghĩa kỹ thuật:**

- **Smart Account** — Tài khoản ví phi tập trung tuân chuẩn ERC-4337, được tạo tự động qua ZeroDev SDK (Kernel v2) khi người dùng đăng ký lần đầu.
- **Charity Token** — Token nội bộ của nền tảng với tỷ lệ chuyển đổi 1 VNĐ = 1 Token, dùng cho toàn bộ giao dịch quyên góp on-chain.
- **Quadratic Funding (QF)** — Cơ chế phân bổ ngân sách công bằng dựa trên số lượng người đóng góp, ưu tiên dự án có sức lan tỏa cộng đồng rộng thay vì tập trung vào giá trị quyên góp đơn lẻ.
- **KYC (Know Your Customer)** — Quy trình xác minh danh tính bắt buộc dành cho Tổ chức từ thiện, bao gồm hồ sơ pháp lý và tài khoản ngân hàng thụ hưởng.
- **Matching Pool** — Quỹ đối ứng được phân bổ theo cơ chế QF cho các dự án đạt điều kiện trong mỗi đợt quyên góp.
- **CID (Content Identifier)** — Mã định danh nội dung duy nhất trên IPFS, được tạo khi upload hồ sơ KYC lên Pinata, dùng để truy xuất và kiểm toán tài liệu.

**1.3** Điều khoản này áp dụng cho toàn bộ người dùng, bao gồm: Nhà hảo tâm (Donor), Tổ chức từ thiện (Charity Organizations), Quản trị viên hệ thống (Admin) và Cơ quan giám sát (Regulatory Bodies).

---

## Điều 2 — Đăng ký Tài khoản và Danh tính Blockchain

**2.1 Tạo tài khoản.** Người dùng đăng ký qua Google OAuth. Hệ thống tự động tạo một Smart Account (ERC-4337) liên kết duy nhất với địa chỉ email. Mỗi email chỉ được liên kết với một ví duy nhất trong toàn bộ vòng đời tài khoản.

**2.2 Bảo mật phiên làm việc.** Session hết hạn sau 24 giờ (access token: 15 phút; refresh token: 24 giờ). Hệ thống kiểm tra IP và User-Agent khi làm mới token. Tài khoản bị khóa tạm thời nếu đăng nhập sai nhiều lần liên tiếp theo cơ chế rate limiting chuẩn OWASP ASVS.

**2.3 Quản lý khóa ví.** Owner key của Smart Account được mã hóa AES-256-GCM và lưu an toàn trong hệ thống. Nền tảng không cung cấp khóa thô cho người dùng. Người dùng có thể khôi phục quyền truy cập qua tài khoản Google đã đăng ký.

**2.4 Trách nhiệm tài khoản.** Người dùng chịu hoàn toàn trách nhiệm về mọi hoạt động xảy ra dưới tài khoản của mình sau khi đăng nhập thành công. Trong trường hợp nghi ngờ bị xâm phạm, người dùng có thể yêu cầu thu hồi phiên trên tất cả thiết bị thông qua tính năng hủy phiên toàn cục.

**2.5 Tính duy nhất tài khoản.** Nghiêm cấm tạo nhiều tài khoản từ cùng một cá nhân hoặc tổ chức nhằm mục đích thao túng hệ thống xếp hạng. Hành vi này bị phát hiện tự động qua cơ chế Anti-Sybil và dẫn đến khóa tài khoản vĩnh viễn.

---

## Điều 3 — Quy trình KYC và Xác minh Tổ chức từ thiện

**3.1 Điều kiện bắt buộc.** Tổ chức từ thiện chỉ được phép tạo dự án quyên góp khi đồng thời thỏa mãn ba điều kiện: **(1) KYC được phê duyệt (APPROVED)**, **(2) Tài khoản ngân hàng thụ hưởng được phê duyệt (APPROVED)** và **(3) Được cấp PROJECT_MANAGER_ROLE on-chain** bởi quản trị viên.

**3.2 Yêu cầu hồ sơ KYC.** Bộ hồ sơ bao gồm 1–3 file tài liệu pháp lý, định dạng PDF/PNG/JPG/JPEG, dung lượng tối đa 10MB mỗi file. Tài liệu khuyến nghị gồm: giấy phép hoạt động, giấy đăng ký pháp nhân, giấy xác nhận đại diện pháp luật.

**3.3 Lưu trữ phi tập trung.** Toàn bộ file hồ sơ KYC được upload lên IPFS thông qua dịch vụ Pinata. Hệ thống không lưu bản sao file trên server nội bộ. Chỉ metadata và CID được lưu trong cơ sở dữ liệu để phục vụ truy xuất và kiểm toán.

**3.4 Lịch sử phiên bản.** Mỗi lần nộp hồ sơ tạo một phiên bản mới (v1, v2, v3...). Toàn bộ lịch sử các phiên bản được lưu trữ vĩnh viễn và không thể xóa, phục vụ mục đích kiểm toán. Tổ chức được phép nộp lại không giới hạn số lần sau khi bị từ chối.

**3.5 Tính trung thực của hồ sơ.** Tổ chức chịu trách nhiệm pháp lý hoàn toàn về tính chính xác và trung thực của thông tin trong hồ sơ KYC và thông tin tài khoản ngân hàng. Cung cấp thông tin giả mạo là hành vi vi phạm pháp luật và dẫn đến từ chối vĩnh viễn, đồng thời có thể bị truy tố theo quy định của pháp luật Việt Nam.

**3.6 Thông tin tài khoản ngân hàng.** Mỗi tổ chức chỉ được liên kết tối đa một tài khoản ngân hàng thụ hưởng ở trạng thái APPROVED hoặc PENDING_REVIEW tại một thời điểm. Số tài khoản phải từ 8–20 chữ số. Một số tài khoản ngân hàng không thể đồng thời được liên kết với nhiều tổ chức khác nhau.

---

## Điều 4 — Giao dịch Tài chính và Tính Không Thể Hoàn Tác

**4.1 Nạp tiền (Fiat → Token).** Người dùng nạp tiền VNĐ qua PayOS Checkout với mức tối thiểu 10.000 VNĐ. Sau khi webhook xác nhận thanh toán và Token được mint thành công on-chain, giao dịch là vĩnh viễn và không thể hoàn tác dưới bất kỳ hình thức nào.

**4.2 Quyên góp.** Token quyên góp được chuyển trực tiếp đến Smart Contract của dự án. Mọi giao dịch on-chain đều minh bạch và có thể tra cứu công khai trên blockchain explorer bởi bất kỳ ai.

**4.3 Giải ngân.** Thực hiện qua cơ chế Multisignature — yêu cầu đủ số chữ ký theo cấu hình Smart Contract của từng dự án. Tổ chức nhận giải ngân qua tài khoản ngân hàng thụ hưởng đã được phê duyệt. Nền tảng không xử lý các yêu cầu giải ngân khi tài khoản đang trong quá trình điều tra vi phạm.

**4.4 Idempotency.** Mỗi mã đơn hàng (orderCode) chỉ được xử lý đúng một lần. Các yêu cầu thanh toán trùng lặp bị hệ thống tự động chặn. Thời gian xử lý webhook tối đa là 15 phút kể từ khi nhận; sau thời gian này giao dịch chuyển trạng thái FAILED và không được mint Token.

**4.5 Giới hạn trách nhiệm giao dịch.** Nền tảng không chịu trách nhiệm về tổn thất phát sinh do người dùng nhập sai địa chỉ ví, sai số lượng Token hoặc thực hiện giao dịch từ thiết bị bị xâm phạm bảo mật sau khi giao dịch đã được xác nhận trên blockchain.

---

## Điều 5 — Cơ chế Quadratic Funding và Xếp hạng Dự án

**5.1 Nguyên lý QF.** Điểm QF của một dự án tỷ lệ với bình phương tổng căn bậc hai các khoản đóng góp. Cơ chế này ưu tiên dự án có nhiều người đóng góp nhỏ hơn là ít người đóng góp lớn, đảm bảo phân bổ Matching Pool phản ánh ý nguyện cộng đồng.

**5.2 Cập nhật xếp hạng.** Thứ hạng được tính toán bằng Incremental Metrics (O(1)) và cập nhật gần như tức thì sau mỗi giao dịch quyên góp. Nền tảng không can thiệp thủ công vào kết quả xếp hạng.

**5.3 Chống gian lận (Anti-Sybil).** Hệ thống tự động phát hiện các tài khoản nghi ngờ gian lận cơ chế QF. Điểm xếp hạng của các tài khoản vi phạm bị điều chỉnh hoặc loại bỏ khỏi vòng tính toán. Quyết định của hệ thống Anti-Sybil có thể được khiếu nại qua kênh hỗ trợ chính thức trong vòng 7 ngày kể từ khi bị tác động.

**5.4 Minh bạch kết quả.** Toàn bộ dữ liệu xếp hạng và phân bổ Matching Pool là công khai và có thể kiểm chứng độc lập trên blockchain.

---

## Điều 6 — Bảo mật Dữ liệu và Quyền Riêng tư

**6.1 Dữ liệu off-chain.** Email, thông tin cá nhân và metadata KYC được lưu trong MongoDB với mã hóa at-rest. Không có file nhị phân hay hình ảnh nào được lưu trên server nội bộ của nền tảng.

**6.2 Dữ liệu on-chain.** Địa chỉ ví, lịch sử giao dịch và kết quả xếp hạng là dữ liệu công khai và vĩnh viễn trên Blockchain. Người dùng hiểu và chấp nhận tính chất này khi tham gia nền tảng. Nền tảng không có khả năng xóa hoặc sửa đổi dữ liệu đã được ghi on-chain.

**6.3 Audit Log.** Hệ thống ghi nhật ký kiểm toán đầy đủ cho mọi thao tác quan trọng bao gồm đăng nhập, nộp KYC, phê duyệt/từ chối, tạo dự án, quyên góp và giải ngân. Audit log được bảo vệ toàn vẹn và không thể sửa đổi.

**6.4 Chia sẻ dữ liệu.** Nền tảng không bán hoặc chia sẻ dữ liệu người dùng cho bên thứ ba ngoài các đối tác vận hành dịch vụ cốt lõi (PayOS, Pinata, ZeroDev, Google OAuth). Mỗi đối tác tuân theo điều khoản bảo mật riêng của họ.

**6.5 Quyền truy cập dữ liệu.** Người dùng có quyền yêu cầu xem dữ liệu cá nhân off-chain đang được lưu trữ. Yêu cầu gửi qua kênh hỗ trợ chính thức và được xử lý trong vòng 30 ngày làm việc.

---

## Điều 7 — Hành vi Bị Cấm và Hậu Quả Vi Phạm

**7.1 Các hành vi nghiêm cấm** bao gồm nhưng không giới hạn ở:

- Tạo nhiều tài khoản để thao túng cơ chế Quadratic Funding (Sybil Attack).
- Cung cấp hồ sơ KYC giả mạo, làm giả giấy tờ pháp lý của tổ chức.
- Sử dụng nền tảng cho mục đích rửa tiền hoặc các hoạt động bất hợp pháp theo quy định pháp luật Việt Nam.
- Tấn công, khai thác lỗ hổng Smart Contract hoặc cơ sở hạ tầng kỹ thuật của nền tảng.
- Giả mạo danh tính tổ chức từ thiện nhằm chiếm đoạt tiền quyên góp.
- Can thiệp trái phép vào cơ chế xếp hạng QF hoặc phân bổ Matching Pool.
- Phát tán thông tin sai lệch về dự án nhằm thu hút quyên góp gian lận.

**7.2 Hậu quả vi phạm.** Tùy mức độ, nền tảng có thể áp dụng một hoặc nhiều biện pháp sau: cảnh báo tài khoản, tạm đình chỉ hoạt động, đóng băng Smart Account, thu hồi Token chưa sử dụng, từ chối giải ngân, chấm dứt tài khoản vĩnh viễn và/hoặc chuyển hồ sơ vi phạm đến cơ quan có thẩm quyền.

**7.3 Điều tra vi phạm.** Trong thời gian điều tra, mọi giao dịch liên quan đến tài khoản nghi vấn có thể bị tạm giữ. Nền tảng thông báo đến người dùng về việc điều tra trong vòng 48 giờ và cho phép khiếu nại trong vòng 14 ngày.

---

## Điều 8 — Giới hạn Trách nhiệm và Tuyên bố Miễn trách

**8.1 Giai đoạn POC.** Nền tảng DCP đang vận hành trong giai đoạn Proof of Concept trên Amoy Testnet. Người dùng thừa nhận và chấp nhận rằng hệ thống có thể còn những hạn chế kỹ thuật chưa được phát hiện.

**8.2 Tính khả dụng dịch vụ.** Nền tảng không đảm bảo hoạt động liên tục 100%. Downtime có thể xảy ra do bảo trì định kỳ, sự cố kỹ thuật từ bên thứ ba (PayOS, Pinata, Polygon network) hoặc các yếu tố ngoài tầm kiểm soát. Nền tảng cam kết thông báo trước ít nhất 24 giờ cho các đợt bảo trì có kế hoạch.

**8.3 Tạm dừng khẩn cấp.** Trong trường hợp phát hiện lỗ hổng bảo mật nghiêm trọng trên Smart Contract, nền tảng có quyền kích hoạt cơ chế Pause để bảo vệ tài sản người dùng mà không cần thông báo trước. Hoạt động sẽ được khôi phục sau khi lỗ hổng được vá và kiểm tra lại.

**8.4 Giới hạn bồi thường.** Trách nhiệm tối đa của nền tảng đối với mỗi sự cố kỹ thuật thuộc lỗi nền tảng được giới hạn ở giá trị thực tế của Token bị ảnh hưởng trực tiếp bởi sự cố đó. Nền tảng không chịu trách nhiệm về thiệt hại gián tiếp, thiệt hại cơ hội hoặc các tổn thất không lường trước.

---

## Điều 9 — Sửa đổi Điều khoản và Thông báo

**9.1 Quyền sửa đổi.** Nền tảng DCP bảo lưu quyền sửa đổi Điều khoản Dịch vụ vào bất kỳ thời điểm nào nhằm phản ánh thay đổi pháp lý, kỹ thuật hoặc nghiệp vụ.

**9.2 Thông báo thay đổi.** Người dùng được thông báo qua email đã đăng ký ít nhất 7 ngày trước khi điều khoản mới có hiệu lực. Tiếp tục sử dụng nền tảng sau ngày hiệu lực đồng nghĩa với việc chấp nhận điều khoản sửa đổi.

**9.3 Lịch sử phiên bản.** Toàn bộ các phiên bản điều khoản trước đây được lưu trữ và có thể truy xuất công khai tại trang Chính sách của nền tảng.

**9.4 Giải quyết tranh chấp.** Mọi tranh chấp phát sinh từ việc sử dụng nền tảng được giải quyết theo pháp luật Cộng hòa Xã hội Chủ nghĩa Việt Nam. Tòa án có thẩm quyền là Tòa án nhân dân có thẩm quyền tại địa điểm đặt trụ sở của nền tảng. Các bên ưu tiên giải quyết tranh chấp thông qua thương lượng trực tiếp trước khi khởi kiện.

---

## Xác nhận Đồng ý

Bằng cách nhấn dấu tích vào ô **"Tôi đồng ý với Điều khoản sử dụng và Chính sách bảo mật của DCP"** khi đăng ký, bạn xác nhận:

- Tôi đã đọc và đồng ý với toàn bộ Điều khoản Sử dụng Dịch vụ và Chính sách Bảo mật của Decentralized Charity Platform.
- Tôi hiểu rằng mọi giao dịch quyên góp được ghi nhận vĩnh viễn trên Blockchain Polygon và không thể hoàn tác sau khi xác nhận.
- Tôi đủ 18 tuổi trở lên (hoặc có sự cho phép của người giám hộ hợp pháp) và có đầy đủ năng lực pháp lý để giao kết thỏa thuận này.
- *(Dành cho Tổ chức từ thiện)* Tôi xác nhận thông tin KYC và tài khoản ngân hàng thụ hưởng được nộp là chính xác và chịu trách nhiệm pháp lý hoàn toàn về tính trung thực của hồ sơ.

---

*Phiên bản điều khoản: 1.0.0 · Ngôn ngữ: Tiếng Việt · Áp dụng theo pháp luật Cộng hòa Xã hội Chủ nghĩa Việt Nam*`;

// Lấy nội dung theo variant. Tạm dùng chung terms cho privacy (theo plan).
const getLegalContent = (variant: LegalVariant): string => {
  return TERMS_CONTENT;
};

/** Tiêu đề hiển thị theo variant. */
const getTitle = (variant: LegalVariant): string => {
  return variant === 'terms' ? 'Điều khoản sử dụng' : 'Chính sách bảo mật';
};

/**
 * Hàm chuyển đổi markdown thành HTML an toàn.
 * Mục đích: parse nội dung markdown đơn giản (heading, paragraph, list, bold, italic, link).
 * Không sử dụng thư viện bên ngoài để tránh over-engineer.
 *
 * Lưu ý: chỉ hỗ trợ subset markdown phổ biến trong file dcp-terms-of-service.md.
 */
const parseMarkdownToHtml = (markdown: string): string => {
  let html = markdown;

  // Bước 1: Escape HTML cơ bản trước khi parse (ngăn XSS).
  html = html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Bước 2: Chuyển heading (# ## ###).
  html = html.replace(/^### (.+)$/gm, '<h3 class="text-base font-semibold text-gray-800 mt-4 mb-2">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 class="text-lg font-bold text-gray-900 mt-6 mb-3">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 class="text-xl font-extrabold text-gray-900 mb-4">$1</h1>');

  // Bước 3: Chuyển horizontal rule (---).
  html = html.replace(/^---$/gm, '<hr class="my-4 border-gray-200" />');

  // Bước 4: Chuyển blockquote (> text) — làm nổi bật với nền vàng để thu hút sự chú ý.
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote class="border-l-4 border-amber-400 pl-4 pr-3 py-3 my-4 bg-amber-50 text-gray-800 text-sm font-medium rounded-r-lg shadow-sm">$1</blockquote>');

  // Bước 5: Chuyển list (- item).
  const lines = html.split('\n');
  const processed: string[] = [];
  let inUl = false;

  for (const line of lines) {
    const listMatch = line.match(/^- (.+)$/);

    if (listMatch) {
      if (!inUl) {
        processed.push('<ul class="list-disc pl-6 my-3 space-y-1">');
        inUl = true;
      }
      processed.push(`<li class="text-sm text-gray-700 leading-relaxed">${listMatch[1]}</li>`);
    } else {
      if (inUl) {
        processed.push('</ul>');
        inUl = false;
      }
      processed.push(line);
    }
  }
  if (inUl) processed.push('</ul>');
  html = processed.join('\n');

  // Bước 6: Chuyển bold (**text**).
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-gray-900">$1</strong>');

  // Bước 7: Chuyển italic (*text*).
  html = html.replace(/\*(.+?)\*/g, '<em class="italic">$1</em>');

  // Bước 8: Chuyển inline code (`code`).
  html = html.replace(/`([^`]+)`/g, '<code class="bg-gray-100 px-1.5 py-0.5 rounded text-xs font-mono text-gray-800">$1</code>');

  // Bước 9: Chuyển link [text](url) - chỉ cho phép http/https.
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) => {
    if (/^https?:\/\//i.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-teal-600 underline hover:text-teal-800">${text}</a>`;
    }
    return text;
  });

  // Bước 10: Chuyển đoạn văn (dòng không phải tag HTML thành <p>).
  const paragraphLines = html.split('\n');
  const paraProcessed: string[] = [];
  for (const pl of paragraphLines) {
    const trimmed = pl.trim();
    if (!trimmed) {
      paraProcessed.push('');
    } else if (
      trimmed.startsWith('<h') ||
      trimmed.startsWith('<ul') ||
      trimmed.startsWith('</ul') ||
      trimmed.startsWith('<li') ||
      trimmed.startsWith('</li') ||
      trimmed.startsWith('<blockquote') ||
      trimmed.startsWith('<hr') ||
      trimmed.startsWith('<a ') ||
      trimmed.startsWith('<code')
    ) {
      paraProcessed.push(pl);
    } else {
      paraProcessed.push(`<p class="text-sm text-gray-700 leading-relaxed mb-2">${pl}</p>`);
    }
  }
  html = paraProcessed.join('\n');

  return html;
};

/**
 * Component modal pháp lý dùng chung cho login/register.
 * Hỗ trợ đầy đủ accessibility: role="dialog", aria-modal, Esc đóng, click overlay đóng.
 */
export default function AuthLegalModal({ open, onClose, variant, triggerRef }: AuthLegalModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  /**
   * Lưu phần tử đang focus trước khi mở modal.
   * Mục đích: trả focus về đúng phần tử trigger khi modal đóng.
   */
  useEffect(() => {
    if (open) {
      previousFocusRef.current = (triggerRef?.current as HTMLElement) || document.activeElement as HTMLElement;
      const timer = window.setTimeout(() => {
        closeButtonRef.current?.focus();
      }, 50);
      return () => window.clearTimeout(timer);
    } else {
      if (previousFocusRef.current && typeof previousFocusRef.current.focus === 'function') {
        const timer = window.setTimeout(() => {
          previousFocusRef.current?.focus();
        }, 50);
        return () => window.clearTimeout(timer);
      }
    }
  }, [open, triggerRef]);

  /**
   * Xử lý phím Esc để đóng modal + focus trap bên trong modal.
   * Mục đích: hỗ trợ keyboard navigation chuẩn accessibility.
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === 'Tab' && modalRef.current) {
        const focusableElements = modalRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        const firstEl = focusableElements[0];
        const lastEl = focusableElements[focusableElements.length - 1];

        if (event.shiftKey) {
          if (document.activeElement === firstEl) {
            event.preventDefault();
            lastEl?.focus();
          }
        } else {
          if (document.activeElement === lastEl) {
            event.preventDefault();
            firstEl?.focus();
          }
        }
      }
    },
    [onClose]
  );

  /**
   * Xử lý click vào overlay để đóng modal.
   * Mục đích: UX chuẩn — click ngoài = đóng.
   */
  const handleOverlayClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  if (!open) return null;

  const content = getLegalContent(variant);
  const htmlContent = parseMarkdownToHtml(content);
  const title = getTitle(variant);

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm"
      onClick={handleOverlayClick}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-legal-modal-title"
    >
      {/* Nội dung modal chính. */}
      <div
        ref={modalRef}
        className="relative flex flex-col overflow-hidden rounded-2xl bg-white shadow-2xl w-full max-w-2xl max-h-[85vh]"
      >
        {/* Header: tiêu đề + nút đóng. */}
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 shrink-0">
          <h2
            id="auth-legal-modal-title"
            className="text-base font-bold text-gray-900"
          >
            {title}
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
            aria-label={`Đóng ${title}`}
          >
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body: nội dung markdown scrollable. */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div
            className="prose prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: htmlContent }}
          />
        </div>

        {/* Footer: nút đóng. */}
        <div className="flex justify-end border-t border-gray-100 px-6 py-4 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-[#0e7c6b] px-5 py-2 text-sm font-semibold text-white transition hover:bg-[#0a5c50]"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
