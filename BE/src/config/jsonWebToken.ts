type JsonWebTokenConfig = {
  issuer: string;
  audience: string;
  accessTokenExpiresIn: string;
  refreshTokenExpiresIn: string;
};

const jsonWebTokenConfig: JsonWebTokenConfig = {
  issuer: process.env.JWT_ISSUER || 'dcp-backend',
  audience: process.env.JWT_AUDIENCE || 'dcp-users',
  accessTokenExpiresIn:
    process.env.JWT_ACCESS_EXPIRES_IN || process.env.JWT_EXPIRES_IN || '15m',
  refreshTokenExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '24h'
};

/**
 * Hàm lấy cấu hình JWT.
 * Mục đích: thống nhất thông tin phát hành token.
 */
export function getJsonWebTokenConfig(): JsonWebTokenConfig {
  return jsonWebTokenConfig;
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

