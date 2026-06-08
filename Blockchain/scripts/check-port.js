import net from 'node:net';

const defaultPort = 8545;
const portFromEnvironment = Number.parseInt(process.env.RPC_PORT || '', 10);
const portToCheck = Number.isNaN(portFromEnvironment) ? defaultPort : portFromEnvironment;

/**
 * Hàm kiểm tra cổng mạng có đang bị chiếm dụng hay không.
 * Mục đích: phát hiện xung đột cổng trước khi khởi chạy Hardhat node.
 */
function checkPortAvailability() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (errorObject) => {
      if (errorObject.code === 'EADDRINUSE') {
        reject(new Error(`Cổng ${portToCheck} đang bị chiếm dụng.`));
        return;
      }

      reject(errorObject);
    });

    server.once('listening', () => {
      server.close(() => resolve());
    });

    server.listen(portToCheck, '127.0.0.1');
  });
}

/**
 * Hàm khởi chạy kiểm tra cổng và báo lỗi rõ ràng nếu bị chiếm dụng.
 */
async function main() {
  try {
    await checkPortAvailability();
    console.log(`✅ Cổng ${portToCheck} đang trống, có thể khởi chạy Hardhat node.`);
  } catch (errorObject) {
    console.error(`❌ ${errorObject.message}`);
    console.error('➡️  Hãy dừng tiến trình đang chiếm cổng hoặc đổi RPC_PORT rồi chạy lại.');
    process.exit(1);
  }
}

main();

