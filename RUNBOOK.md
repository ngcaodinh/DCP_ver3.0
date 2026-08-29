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

## 5) Vận hành KYC Quỹ từ thiện (T0)

1. Cấu hình `RECAPTCHA_SECRET_KEY` hoặc file secret qua `RECAPTCHA_SECRET_KEY_FILE` trên backend; production sẽ fail-fast nếu thiếu secret, salt IP hoặc dùng placeholder.
2. Cấu hình `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` trên frontend rồi build lại frontend khi thay đổi.
3. Sau khi backup MongoDB, chạy migration idempotent:

```bash
cd BE
npm run migrate:foundation-kyc-index
```

4. Endpoint public giới hạn 3 request/phút/IP và 5 request/ngày/IP; dữ liệu IP dùng HMAC hash trước khi ghi quota.
5. Từ chối hồ sơ FOUNDATION là quyết định cuối cùng. Reviewer cần liên hệ quỹ ngoài hệ thống trước khi xác nhận từ chối.

## 6) Lưu ý để vận hành ổn định
- Luôn đảm bảo MongoDB chạy trước khi chạy `npm run dev`.
- Mỗi lần deploy lại contract, phải cập nhật `CONTRACT_ADDRESS`.
- Khi đổi RPC hoặc chainId, cập nhật đồng bộ cả backend và frontend.

## 7) Deploy gate cho Manual Review Queue (A3)

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

## 8) Feedback purge worker (F5)

`FEEDBACK_PURGE_ENABLED` mặc định để trống. Khi rollout F5, chỉ bật `FEEDBACK_PURGE_ENABLED=true` trên đúng một container backend có `RUN_WORKERS=true`; các container API còn lại để trống để tránh chạy purge trùng không cần thiết. Worker vẫn re-check `deletedAt` ở lệnh xoá cứng để an toàn khi restore đồng thời.

## 9) Trang Impact NFT Gallery (C5)

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

## 10) F2 — Campaign approval, Kiểm toán viên và Ủy ban Điều hành

Trước khi mở luồng tạo dự án, phải có ít nhất một tài khoản `regulatory` và ít nhất một tài khoản `auditor` đang hoạt động (khuyến nghị ba auditor). Tạo đúng một `executive_chair` và tối đa bốn `executive_member` bằng quy trình phân quyền quản trị hiện có; không thêm các role này vào commissioner/GPS override.

Người được chỉ định phải đăng nhập Google một lần trước, sau đó cấp role qua script (script tăng `authVersion`, giới hạn ghế và in cảnh báo auditor):

```bash
cd BE
npm run assign:governance-role -- --email=person@example.com --role=auditor
```

Trước khi deploy code, tạo index idempotent từ container backend chưa nhận traffic:

```bash
```

Sau deploy, kiểm tra `RUN_WORKERS=true` trên đúng một process worker. Các API-only instance đặt `RUN_WORKERS=false`. Theo dõi dự án `PENDING_ACTIVATION`: worker chỉ kích hoạt sau `PROJECT_CHALLENGE_WINDOW_HOURS` (mặc định 48 giờ). Nếu RPC lỗi, đọc `activationState` và `activationLastError`, rồi dùng endpoint retry chỉ sau khi xác nhận lỗi hạ tầng; retry không phải quyền duyệt dự án.

Vụ `DISPUTED` phải được Ủy ban xử lý trước `ARBITRATION_TIMEOUT_DAYS` (mặc định bảy ngày). Thiếu Chủ tịch hoặc không đủ hai ủy viên đồng thuận sẽ tự động `REJECTED`; không sửa trực tiếp MongoDB để lách fail-closed. Biên bản hiện trường chỉ một bản/dự án và không liên quan đến giải ngân.

## 11) AuditorStaking follow-up — index, projector và payout manual review

Trước khi đưa backend mới nhận traffic, backup MongoDB và chạy migration idempotent từ container/backend mới:

```bash
cd BE
npm run migrate:auditor-staking-indexes
```

Migration thay index unique legacy của `onchainTxHash` và `txHash` bằng unique partial index chỉ áp dụng cho string; vì vậy nhiều payout/intent chưa có hash có thể cùng tồn tại an toàn. Nó cũng tạo index stale-lock và dead-letter cần cho worker.

Chỉ chạy `RUN_WORKERS=true` trên một instance. Khi projector không xử lý được cùng một event ba lần liên tiếp, event sẽ được ghi vào `auditorstakeeventdeadletters` và checkpoint tiếp tục. Vận hành phải:

1. Đối chiếu `chainId`, `contractAddress`, `transactionHash`, `logIndex` với explorer và log ứng dụng.
2. Sửa nguyên nhân dữ liệu/cấu hình hoặc triển khai bản vá trước khi replay.
3. Không tự xóa hoặc tua checkpoint để bỏ qua event; dùng bản ghi dead-letter làm bằng chứng và mở incident nếu event liên quan `Withdrawn` hoặc `Slashed`.

Payout `MANUAL_REVIEW` không được mở khóa ví bằng tay. Chỉ admin có session mới, sau khi đối chiếu độc lập PayOS xác nhận **SUCCESS** và transfer ID đúng với snapshot payout, mới được retry burn:

