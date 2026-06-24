type JsonWebTokenConfig = {
  issuer: string;
  audience: string;
  accessTokenExpiresIn: string;
  refreshTokenExpiresIn: string;
};

/**
 * Hàm lấy cấu hình JWT.
 * Mục đích: thống nhất thông tin phát hành token.
 * Throw error nếu thiếu giá trị bắt buộc để fail-fast thay vì dùng giá trị predictable mặc định.
 */
export function getJsonWebTokenConfig(): JsonWebTokenConfig {
  const issuer = process.env.JWT_ISSUER;
  const audience = process.env.JWT_AUDIENCE;
  const accessExpiresIn = process.env.JWT_ACCESS_EXPIRES_IN || process.env.JWT_EXPIRES_IN;
  const refreshExpiresIn = process.env.JWT_REFRESH_EXPIRES_IN;

  if (!issuer) {
    throw new Error('JWT_ISSUER is not configured. Set JWT_ISSUER in environment variables.');
  }
  if (!audience) {
    throw new Error('JWT_AUDIENCE is not configured. Set JWT_AUDIENCE in environment variables.');
  }
  if (!accessExpiresIn) {
    throw new Error('JWT_ACCESS_EXPIRES_IN (or JWT_EXPIRES_IN) is not configured. Set token expiry duration.');
  }
  if (!refreshExpiresIn) {
    throw new Error('JWT_REFRESH_EXPIRES_IN is not configured. Set refresh token expiry duration.');
  }

  return {
    issuer,
    audience,
    accessTokenExpiresIn: accessExpiresIn,
    refreshTokenExpiresIn: refreshExpiresIn
  };
}

/**
 * Hàm lấy khóa bí mật JWT.
 * Mục đích: đọc khóa ký từ biến môi trường.
 */
export function getJsonWebTokenSecret(): string {
  const secretKey = process.env.JWT_SECRET;
  if (!secretKey) {
    throw new Error('JWT_SECRET is not configured.');
  }
  return secretKey;
}

