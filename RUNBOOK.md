# Hướng dẫn chạy nhanh dự án DCP (FE + BE)

## 1) Yêu cầu trước khi chạy
- Node.js 20 LTS
- MongoDB container tên: `voting-mongodb`

## 2) Chạy Backend (BE)
```bash
cd BE
npm run predev
npm run dev
```

## 3) Chạy Frontend (FE)
```bash
cd FE
npm run dev
```

## 4) Lỗi đã gặp và kinh nghiệm thực tế
- **Port đang bận**:
  - Dấu hiệu: `EADDRINUSE` khi khởi động dịch vụ.
  - Cách xử lý: chạy `npm run predev` để giải phóng cổng.
- **MongoDB connection refused**:
  - Dấu hiệu: backend log lỗi kết nối.
  - Cách xử lý: chạy `docker start voting-mongodb` trước khi chạy `npm run dev`.
- **MetaMask không kết nối**:
  - Dấu hiệu: ví không hiển thị trạng thái kết nối.
  - Cách xử lý: chuyển đúng network (Localhost 8545), refresh trang, reconnect MetaMask.
- **Contract address not found**:
  - Dấu hiệu: backend báo không tìm thấy contract.
  - Cách xử lý: `npm run deploy:local`, cập nhật `CONTRACT_ADDRESS`, khởi động lại backend.

## 5) Lưu ý để vận hành ổn định
- Luôn đảm bảo MongoDB chạy trước khi chạy `npm run dev`.
- Mỗi lần deploy lại contract, phải cập nhật `CONTRACT_ADDRESS`.
- Khi đổi RPC hoặc chainId, cập nhật đồng bộ cả backend và frontend.

