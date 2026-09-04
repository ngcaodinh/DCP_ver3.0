# JMeter 20.000 request - minh chứng tải DCP

## Mục tiêu

Kịch bản này tạo 20.000 request an toàn vào endpoint `GET /health` của backend DCP. Kịch bản không gọi PayOS production và không tạo giao dịch tiền thật.

Mặc định:

- Users: `200`
- Loops mỗi user: `100`
- Tổng samples: `200 * 100 = 20.000`
- Ramp-up: `120` giây
- Endpoint: `http://localhost:4000/health`

## Bước 1: chạy backend

Từ thư mục `BE`:

```powershell
npm run dev
```

Mở thử trình duyệt:

```text
http://localhost:4000/health
```

Nếu trả JSON/status 200 là được.

## Bước 2: cài JMeter

Tải JMeter từ trang chính thức:

```text
https://jmeter.apache.org/download_jmeter.cgi
```

Giải nén ví dụ vào:

```text
D:\tools\apache-jmeter
```

Kiểm tra file tồn tại:

```text
D:\tools\apache-jmeter\bin\jmeter.bat
```

## Bước 3: chạy test 20.000 request

Từ repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\docs\jmeter\run-20000-health-test.ps1
```

Nếu JMeter nằm chỗ khác:

```powershell
powershell -ExecutionPolicy Bypass -File .\docs\jmeter\run-20000-health-test.ps1 -JMeterBin "C:\path\to\apache-jmeter\bin\jmeter.bat"
```

Nếu backend chạy port khác:

```powershell
powershell -ExecutionPolicy Bypass -File .\docs\jmeter\run-20000-health-test.ps1 -Port 3001
```

## Bước 4: chụp ảnh minh chứng dễ nhất

Sau khi chạy xong, script tự mở file:

```text
docs\jmeter\results-YYYYMMDD-HHMMSS\html-report\index.html
```

Chụp 2 ảnh:

1. Trang `Dashboard` của JMeter HTML report, thấy rõ:
   - Total requests/samples gần hoặc bằng `20000`
   - Error %
   - Throughput
   - Average/Median/90th/95th/99th percentile
2. Màn hình terminal sau khi chạy, thấy dòng:
   - `DONE: 20000 requests`
   - đường dẫn `result.jtl`
   - đường dẫn `html-report\index.html`

Cách chụp nhanh trên Windows:

```text
Win + Shift + S
```

Chọn vùng màn hình report và lưu ảnh.

## Bước 5: test webhook PayOS nội bộ

Không chạy 20.000 request vào PayOS production. Nếu muốn test webhook nội bộ, cần tạm cấu hình staging để tránh rate limit `20 request/phút` ở route `/api/deposit/webhook`, hoặc tạo endpoint test riêng chỉ dùng trong staging.

Ví dụ chạy cùng test plan nhưng đổi path sang webhook health:

```powershell
powershell -ExecutionPolicy Bypass -File .\docs\jmeter\run-20000-health-test.ps1 -Path "/api/deposit/webhook"
```

Lưu ý: route `/api/deposit/webhook` hiện có rate limit, nên kết quả có thể nhiều lỗi `429` nếu chưa cấu hình staging.
## Test donation 20.000 request

Kịch bản `dcp-20000-donation-perf.jmx` gửi 20.000 request donation thành công (200 users × 100 loops), mỗi request 100 token, tổng kỳ vọng 2.000.000 token. Chạy trên perf database cô lập:

~~~
$env:NODE_ENV = "performance"
$env:SYNTHETIC_DONATION_EXECUTION = "true"
$env:SYNTHETIC_DONATION_ACK = "I_UNDERSTAND_SYNTHETIC_DONATIONS"
npm run dev
Copy-Item .\docs\jmeter\dcp-20000-donation-perf.local.properties.example .\docs\jmeter\dcp-20000-donation-perf.local.properties
powershell -ExecutionPolicy Bypass -File .\docs\jmeter\run-20000-donation-perf.ps1
~~~

Synthetic mode chỉ ghi bản ghi `INDEXED` giả lập vào MongoDB; không gọi ZeroDev/RPC/private key/PayOS. Production vẫn giữ rate limit 100 request/phút.

### Full system KYC → ngân hàng → 20.000 donation request → giải ngân

Để có một báo cáo JMeter gộp chung, dùng `dcp-full-system-20000-donation.jmx`. Plan chạy bootstrap KYC/bank/project ACTIVE, lấy JWT donor synthetic, gửi 20.000 request `POST /donations/one-click` (200 users × 100 loops), rồi gọi finalize committee/disbursement. Các sampler nằm trong cùng một report và finalize chỉ thành công khi đủ đúng số donation.

Backend cần bật thêm `SYNTHETIC_E2E_EXECUTION=true`, `SYNTHETIC_E2E_ACK=I_UNDERSTAND_SYNTHETIC_E2E`, `SYNTHETIC_E2E_TOKEN` và `SYNTHETIC_DONATION_EXECUTION=true`, `SYNTHETIC_DONATION_ACK=I_UNDERSTAND_SYNTHETIC_DONATIONS` trên database sandbox. Chạy:

~~~powershell
Copy-Item .\docs\jmeter\full-system-20000-donation.local.properties.example .\docs\jmeter\full-system-20000-donation.local.properties
# Sửa synthetic_token cho trùng SYNTHETIC_E2E_TOKEN.
powershell -ExecutionPolicy Bypass -File .\docs\jmeter\run-full-system-20000-donation.ps1
~~~

Không dùng key thật: bootstrap/finalize chỉ ghi MongoDB synthetic; donation request đi qua route thật nhưng nhánh synthetic không gọi blockchain/PayOS. Kết quả tổng thời gian từ bootstrap bắt đầu đến disbursement hoàn tất nằm trong response finalize (`totalDurationMs`) và JMeter HTML/JTL.

## Đo KYC đến giải ngân

`dcp-kyc-to-disbursement-e2e.jmx` chạy một luồng thật KYC → tài khoản ngân hàng → dự án → geofence → duyệt/kích hoạt → donation → 3 phiếu Ủy ban → PayOS. Copy file `kyc-to-disbursement-e2e.local.properties.example` thành file `.local.properties` (đã gitignore) và điền access token sandbox. `organization_access_token` phải được cấp lại sau KYC approve vì backend vô hiệu hóa session cũ khi đổi role.

Đặt private key test của chair/member bằng environment rồi chạy:

~~~
$env:JMeter_COMMITTEE_CHAIR_PRIVATE_KEY = "0x..."
$env:JMeter_COMMITTEE_MEMBER1_PRIVATE_KEY = "0x..."
$env:JMeter_COMMITTEE_MEMBER2_PRIVATE_KEY = "0x..."
powershell -ExecutionPolicy Bypass -File .\docs\jmeter\run-kyc-to-disbursement-e2e.ps1
~~~

Kịch bản ghi `DCP_E2E_MS=...` vào `jmeter.log` và sampler cuối. Backend sandbox cần bật `RUN_WORKERS=true` và `ENABLE_DISBURSEMENT_ONCHAIN_SIGNER_WORKER=true`, có `PINATA_JWT`, `BLOCKCHAIN_RPC_URL`, `MULTISIG_DISBURSEMENT_ADDRESS`, cùng ba key kỹ thuật `DISBURSEMENT_SERVICE_SIGNER_ADMIN_KEY`, `DISBURSEMENT_SERVICE_SIGNER_ORG_KEY`, `DISBURSEMENT_SERVICE_SIGNER_REGULATORY_KEY`. Để chạy thêm relayer quyết định on-chain, bật `ENABLE_COMMITTEE_DECISION_RELAYER_WORKER=true` và cấu hình `COMMITTEE_GOVERNANCE_ADDRESS`, `COMMITTEE_GOVERNANCE_DEPLOYMENT_BLOCK`, `COMMITTEE_GOVERNANCE_RELAYER_PRIVATE_KEY`; nếu không, giữ cờ relayer tắt trong sandbox để signer xử lý trực tiếp sau 3 phiếu hợp lệ. Đặt `PROJECT_CHALLENGE_WINDOW_HOURS=0.017` để worker kích hoạt dự án trong thời gian test (giá trị production không nên rút ngắn). Worker activation chạy theo chu kỳ 10 phút; JMX chờ tối đa 30 phút. Donation thật của ca E2E mặc định là 20.000 token; giải ngân mặc định 10.000 token để còn dưới mức withdrawable sau reserve.

### Synthetic KYC → giải ngân (không cần key thật)

Nếu chỉ cần đo thời gian full flow mà không gọi blockchain, Pinata hoặc PayOS, dùng plan `dcp-kyc-to-disbursement-synthetic.jmx`. Backend phải chạy trên database sandbox với `NODE_ENV=performance`, `SYNTHETIC_E2E_EXECUTION=true`, `SYNTHETIC_E2E_ACK=I_UNDERSTAND_SYNTHETIC_E2E` và `SYNTHETIC_E2E_TOKEN` là token ngẫu nhiên chỉ dành cho ca test. Luồng mặc định donation `20.000`, disbursement `10.000` và trả về thời gian tổng `totalDurationMs` cùng thời gian từng stage.

~~~powershell
$env:NODE_ENV = "performance"
$env:SYNTHETIC_E2E_EXECUTION = "true"
$env:SYNTHETIC_E2E_ACK = "I_UNDERSTAND_SYNTHETIC_E2E"
$env:SYNTHETIC_E2E_TOKEN = "<random-test-token>"
Copy-Item .\docs\jmeter\kyc-to-disbursement-synthetic.local.properties.example .\docs\jmeter\kyc-to-disbursement-synthetic.local.properties
# Sửa synthetic_token trong file local cho trùng SYNTHETIC_E2E_TOKEN.
powershell -ExecutionPolicy Bypass -File .\docs\jmeter\run-kyc-to-disbursement-synthetic.ps1
~~~
