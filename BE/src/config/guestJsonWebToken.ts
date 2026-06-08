/**
 * Cấu hình JWT riêng cho guest session — tách biệt hoàn toàn với JWT của user đã đăng nhập.
 * Guest JWT dùng để authorize Paymaster sponsorship, không chứa thông tin nhạy cảm.
 * TTL 72 giờ phù hợp với luồng donate ẩn danh (dài hơn user session vì guest có thể
 * rời đi và quay lại trong vài ngày trước khi claim).
 */
import jsonwebtoken from 'jsonwebtoken';

/** Cấu hình guest JWT — issuer/audience riêng để tránh cross-use với user JWT. */
type GuestJwtConfig = {
  issuer: string;
  audience: string;
  expiresIn: string;
};

// Fallback values được thiết kế để nhất quán giữa instances.
// Nếu cần isolation env (staging vs prod), set GUEST_JWT_ISSUER và GUEST_JWT_AUDIENCE
// riêng trong mỗi environment .env file.
const guestJwtConfig: GuestJwtConfig = {
  issuer: process.env.GUEST_JWT_ISSUER || 'dcp-guest',
  audience: process.env.GUEST_JWT_AUDIENCE || 'dcp-guest-sessions',
  expiresIn: process.env.GUEST_JWT_EXPIRES_IN || '72h'
};

/** Độ dài tối thiểu của guest JWT secret để đảm bảo độ an toàn. */
const GUEST_JWT_SECRET_MIN_LENGTH = 32;

/**
 * Hàm kiểm tra và lấy guest JWT secret từ environment variable.
 * Mục đích: tách logic validation chung để DRY giữa validateGuestJwtConfig() và getGuestJwtSecret().
 * @throws Error nếu secret không tồn tại hoặc không đủ độ dài
 * @returns Secret key đã được validate
 */
function validateAndGetSecret(): string {
  const secretKey = process.env.GUEST_JWT_SECRET;
  if (!secretKey) {
    throw new Error(
      '[GuestJWT] GUEST_JWT_SECRET chưa được cấu hình trong .env. ' +
      'Vui lòng thêm GUEST_JWT_SECRET=your_strong_guest_jwt_secret_min_32_chars vào .env'
    );
  }
  if (secretKey.length < GUEST_JWT_SECRET_MIN_LENGTH) {
    throw new Error(
      `[GuestJWT] GUEST_JWT_SECRET phải có ít nhất ${GUEST_JWT_SECRET_MIN_LENGTH} ký tự (hiện tại: ${secretKey.length}). ` +
      'Vui lòng cập nhật giá trị GUEST_JWT_SECRET trong .env'
    );
  }
  return secretKey;
}

// Cache secret sau lần validate đầu tiên — tránh re-validate mỗi request.
// validateGuestJwtConfig() chạy lúc startup sẽ warm cache sẵn.
let cachedSecret: string | null = null;

/** Các claims bắt buộc trong guest session token. */
export type GuestSessionClaims = {
  sessionId: string;
  walletAddress: string;
};

/**
 * Hàm xác thực cấu hình guest JWT tại startup — fail-fast.
 * Mục đích: phát hiện thiếu/misconfigured GUEST_JWT_SECRET ngay khi server khởi động,
 * thay vì đợi request đầu tiên mới ném lỗi → dev không thấy cảnh báo rõ ràng.
 */
export function validateGuestJwtConfig(): void {
  cachedSecret = validateAndGetSecret();
}

/**
 * Hàm lấy khóa bí mật ký guest session token.
 * Mục đích: tách biệt hoàn toàn với JWT_SECRET của user thường.
 * Secret được cache sau lần đầu để tránh re-validate mỗi request.
 */
export function getGuestJwtSecret(): string {
  if (!cachedSecret) {
    cachedSecret = validateAndGetSecret();
  }
  return cachedSecret;
}

/**
 * Hàm ký guest session token.
 * Mục đích: tạo JWT để authorize Paymaster sponsorship cho guest wallet.
 */
export function signGuestSessionToken(payload: GuestSessionClaims): string {
  const secret = getGuestJwtSecret();
  // jsonwebtoken types yêu cầu StringValue cho expiresIn (e.g. "72h"), cast rõ ràng để satisfy TS
  const signOptions = {
    issuer: guestJwtConfig.issuer,
    audience: guestJwtConfig.audience,
    expiresIn: guestJwtConfig.expiresIn as jsonwebtoken.SignOptions['expiresIn'],
    algorithm: 'HS256' as const
  };
  return jsonwebtoken.sign(payload, secret, signOptions);
}

/**
 * Hàm xác thực guest session token.
 * Mục đích: kiểm tra tính hợp lệ của token trước khi sponsor paymaster.
 * @returns Payload đã decode nếu token hợp lệ
 * @throws Error nếu token không hợp lệ hoặc đã hết hạn
 */
export function verifyGuestSessionToken(token: string): GuestSessionClaims {
  const secret = getGuestJwtSecret();
  const decoded = jsonwebtoken.verify(token, secret, {
    issuer: guestJwtConfig.issuer,
    audience: guestJwtConfig.audience,
    algorithms: ['HS256']
  }) as Record<string, unknown>;

  // Sau khi verify signature thành công, kiểm tra các trường bắt buộc có tồn tại không.
  // Nếu payload bị thiếu trường (ví dụ token cũ đã sign với schema cũ), ném lỗi thay vì trả về undefined.
  if (typeof decoded.sessionId !== 'string' || typeof decoded.walletAddress !== 'string') {
    throw new Error('Guest token payload không hợp lệ: thiếu sessionId hoặc walletAddress.');
  }

  return decoded as GuestSessionClaims;
}
