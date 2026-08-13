# DCP Backend — ELK integration

E6 ghi structured JSON log ra file local. Ứng dụng không mở socket tới
Elasticsearch hoặc Logstash; Filebeat chịu trách nhiệm đọc file và chuyển tiếp
log. Vì vậy Logstash/Elasticsearch tạm thời không sẵn sàng không làm mất bản ghi
đã ghi trên đĩa và không tạo backpressure mới trong application.

## Filebeat

```yaml
filebeat.inputs:
  - type: filestream
    id: dcp-backend-logs
    enabled: true
    paths:
      - /var/www/dcp/BE/logs/dcp-*.log
    parsers:
      - ndjson:
          target: ""
          overwrite_keys: true
          add_error_key: true
    # File .gz chỉ dùng lưu trữ; Filebeat đã đọc nội dung trước khi rotate.
    exclude_files: ['\.gz$']

processors:
  - drop_fields:
      fields: ["agent", "ecs", "input", "log.offset"]
      ignore_missing: true

output.logstash:
  hosts: ["logstash.internal:5044"]
```

`requestId` và `userId` nên là `keyword` để filter/aggregate chính xác trong
điều tra sự cố. Với background execution, `requestId` là correlation ID của
worker run; dùng thêm `workerName`, `workerRunId` và `jobId` (nếu có) để pivot
toàn bộ record thuộc cùng một lần chạy.

## Elasticsearch index template

```json
{
  "index_patterns": ["dcp-backend-*"],
  "template": {
    "mappings": {
      "properties": {
        "@timestamp": { "type": "date" },
        "level": { "type": "keyword" },
        "message": { "type": "text" },
        "requestId": { "type": "keyword" },
        "userId": { "type": "keyword" },
        "workerName": { "type": "keyword" },
        "workerRunId": { "type": "keyword" },
        "jobId": { "type": "keyword" },
        "service": { "type": "keyword" },
        "env": { "type": "keyword" },
        "hostname": { "type": "keyword" },
        "meta": { "type": "object", "dynamic": true }
      }
    }
  }
}
```

## Vận hành

- Log file dùng UTC cho cả timestamp và tên file rotate.
- Tất cả file transport (combined, error, exception và rejection) rotate mỗi ngày,
  nén file cũ và giới hạn 20 MB/file; combined giữ 14 ngày, các file lỗi giữ 30 ngày.
- `LOG_DRIVER=console` là kill-switch quay về console logger.
- `LOG_LEVEL=error` giảm volume; `LOG_FILE_ENABLED=false` tắt disk I/O.
- Normal log redact một lần tại facade; exception/rejection transport sanitize defense-in-depth trước khi persist vì lifecycle event có thể bypass facade.
- Message legacy cũng được sanitize tại facade trước console/Winston để call-site cũ không ghi raw URL, token, IP, GPS, wallet/transaction hash hoặc free-text reason.
- `reason` từ request body chỉ xuất hiện dưới marker `[REASON_REDACTED]`; lý do đầy đủ nằm ở audit MongoDB, không nằm trong application log.
- Metadata field name biến thể (`snake_case`/`kebab-case`) vẫn đi qua cùng policy; object SDK/class không được serialize nguyên trạng vào log.
- Khi tra worker: lọc `workerName` + `workerRunId`; `jobId` là định danh queue nếu execution có job, không thay thế worker run ID.
- Nested cleanup là một phần của worker run đang gọi nó, nên phải kế thừa `requestId` và `workerRunId` của worker cha thay vì sinh correlation ID mới.