```bash
curl -X POST "$API_BASE_URL/api/auditor-onboarding/payouts/$PAYOUT_ID/retry-burn" \
  -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"payosTransferId":"<transfer-id-da-doi-chieu>","reason":"Đã đối chiếu PayOS SUCCESS với chứng từ vận hành."}'
```

Endpoint ghi audit bắt buộc, chỉ chấp nhận payout `MANUAL_REVIEW` đã có hash on-chain và đúng PayOS transfer ID. Payout chỉ giải phóng wallet lock khi burn DCT xác nhận `BURNED`; nếu retry vẫn lỗi, payout quay lại `MANUAL_REVIEW` để tiếp tục điều tra.

## 12) T3 — Ủy ban Điều hành và `CommitteeGovernance`

Profile API đặt `RUN_WORKERS=false`. Chỉ đúng một profile worker đặt `RUN_WORKERS=true`; chỉ bật
`ENABLE_COMMITTEE_DECISION_RELAYER_WORKER=true` và `ENABLE_DISBURSEMENT_ONCHAIN_SIGNER_WORKER=true` sau smoke test.
Trước startup production phải provision đủ `BLOCKCHAIN_RPC_URL`, hai deployment block, hai contract address và relayer key
trong secret store; backend sẽ fail-fast và liệt kê biến thiếu nếu cấu hình không hoàn chỉnh.

1. **Thứ tự rollout:** backup MongoDB; deploy BE/FE với `RUN_WORKERS=false`; trong thư mục `BE`, chạy `npm run migrate:committee-governance-indexes` **trước khi khởi động backend** và dừng rollout nếu script báo dữ liệu trùng hoặc index sai cấu hình; khởi động BE để gate index và reconciliation admin kiểm tra allowlist; cho ví admin hợp lệ và từng ghế đăng nhập MetaMask thành công; deploy `CommitteeGovernance`; đối chiếu đủ năm ghế rồi mới bootstrap; sau đó bật đúng một worker instance và mở traffic.
2. **Trust root:** admin chỉ đăng nhập bằng MetaMask tại `/governance/login`; không có đường đăng nhập Google cho quyền admin. Ví được phép nằm ở biến môi trường `ADMIN_LOGIN_WALLET_ADDRESSES` trong secret store, **không** hard-code trong source. Ví production hiện tại: `0x902130CeaF01D52523C38166fBdbAF31BD40f302`. Biến nhận danh sách cách nhau bằng dấu phẩy để xoay khóa không gián đoạn: thêm ví mới, cho ví mới đăng nhập thành công, rồi mới gỡ ví cũ. Đổi ví chỉ cần cập nhật secret và restart backend, không cần deploy code — nhưng vẫn phải qua phê duyệt hai người và audit ngoài hệ thống. Backend fail-fast lúc khởi động nếu biến thiếu hoặc chứa địa chỉ EVM sai checksum (`validateAdminLoginWalletConfiguration`). Không ghi private key vào repository.
3. **Lập ghế:** thu địa chỉ trực tiếp từ từng người, admin nhập và người thứ hai đối chiếu từng ký tự; từng chủ ví phải đăng nhập `/governance/login` trước bootstrap. Chỉ khi DB có đúng 1 Chair + 4 Members `ACTIVE` mới được nạp lên chain.
4. **Bootstrap một lần:** cấu hình đồng thời `COMMITTEE_GOVERNANCE_ADDRESS`, `BLOCKCHAIN_RPC_URL` và biến FE tương ứng; dùng MetaMask của `bootstrapAdmin`; lưu tx hash/deployment block; đọc lại `getSeats()` trên chain và đối chiếu DB. Từ lúc đó API backend phải bị khóa sửa roster.
5. **Đổi ghế hoặc mất ví:** không sửa MongoDB trực tiếp. Ủy ban tạo đề xuất, thu đủ 3/5 chữ ký, chờ ba ngày và gọi `executeSeatChange`; chỉ sau event xác nhận mới đồng bộ DB. Nếu mất từ ba ví trở lên trước khi đổi ghế, contract bị kẹt và phải triển khai contract mới theo incident process.
6. **Ba signer kỹ thuật giải ngân:** `DISBURSEMENT_SERVICE_SIGNER_{ADMIN,ORG,REGULATORY}_KEY` phải là ba ví khác nhau, đặt trong secret store độc lập và có lịch xoay khóa. Nếu nghi lộ khóa: tắt worker trước, thu hồi/cấp lại role on-chain theo quy trình khẩn cấp, kiểm tra request pending rồi mới bật lại.
7. **Gate quyết định tiền:** không bật `disbursementOnChainSignerWorker` cho production đến khi mỗi quyết định 3/5 có signatures EIP-712 đã lưu, receipt `CommitteeGovernance.DecisionRecorded` và audit G6 đối chiếu với `MultisigDisbursement`. Kiểm tra dashboard/log RPC, `DecisionRecorded`, `ThresholdSignaturesReached` và PayOS sau mỗi rollout.
