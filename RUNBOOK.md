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

## 6) Deploy gate cho Manual Review Queue (A3)

Thực hiện theo đúng thứ tự này khi deploy image BE có thay đổi A3:

1. Backup MongoDB và pull image BE mới.
2. Dùng container BE mới chưa nhận traffic để tạo/kiểm tra durable queue indexes:

```bash
docker compose -f docker-compose.ghcr.yml run --rm --no-deps backend npm run migrate:manual-review-queue-index
```

3. Đồng bộ snapshot `requestMode` cho queue pending trước khi mở traffic. Script idempotent, có thể chạy lại an toàn:

```bash
docker compose -f docker-compose.ghcr.yml run --rm --no-deps backend npm run migrate:manual-review-queue-request-mode
```

4. Dùng container BE mới chưa nhận traffic để chạy dry-run:

```bash
docker compose -f docker-compose.ghcr.yml run --rm --no-deps backend npm run backfill:manual-review-queue -- --dry-run --batch-size=500 --max-items=10000
```

5. Đối chiếu `scanned`, `opened`, `skipped`, `failed`, `hasMore` trong JSON và so sánh số disbursement `MANUAL_REVIEW` với số queue `PENDING`.
6. Chạy write mode với cùng `--batch-size` và `--max-items`; lặp lại khi `hasMore=true` cho đến khi `hasMore=false` và `failed=0`.

```bash
docker compose -f docker-compose.ghcr.yml run --rm --no-deps backend npm run backfill:manual-review-queue -- --batch-size=500 --max-items=10000
```

7. Chỉ sau khi backfill hoàn tất mới start backend/worker, frontend và route traffic; sau đó kiểm tra `/health` và dashboard `/admin/transfers`.
8. Sau rollout có thay đổi `authVersion`, admin đang giữ JWT phát hành trước rollout có thể nhận `401` ở manual-review API; yêu cầu đăng nhập lại trước khi xác nhận dashboard hoạt động.
9. Nếu Redis không khả dụng, reconciliation chỉ quét bounded batch từ các item mới nhất vì không thể lưu cursor; backfill script vẫn là đường authoritative để hoàn tất dữ liệu thiếu trước khi mở traffic.
