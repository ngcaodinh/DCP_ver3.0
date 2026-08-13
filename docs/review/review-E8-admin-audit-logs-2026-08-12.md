# Review — Task E8: Admin Audit Logs

| Trường | Giá trị |
|---|---|
| Ngày review | 2026-08-12 |
| Reviewer | Senior Fullstack Web3 Engineer |
| Branch / phạm vi | `dev` — toàn bộ thay đổi chưa commit triển khai E8 |
| Đối chiếu yêu cầu | `docs/plan/plan_codex/E8-admin-audit-logs.md` (D1–D5, E8a–E8j) |
| Smart contract | Không có thay đổi Solidity, Hardhat, deploy hoặc signer trong E8. Review Web3 tập trung vào tính toàn vẹn của off-chain audit trail cho các thao tác nhạy cảm. |
| Kiểm chứng đã chạy | BE: 9 file / 89 test pass; FE: 1 file / 4 test pass; `tsc --noEmit` pass ở cả BE và FE. |
| Tổng finding | **2 blocker · 5 important · 1 nit** |
| Verdict tổng | **reject** — chưa đáp ứng D2 (business state + audit phải atomic/outbox) và chưa đủ bằng chứng test cho các luồng compliance. |

## Tóm tắt theo 4 góc nhìn

| Góc nhìn | Verdict | Blocker | Important | Nit |
|---|---:|---:|---:|---:|
| [Security](#1--security--transaction-safety) | needs changes | 2 | 1 | 0 |
| [Tests](#2--tests) | needs changes | 0 | 1 | 0 |
| [Performance](#3--performance--operations) | needs changes | 0 | 1 | 1 |
| [Architecture & logic](#4--architecture--logic--maintainability) | re-think before merging | 0 | 2 | 0 |

Các thay đổi có điểm tốt rõ ràng: canonical action allowlist, IP lấy từ `request.ip`, route đọc chỉ cho `admin`, tách webhook sang collection riêng, UI dùng server-side filter/pagination và archive không dùng TTL/delete. Các điểm dưới đây vẫn chặn E8 vì chúng làm audit trail thiếu hoặc sai trong tình huống lỗi/race thực tế.

## 1 · Security & transaction safety

**Verdict: needs changes** — 2 blocker · 1 important

### Blocker S1 — Override vote và SBT re-run có thể thay đổi state nhưng không có audit record

**Vị trí:** `BE/src/services/overrideVotingService.ts:154`, `BE/src/services/overrideVotingService.ts:183`; `BE/src/services/sbtMintService.ts:699`, `BE/src/services/sbtMintService.ts:712`.

`addVoteToOverrideRequest()` ghi phiếu vote trước, rồi `recordAdminAuditLog()` mới được gọi. Nếu insert audit lỗi, API trả lỗi nhưng vote đã được accept; request retry sau đó bị `ALREADY_VOTED`, nên không còn đường tạo trail cho hành động thực tế. SBT cũng reset record và tăng `reRunCount` trước audit; lỗi audit để lại mutation đã xảy ra, chưa enqueue và không có audit.

Đây vi phạm quyết định D2 của E8: business state và audit record phải nằm trong cùng Mongo transaction; side effect queue phải đi qua transactional outbox. Chỉ `await` audit không tạo tính nguyên tử.

**Cần sửa:** thực hiện state transition + canonical audit (hoặc outbox event audit) trong một Mongoose session transaction. Dispatch queue phải consume outbox sau commit; retry cần dùng action idempotency key ổn định theo mutation đã commit.

### Blocker S2 — Feedback moderation có rollback bù trừ nhưng rollback không được đảm bảo

**Vị trí:** `BE/src/services/feedbackModeration.service.ts:42`, `BE/src/services/feedbackModeration.service.ts:52`, `BE/src/services/feedbackModeration.service.ts:71`.

Service đổi `isFlagged` trước khi ghi audit. Khi audit lỗi, nó gọi một update ngược nhưng bỏ qua kết quả trả về. Nếu rollback không match state, Mongo lỗi, hoặc có transition hợp lệ xen vào, endpoint trả lỗi trong khi feedback vẫn có thể đổi state mà không có audit. Đây là luồng moderation bắt buộc của E8, nên không thể chấp nhận eventual/compensating write không kiểm chứng.

**Cần sửa:** dùng cùng Mongo transaction cho read/conditional transition/audit insert. Nếu kiến trúc chưa cho transaction, không được đánh dấu E8 complete; cần transactional outbox có worker retry và cơ chế phát hiện state không có audit.

### Important S3 — Archive worker không fail closed khi thiếu credential archive

**Vị trí:** `BE/src/services/adminAuditArchive.service.ts:210`, `BE/src/services/adminAuditArchive.service.ts:218`; `BE/src/workers/adminAuditArchiveWorker.ts:19`.

Chỉ cần có endpoint là worker khởi động. Khi `AUDIT_ARCHIVE_S3_BEARER_TOKEN` rỗng, `headers()` gửi không có Authorization nhưng archive vẫn PUT payload audit. Điều này biến một lỗi cấu hình storage private thành attempt upload không có credential, trái D1 yêu cầu bucket private, encryption và service identity least-privilege.

**Cần sửa:** validate đầy đủ cấu hình trước start (endpoint HTTPS/allowlisted, credential hoặc auth mode bắt buộc); log cấu hình thiếu ở mức fail-closed và không chạy archive. Nếu dùng S3 trực tiếp, adapter phải dùng cơ chế xác thực S3 đã được phê duyệt thay vì bearer header giả định.

## 2 · Tests

**Verdict: needs changes** — 1 important

### Important T1 — Test xanh nhưng chưa bảo vệ các contract audit mới và failure path chặn merge

**Vị trí:** `BE/src/__tests__/services/overrideVotingService.test.ts:31`, `BE/src/__tests__/services/sbtMintService.test.ts:63`, `BE/src/__tests__/services/feedbackModeration.service.test.ts:81`, `FE/src/__tests__/pages/AdminAuditLogsPage.test.tsx:62`.

Override và SBT chỉ thêm mock `recordAdminAuditLog` resolve thành công; không assert payload, IP, actionId, per-vote exact-once, hay audit failure sau state mutation. Feedback test chỉ kiểm tra một compensation call, không kiểm tra rollback thất bại/interleaving. Vì thế S1/S2 không bị phát hiện dù toàn bộ targeted suite pass.

FE chỉ có bốn test; thiếu các acceptance case của E8i: next/previous paging, date + admin filter reset page, sensitive badge, empty state, retry, API 401/403 giữa phiên và page URL lớn hơn `totalPages`. Không có route integration test cho `POST /api/feedback/:feedbackId/:action` để kiểm tra auth, fresh-admin role, body reason 10–1000, 409 no-op và response envelope.

**Cần bổ sung trước merge:**

- Integration test với Mongo replica set cho transaction/state-audit atomicity ở override, manual, SBT và feedback.
- Test audit write thất bại, queue resolve thất bại sau audit success, outbox dispatch thất bại/retry, và duplicate actionId.
- Supertest cho feedback moderation route và audit list error/empty contracts.
- FE test cho tất cả filter/pagination/sensitive/error flows nêu trên.

## 3 · Performance & operations

**Verdict: needs changes** — 1 important · 1 nit

### Important P1 — Migration nạp toàn bộ audit collection vào RAM

**Vị trí:** `BE/src/scripts/migrateAdminAuditLogSchema.ts:39`.

`find({}).toArray()` tải mọi historical audit record trước khi xử lý. Đây là collection có retention năm năm; một migration production có thể tiêu tốn RAM không giới hạn, bị OOM hoặc làm process không thể hoàn tất/retry. Điều này còn làm checksum/reconciliation không đáng tin cậy nếu migration dừng giữa chừng.

**Cần sửa:** dùng cursor có projection, `batchSize`, sort xác định theo immutable key; xử lý/báo cáo theo batch và checkpoint/resume key. Checksum nên được cập nhật streaming theo thứ tự ổn định, không hash một mảng phụ thuộc natural order.

### Nit P2 — Archive che mất nguyên nhân lỗi của từng record

**Vị trí:** `BE/src/services/adminAuditArchive.service.ts:103`; `BE/src/workers/adminAuditArchiveWorker.ts:44`.

`archiveOneAuditRecord()` nuốt mọi exception và chỉ trả `failed`; worker sau đó chỉ log aggregate counter. Khi checksum/PUT lỗi, vận hành không biết action ID, locator hay error class nào để xử lý backlog, trái yêu cầu observability của E8j.

**Cần sửa:** log structured, đã sanitize, cho mỗi failure (actionId/locator/error category, không payload/token); thêm metric/alert threshold cho `failed` và age của `HOT` backlog.

## 4 · Architecture, logic & maintainability

**Verdict: re-think before merging** — 2 important

### Important A1 — Manual review có thể lưu audit “thành công” cho action đã bị rollback

**Vị trí:** `BE/src/services/manualReviewService.ts:457`, `BE/src/services/manualReviewService.ts:466`, `BE/src/services/manualReviewService.ts:480`.

`MANUAL_APPROVE`/`MANUAL_REJECT` được ghi trước `resolveQueueAfterAction()`. Nếu queue resolve lỗi (lease race/database error), catch khôi phục disbursement state nhưng audit immutable đã commit vẫn mô tả một manual decision không hề hoàn tất. Retry tạo actionId ngẫu nhiên mới ở `:1116`, nên historical trail tiếp tục chứa false-positive record.

**Cần sửa:** thay sequencing bù trừ bằng một transaction chứa disbursement/queue/audit; actionId phải gắn với action lease hoặc outbox event đã commit. Audit chỉ được record khi outcome business cuối cùng là committed.

### Important A2 — Pagination count và items không cùng tập predicate đối với legacy unresolved record

**Vị trí:** `BE/src/services/audit-log.service.ts:247`, `BE/src/services/audit-log.service.ts:274`, `BE/src/services/audit-log.service.ts:310`; `BE/src/scripts/migrateAdminAuditLogSchema.ts:59`.

Query list chọn mọi legacy document có `action` canonical, sau đó `normalizeAuditRecord()` có thể loại bỏ document thiếu `auditId` hoặc `targetRequestId`. `countDocuments()` được thực hiện trước normalize, nên API có thể trả `total > 0`, `totalPages` sai và page rỗng. Migration đã chủ đích giữ record `unresolved`, nhưng query không có discriminator/field-existence guard để loại chúng từ đầu.

**Cần sửa:** chỉ query canonical record hoàn chỉnh và legacy đã backfill thành công (ví dụ `actionId`, `targetId`, `targetType` đều tồn tại, hoặc một `migrationState=CANONICAL` rõ ràng). Dùng đúng cùng predicate cho find và count; thêm regression test của legacy unresolved + webhook.

## Điểm đã xác nhận

- `GET /api/audit-logs` có JWT, fresh admin role và rate limit: `BE/src/routes/audit-log.routes.ts:10`.
- Date-only filter được quy đổi theo `+07:00`, UI format `Asia/Ho_Chi_Minh`: `BE/src/services/audit-log.service.ts:299`; `FE/app/components/adminAuditLogs/AuditLogTable.tsx:83`.
- Context được allowlist và redact thêm ở UI; raw bank/token không được render theo test hiện có.
- Webhook writer mới dùng `webhook_audit_logs`, tách khỏi canonical admin audit collection: `BE/src/models/webhookAuditLogModel.ts:47`.
- Archive predicate dùng `createdAt < cutoff`, không dùng Mongo TTL/delete: `BE/src/services/adminAuditArchive.service.ts:41`.

## Thứ tự xử lý khuyến nghị

1. Đóng S1, S2 và A1 bằng transaction/outbox; không dùng compensation như cơ chế compliance chính.
2. Chỉnh A2 để canonical query/count không lẫn legacy unresolved; chạy migration theo batch an toàn (P1).
3. Fail-close archive configuration và bổ sung observability.
4. Bổ sung test integration/route/FE cho toàn bộ failure/race/edge case ở T1, rồi chạy lại targeted BE + FE suite và typecheck.

**Verdict: reject**

---

## Bổ sung — re-review sau khi đã fix, ngày 2026-08-13

Phần này cập nhật trạng thái working tree E8a–E8j hiện tại và không thay thế biên bản ngày 2026-08-12. Các finding về transaction feedback/manual request, archive drain, migration cursor/projection/DTO, canonical list/count predicate, FE deep-link pagination và route/integration coverage đã được xử lý. Còn lại các lỗi liên quan đến final resolution và idempotency của hậu-commit queue.

| Hạng mục | Kết quả |
|---|---|
| Kiểm chứng đã chạy | BE: 12 file / 102 test pass; FE: 1 file / 7 test pass; build và `tsc --noEmit` pass ở BE và FE; `git diff --check` pass. |
| Phạm vi | Override voting, manual review, SBT rerun outbox, archive adapter, audit API và FE audit page. |
| Finding còn mở | **2 blocker · 2 important** |
| Verdict re-review | **reject** — chưa bảo đảm canonical final resolution và outbox dispatch/audit idempotent trong failure path. |

### Blocker S5 — Override final resolution vẫn nằm ngoài transaction và có thể ghi outcome sai

**Vị trí:** `BE/src/services/overrideVotingService.ts:173`, `BE/src/services/overrideVotingService.ts:204`, `BE/src/services/overrideVotingService.ts:283`, `BE/src/services/overrideVotingService.ts:309`; `BE/src/models/oracleOverrideRequestModel.ts:247`.

Transaction hiện tại ghi vote và audit của từng vote, nhưng `evaluateVoteOutcome()` mới thực hiện `resolveOverrideRequest()` sau khi transaction kết thúc và không truyền session. Nhánh reject còn trả `RESOLVED_REJECTED` kể cả khi resolve trả về `null`. Vì vậy audit có thể mô tả outcome đã resolved trong khi request vẫn `PENDING` hoặc một outcome khác đã thắng do race; hơn nữa không có canonical audit gắn nguyên tử với final resolution.

**Cần sửa:** đưa quorum resolution, disbursement transition liên quan và canonical final audit vào cùng transaction; hoặc tạo durable outbox cho final resolution với outcome chỉ được ghi khi transition conditional thành công. Không được trả trạng thái `RESOLVED_*` khi `resolveOverrideRequest()` không resolve được.

### Blocker A3 — SBT outbox có thể retry vô hạn sau khi queue đã enqueue nhưng audit commit thất bại

**Vị trí:** `BE/src/workers/adminActionOutboxWorker.ts:31`, `BE/src/workers/adminActionOutboxWorker.ts:88`, `BE/src/workers/adminActionOutboxWorker.ts:102`, `BE/src/sbtMintQueue.ts:127`.

Worker enqueue job trước, sau đó mới transactionally mark outbox `DISPATCHED` và ghi audit `SBT_MINT_RERUN_ENQUEUED`. Nếu audit transaction lỗi sau khi queue đã nhận job, event bị release về `PENDING`. Lần retry dùng cùng Bull `jobId`, bị coi là enqueue thất bại, nên worker không bao giờ hoàn tất audit dù job đã tồn tại. Đây là failure path chưa được test hiện tại.

**Cần sửa:** tách trạng thái “job đã được accept” khỏi retry ghi audit; duplicate deterministic `jobId` phải được coi là enqueue thành công. Sau khi dispatch thành công, worker phải retry idempotently phần mark/audit mà không enqueue lại job. Bổ sung test queue success → audit failure → retry và xác nhận chỉ có một job cùng outcome audit cuối cùng.

### Important A5 — Manual approve chưa idempotent ở Bull boundary, có thể tạo duplicate transfer job

**Vị trí:** `BE/src/workers/adminActionOutboxWorker.ts:75`, `BE/src/queues/disbursementTransferQueue.ts:125`, `BE/src/workers/payosTransferWorker.ts:431`.

`MANUAL_APPROVE_TRANSFER` gọi `queue.add()` không truyền `jobId` ổn định. Nếu queue enqueue thành công nhưng transaction mark/audit lỗi, outbox retry sẽ tạo job Bull mới. Điều kiện claim trong transfer worker chưa cung cấp single-flight đủ chặt cho hai job cùng idempotency key, nên có thể phát sinh hai lần xử lý/provider attempt; việc PayOS có deduplicate hay không không thay thế được bảo vệ ở application boundary.

**Cần sửa:** dùng `jobId` deterministic theo `outboxEventId` hoặc idempotency key, coi duplicate job là enqueue success, và thêm atomic claim/guard trong worker trước khi thực hiện side effect tài chính.

### Important S3 — Archive đã fail-closed với credential thiếu nhưng vẫn thiếu HTTPS bắt buộc và host allowlist

**Vị trí:** `BE/src/services/adminAuditArchive.service.ts:204`, `BE/src/services/adminAuditArchive.service.ts:210`, `BE/src/services/adminAuditArchive.service.ts:262`, `BE/src/services/adminAuditArchive.service.ts:270`; `BE/.env.example:36`.

Adapter hiện gửi bearer token tới bất kỳ endpoint nào được cấu hình; HTTPS chỉ bị bắt buộc khi `NODE_ENV=production`. Ở staging hoặc do cấu hình sai, audit payload và credential có thể đi tới host không được phê duyệt hoặc qua HTTP. Việc bắt buộc endpoint/token đã đóng finding thiếu credential cũ, nhưng chưa đáp ứng đầy đủ yêu cầu private archive.

**Cần sửa:** validate exact host allowlist và bắt buộc `https:` ở mọi môi trường có secret; chỉ cho HTTP trong local mode không dùng credential. Thêm test reject endpoint không allowlist, reject HTTP và không gửi bearer khi cấu hình không hợp lệ.

### Kiểm chứng cần bổ sung để đóng các finding còn lại

- Test `recordAdminAuditLog()` thất bại sau khi SBT job đã enqueue; retry phải ghi được `ENQUEUED` mà không tạo job thứ hai.
- Test override resolve thất bại/race, bảo đảm không trả `RESOLVED_*` và không có final audit sai.
- Test manual approve outbox retry, kiểm tra deterministic Bull `jobId` và single-flight claim.
- Test archive HTTPS/allowlist với endpoint hợp lệ, HTTP và host không được phê duyệt.

**Verdict re-review: reject**

---

## Bổ sung — verification sau fix authorization, ngày 2026-08-13

Finding về JWT stale trên endpoint commissioner vote đã được đóng. Route vote hiện dùng `createFreshRoleAuthorizationMiddleware(['admin', 'regulatory'])`; các route đọc khác giữ nguyên policy hiện hữu.

| Hạng mục | Kết quả |
|---|---|
| Code fix | `BE/src/routes/oracleRoutes.ts:4`, `BE/src/routes/oracleRoutes.ts:34`, `BE/src/routes/oracleRoutes.ts:108` dùng fresh-role authorization cho vote override. |
| Regression test | `BE/src/__tests__/routes/oracleRoutes.test.ts`: commissioner hợp lệ được phép; JWT stale bị `401`; commissioner đã bị demote bị `403`; controller không bị gọi ở hai failure path. |
| Kiểm chứng | Oracle route: 17 tests; authorization middleware: 4 tests; override service: 18 tests; tổng 39 tests pass; BE build pass; `git diff --check` pass. |
| Finding còn mở trong Security scope | **0 blocker · 0 important · 0 nit** |
| Verdict Security re-review | **Safe to merge** |

### Đã đóng finding — Fresh authorization cho override vote

**Vị trí fix:** `BE/src/routes/oracleRoutes.ts:4`, `BE/src/routes/oracleRoutes.ts:34`, `BE/src/routes/oracleRoutes.ts:108`.

JWT chỉ còn được dùng để xác định danh tính ban đầu; trước khi controller vote chạy, middleware đọc lại user hiện tại, kiểm tra `accountStatus`, `authVersion` và role hiện tại. Regression test xác nhận token stale bị chặn `401`, user đã bị demote bị chặn `403`, và không đi vào controller.

**Verdict Security re-review: Safe to merge**
