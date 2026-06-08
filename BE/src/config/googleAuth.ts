type GoogleAuthConfig = {
  clientId: string;
  clientSecret: string;
  tokenIssuers: string[];
};

/**
 * Hàm lấy cấu hình OAuth từ biến môi trường.
 * Mục đích: đảm bảo không phụ thuộc file cấu hình tĩnh trong repository.
 */
function buildGoogleAuthConfig(): GoogleAuthConfig {
  const environmentClientId = process.env.GOOGLE_CLIENT_ID;
  const environmentClientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!environmentClientId || !environmentClientSecret) {
    throw new Error('GOOGLE_CLIENT_ID hoặc GOOGLE_CLIENT_SECRET chưa được cấu hình.');
  }

  return {
    clientId: environmentClientId,
    clientSecret: environmentClientSecret,
    tokenIssuers: ['https://accounts.google.com', 'accounts.google.com']
  };
}

const googleAuthConfig = buildGoogleAuthConfig();

/**
 * Hàm lấy cấu hình Google OAuth.
 * Mục đích: trả về thông tin cấu hình đăng nhập Google.
 */
export function getGoogleAuthConfig(): GoogleAuthConfig {
  return googleAuthConfig;
}

