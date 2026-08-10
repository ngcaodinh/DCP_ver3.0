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

## 7) Dọn index Impact SBT sau rollout C4

`ImpactSbtMetadata` dùng index gallery mới `{ projectId: 1, status: 1, confirmedAt: -1 }`. Mongoose không tự xóa index cũ `{ projectId: 1, status: 1, createdAt: -1 }`, vì vậy sau khi rollout và kiểm tra query plan ổn định, có thể drop index cũ thủ công từ MongoDB:

```javascript
db.impact_sbt_metadata.dropIndex({ projectId: 1, status: 1, createdAt: -1 })
```

Index `{ onChainTokenId: 1 }` phải là unique partial index để bảo đảm mỗi token on-chain chỉ map tới một record, đồng thời bỏ qua các record chưa mint:

```javascript
// Kết quả phải rỗng; nếu có duplicate, dừng rollout và reconcile dữ liệu trước.
db.impact_sbt_metadata.aggregate([
  { $match: { onChainTokenId: { $type: 'number' } } },
  { $group: { _id: '$onChainTokenId', count: { $sum: 1 } } },
  { $match: { count: { $gt: 1 } } }
])

// Chỉ chạy các lệnh tạo index sau khi kiểm tra duplicate không trả về kết quả.
db.impact_sbt_metadata.dropIndex({ onChainTokenId: 1 })
db.impact_sbt_metadata.createIndex(
  { onChainTokenId: 1 },
  { unique: true, partialFilterExpression: { onChainTokenId: { $type: 'number' } } }
)
```

## 8) Trang Impact NFT Gallery (C5)

1. C5 không phát hành production một mình; merge và release cùng C6 vì các card SBT liên kết tới `/impact-gallery/[tokenId]`.
2. Trong lượt release, deploy backend trước frontend để route `GET /api/sbt/gallery` tồn tại trước khi FE gọi.
3. Trên collection lớn, tạo index `{ status: 1, confirmedAt: -1 }` với `background: true` trước giờ cao điểm; gộp cùng lượt dọn index cũ ở mục 7.
4. Gateway fallback phía FE được hard-code trong `FE/app/utils/ipfs.ts`; thay đổi gateway cần build lại frontend. `IPFS_GATEWAY_URLS` phía BE quyết định gateway được ưu tiên đầu tiên trên gallery.
5. Cache CDN hiện giữ trang public khoảng 5 phút, nên SBT vừa mint có thể chưa xuất hiện ngay.
6. Smoke test sau deploy: gallery có SBT của nhiều project (kể cả project đã kết thúc), card hiển thị tên project, projectId không tồn tại hiển thị empty state, chặn `ipfs.io` vẫn có ảnh fallback, và link card mở được route detail C6.
7. `RUN_WORKERS` mặc định được bật; chạy projector trên đúng một process/instance có `RUN_WORKERS` khác `false`. Các instance API-only phải đặt `RUN_WORKERS=false` để tránh nhiều process cùng quét RPC. Worker chỉ project `TokenStatusUpdated` sau 12 confirmations, lưu checkpoint/event idempotency trong `sbt_status_projection_checkpoints` và `sbt_status_projection_events`; không xóa hai collection này khi dọn cache hoặc bảo trì MongoDB.
8. Ước lượng thời gian projector bắt kịp: mỗi chu kỳ xử lý tối đa 10.000 block và chu kỳ danh nghĩa là 15 giây, tương đương khoảng `10.000 / 15 × 60 ≈ 40.000 block/phút`. Với backlog `B` block, ETA danh nghĩa là `B / 40.000` phút; cộng thêm thời gian RPC `getLogs`, retry và khoảng 5 phút cache CDN khi cần ước lượng thời điểm gallery hiển thị revoke.
9. Nếu hệ thống đã từng chạy bản worker khởi tạo checkpoint sai, chạy backfill ở chế độ dry-run trước, sau đó chạy write mode trước khi rollout worker:

```powershell
docker compose -f docker-compose.ghcr.yml run --rm --no-deps backend npm run backfill:sbt-status-projection-checkpoints -- --dry-run
docker compose -f docker-compose.ghcr.yml run --rm --no-deps backend npm run backfill:sbt-status-projection-checkpoints
```

10. Trên collection lớn, tạo các index dưới đây trước khi rollout projector. Index `{ status: 1, blockNumber: 1 }` phục vụ bootstrap; index event giúp truy vấn `PENDING` đến hạn luôn bounded. Sau khi verify query plan, có thể drop index event cũ không có `nextRetryAt`:

```javascript
db.impact_sbt_metadata.createIndex(
  { status: 1, blockNumber: 1 },
  { background: true }
)
db.sbt_status_projection_events.createIndex(
  { chainId: 1, contractAddress: 1, projectionStatus: 1, nextRetryAt: 1, blockNumber: 1, logIndex: 1 },
  { background: true }
)
db.sbt_status_projection_events.dropIndex(
  { chainId: 1, contractAddress: 1, projectionStatus: 1, blockNumber: 1, logIndex: 1 }
)
```
